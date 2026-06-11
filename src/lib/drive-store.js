/**
 * Kanbantt — Drive-backed JSON storage.
 *
 * All user data lives as a single JSON file in Google Drive's `appDataFolder`
 * space. This space is private to the app and invisible in the user's normal
 * Drive UI. Combined with the `drive.file` scope, it means:
 *   - The app can only see files it creates.
 *   - The user can revoke access at any time from Google account settings.
 *   - No backend needed; data syncs across the user's devices via Google.
 *
 * Trade-offs vs. a per-record approach:
 *   + Simpler: one fetch loads the whole app state.
 *   + Atomic: writes are all-or-nothing.
 *   - Doesn't scale past ~5MB of data. For Kanbantt's task list, fine.
 *
 * Write strategy:
 *   - saveAppData() debounces by 800ms; many edits coalesce into one PATCH.
 *   - flush() forces immediate write (call on tab close / visibility change).
 *   - Conflict (412 Precondition Failed) triggers reload + retry. Last write
 *     wins — acceptable for a single-user app across tabs.
 *
 * Usage:
 *   import { loadAppData, saveAppData, flush, installAutoFlush } from './drive-store.js';
 *
 *   const data = await loadAppData();
 *   data.tasks.push(newTask);
 *   saveAppData(data);  // returns immediately; flushes after debounce
 *
 *   installAutoFlush();  // wire up beforeunload + visibilitychange
 */

import { withToken } from './auth.js';
import { CURRENT_SCHEMA, migrate, emptyState } from './schema.js';

const APP_FILENAME = 'kanbantt-data.json';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DEBOUNCE_MS = 800;

let cachedFileId = null;
let cachedEtag = null;
let cachedData = null;
let pendingData = null;
let debounceTimer = null;
let inFlight = null; // Promise of the current write, to chain saves serially.

/* ------------------------------------------------------------------------ */
/* File discovery / creation                                                */
/* ------------------------------------------------------------------------ */

/** Find the app's data file in appDataFolder. Returns file ID or null. */
async function findFile() {
  if (cachedFileId) return cachedFileId;
  const token = await withToken();
  const url = new URL(`${DRIVE_BASE}/files`);
  url.searchParams.set('spaces', 'appDataFolder');
  url.searchParams.set('q', `name = '${APP_FILENAME}' and trashed = false`);
  url.searchParams.set('fields', 'files(id,name)');

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive files.list: ${r.status} ${await r.text()}`);
  const data = await r.json();
  cachedFileId = data.files?.[0]?.id || null;
  return cachedFileId;
}

/** Create the app file with given initial state. Returns new file ID. */
async function createFile(initialData) {
  const token = await withToken();
  const metadata = {
    name: APP_FILENAME,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  };

  // Multipart upload: metadata part + content part.
  const boundary = `kanbantt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(initialData),
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const r = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!r.ok) throw new Error(`Drive create: ${r.status} ${await r.text()}`);
  const data = await r.json();
  cachedFileId = data.id;
  cachedData = initialData;
  return cachedFileId;
}

/* ------------------------------------------------------------------------ */
/* Read                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Load the app state. Creates an empty file on first run.
 * Runs schema migrations if the stored data is from an older version.
 */
export async function loadAppData() {
  if (cachedData) return cachedData;

  const fileId = await findFile();
  if (!fileId) {
    const initial = emptyState();
    await createFile(initial);
    // Fetch etag for future conflict-checked writes.
    await fetchEtag();
    return initial;
  }

  const token = await withToken();
  const r = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) {
    // Token issue despite the buffer in auth.js — retry once after invalidating.
    cachedFileId = null;
    return loadAppData();
  }
  if (!r.ok) throw new Error(`Drive read: ${r.status}`);

  cachedEtag = r.headers.get('etag');
  let data;
  try {
    data = await r.json();
  } catch {
    // Corrupted file — recover with empty state.
    console.warn('App data file unreadable; resetting');
    data = emptyState();
  }

  if (data.schemaVersion !== CURRENT_SCHEMA) {
    data = migrate(data);
    pendingData = data;
    flush(); // Persist migrated state immediately.
  }

  cachedData = data;
  return data;
}

/** Refresh the etag after a create (which doesn't return it directly). */
async function fetchEtag() {
  if (!cachedFileId) return;
  const token = await withToken();
  const r = await fetch(`${DRIVE_BASE}/files/${cachedFileId}?fields=id`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}` },
  });
  cachedEtag = r.headers.get('etag');
}

/* ------------------------------------------------------------------------ */
/* Write                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Queue a save. Debounced; multiple calls within 800ms coalesce into one PATCH.
 * Always assign the most recent state; pendingData replaces, doesn't merge.
 */
export function saveAppData(data) {
  pendingData = data;
  cachedData = data; // Keep cache in sync for subsequent reads in same session.
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => flush(), DEBOUNCE_MS);
}

/**
 * Force immediate write. Returns a promise that resolves when the PATCH succeeds.
 * Call on tab close, route change, or explicit save.
 */
export async function flush() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!pendingData) return;

  // Serialize writes — if one is already in flight, chain after it.
  if (inFlight) {
    await inFlight.catch(() => {});
  }
  inFlight = doWrite(pendingData);
  pendingData = null;
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doWrite(data) {
  const fileId = await findFile();
  if (!fileId) {
    await createFile(data);
    await fetchEtag();
    return;
  }
  const token = await withToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
  };
  if (cachedEtag) headers['If-Match'] = cachedEtag;

  const r = await fetch(`${UPLOAD_BASE}/files/${fileId}?uploadType=media&fields=id`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(data),
  });

  if (r.status === 412) {
    // Another tab wrote; reload and re-apply. Last-write-wins.
    console.warn('Drive conflict (412); reloading and retrying');
    cachedData = null;
    cachedEtag = null;
    await loadAppData();
    pendingData = data;
    return doWrite(data);
  }
  if (r.status === 401) {
    // Token expired mid-request; refresh and retry once.
    cachedEtag = null; // Likely stale anyway.
    return doWrite(data);
  }
  if (!r.ok) throw new Error(`Drive write: ${r.status} ${await r.text()}`);

  cachedEtag = r.headers.get('etag');
}

/* ------------------------------------------------------------------------ */
/* Lifecycle                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Install handlers that flush pending writes when the user leaves or backgrounds
 * the tab. Call once at app boot.
 *
 * Why visibilitychange + pagehide instead of just beforeunload:
 *   beforeunload is increasingly unreliable on mobile. visibilitychange fires
 *   when the user switches apps or locks the phone. pagehide fires on actual
 *   navigation away. Together they catch most cases.
 */
export function installAutoFlush() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', () => flush());
}

/** Reset all cached state. Call on sign-out. */
export function resetStore() {
  if (debounceTimer) clearTimeout(debounceTimer);
  cachedFileId = null;
  cachedEtag = null;
  cachedData = null;
  pendingData = null;
  debounceTimer = null;
  inFlight = null;
}
