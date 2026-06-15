/**
 * Kanbantt — Drive sync transport (Feature 2), wrapping the proven merge core.
 *
 * ALL Drive I/O lives here. The card store stays Drive-agnostic; this module
 * subscribes to it, reads/writes the v1 blob to a single Drive file, and feeds
 * { local, drive, lastSynced } to the pure `resolve()` from sync-merge.js.
 *
 * Invariants (per the Feature 2 spec, "do not revisit"):
 *   - The board is local-first and NEVER blocks on network. Every Drive failure
 *     is caught here and surfaced as a status; it never throws to the caller and
 *     never corrupts local state. The store renders from localStorage regardless.
 *   - No read-back: a write is confirmed by its own HTTP 200 (Drive's returned
 *     metadata), never a second GET — that would loop under concurrent writes.
 *   - Recovery is revision-based (STEP 0 confirmed drive.file can read prior
 *     revisions): a corrupt head is repaired from the newest parseable revision.
 *   - A single mutex serializes ALL Drive I/O: a focus-read is dropped while busy;
 *     a dirty-write is queued (coalesced) and runs when the mutex releases.
 *   - Merge order is store-first: apply the merged blob so the user instantly sees
 *     the resolved state, THEN push, and advance syncedHash ONLY on a 200.
 *   - 401 / 403-rate / 403-quota are three distinct, separately-handled states.
 *
 * Testability: the Drive client and every ambient (storage, clock, scheduler,
 * sign-in predicate, applyBlob) are injectable, so the controller runs in node
 * against a mock Drive client with zero live network. `makeDriveClient()` is the
 * real fetch-based client used by the app wiring.
 */

import { blobHash, resolve } from './sync-merge.js';
import { withToken, isSignedIn as authIsSignedIn } from './auth.js';
import { STORAGE_KEY } from './card-store.js';

/* ======================================================================== */
/* Constants                                                                */
/* ======================================================================== */

// The Drive file shares the localStorage blob's name, so the two are obviously
// the same artifact.
const FILE_NAME = STORAGE_KEY; // 'kanbantt_data_v1'
const MARKER_KEY = 'kanbantt_sync_marker'; // { syncedHash, driveFileId } — NOT the blob
const SAFETY_KEY = 'kanbantt_sync_safety'; // pre-action local snapshot before a destructive collision choice

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

const DEFAULT_DEBOUNCE_MS = 2500;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const MAX_BACKOFF_ATTEMPT = 6;

/** The observable sync states the UI renders. */
export const SyncStatus = {
  SYNCED: 'synced', // idle / in-sync
  SYNCING: 'syncing',
  PAUSED_RECONNECT: 'paused_reconnect', // 401
  PAUSED_RATELIMITED: 'paused_ratelimited', // 403 rate, auto-retrying
  PAUSED_QUOTA: 'paused_quota', // 403 storage full
  COLLISION_PENDING: 'collision_pending',
  ERROR: 'error',
};

/** Raised when find-or-create sees multiple same-named files (split-brain). */
export class DuplicateFilesError extends Error {
  constructor(count) {
    super(`Found ${count} Drive files named "${FILE_NAME}"; resolve the duplicates in Google Drive`);
    this.name = 'DuplicateFilesError';
    this.count = count;
  }
}

/* ======================================================================== */
/* Real Drive client (fetch-based) — used by the app wiring, mocked in tests */
/* ======================================================================== */

/** Turn a non-OK Drive response into an Error carrying { status, reason }. */
async function driveError(r) {
  let message = `Drive HTTP ${r.status}`;
  let reason = '';
  try {
    const body = await r.json();
    message = body?.error?.message || message;
    reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  } catch {
    /* non-JSON error body */
  }
  return Object.assign(new Error(message), { status: r.status, reason });
}

/**
 * The real Drive client. Each method returns plain data (or throws an Error with
 * `.status`/`.reason`); the controller is agnostic to fetch. `read`/`readRevision`
 * return raw text — the controller owns parsing (and its try/catch recovery).
 */
export function makeDriveClient({ token = withToken, fetchFn = (...a) => fetch(...a) } = {}) {
  const authHeader = async () => ({ Authorization: `Bearer ${await token()}` });

  return {
    async listByName(name) {
      const url = new URL(`${DRIVE_BASE}/files`);
      url.searchParams.set('q', `name='${name}' and trashed=false`);
      url.searchParams.set('fields', 'files(id,name)');
      url.searchParams.set('spaces', 'drive');
      const r = await fetchFn(url.toString(), { headers: await authHeader() });
      if (!r.ok) throw await driveError(r);
      return (await r.json()).files || [];
    },

    async create(name, content) {
      const boundary = `kanbantt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name, mimeType: 'application/json' }),
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        content,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      const r = await fetchFn(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,headRevisionId`, {
        method: 'POST',
        headers: { ...(await authHeader()), 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      });
      if (!r.ok) throw await driveError(r);
      return r.json(); // { id, headRevisionId }
    },

    async read(fileId) {
      const r = await fetchFn(`${DRIVE_BASE}/files/${fileId}?alt=media`, { headers: await authHeader() });
      if (!r.ok) throw await driveError(r);
      return { text: await r.text() };
    },

    // Write confirmation is this 200 + returned metadata. No read-back GET.
    async update(fileId, content, { keepalive = false } = {}) {
      const r = await fetchFn(`${UPLOAD_BASE}/files/${fileId}?uploadType=media&fields=id,headRevisionId`, {
        method: 'PATCH',
        headers: { ...(await authHeader()), 'Content-Type': 'application/json; charset=UTF-8' },
        body: content,
        keepalive,
      });
      if (!r.ok) throw await driveError(r);
      return r.json(); // { id, headRevisionId }
    },

    async listRevisions(fileId) {
      const r = await fetchFn(`${DRIVE_BASE}/files/${fileId}/revisions?fields=revisions(id,modifiedTime)`, {
        headers: await authHeader(),
      });
      if (!r.ok) throw await driveError(r);
      return (await r.json()).revisions || []; // Drive returns oldest -> newest
    },

    async readRevision(fileId, revisionId) {
      const r = await fetchFn(`${DRIVE_BASE}/files/${fileId}/revisions/${revisionId}?alt=media`, {
        headers: await authHeader(),
      });
      if (!r.ok) throw await driveError(r);
      return { text: await r.text() };
    },
  };
}

/* ======================================================================== */
/* Small helpers                                                            */
/* ======================================================================== */

const parseOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Same structural test resolve() uses internally: an object with a cards array.
const isBlobShape = (b) => b != null && typeof b === 'object' && Array.isArray(b.cards);

const lc = (s) => (s || '').toString().toLowerCase();
// Drive 403 reasons: storage full vs. rate limiting. Distinguish — they are
// different states with different handling (suspend vs. auto-retry).
const isQuotaReason = (reason) => lc(reason).includes('storagequota') || lc(reason).includes('quotaexceeded');

/* ======================================================================== */
/* The sync controller                                                      */
/* ======================================================================== */

/**
 * Create a Drive-sync controller bound to a store + Drive client.
 *
 * @param {object}   deps
 * @param {object}   deps.store        { getSnapshot(), subscribe(fn) } — the card store
 * @param {(blob)=>void} deps.applyBlob apply an external blob to the store (reactive)
 * @param {object}   [deps.drive]      Drive client (defaults to the real fetch client)
 * @param {Storage}  [deps.storage]    localStorage-like for the sync marker (NOT the blob)
 * @param {()=>boolean} [deps.isSignedIn]
 * @param {(fn,ms)=>any} [deps.schedule] / [deps.cancel]  timer injection (debounce/backoff)
 * @param {number}   [deps.debounceMs]
 */
export function createDriveSync({
  store,
  applyBlob,
  drive,
  storage = (typeof localStorage !== 'undefined' ? localStorage : undefined),
  isSignedIn = authIsSignedIn,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  debounceMs = DEFAULT_DEBOUNCE_MS,
} = {}) {
  if (!store) throw new Error('createDriveSync requires a store');
  if (typeof applyBlob !== 'function') throw new Error('createDriveSync requires an applyBlob(blob) fn');
  const driveClient = drive || makeDriveClient();

  /* ---- status (observable) -------------------------------------------- */
  let status = SyncStatus.SYNCED;
  let statusReason = '';
  const statusListeners = new Set();
  function setStatus(s, reason = '') {
    status = s;
    statusReason = reason;
    for (const fn of statusListeners) fn({ status, reason });
  }
  const getStatus = () => ({ status, reason: statusReason });
  function subscribeStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
  }

  /* ---- marker (persisted, NOT in the blob) ---------------------------- */
  function getMarker() {
    try {
      return JSON.parse(storage.getItem(MARKER_KEY)) || {};
    } catch {
      return {};
    }
  }
  function setMarker(patch) {
    const next = { ...getMarker(), ...patch };
    storage.setItem(MARKER_KEY, JSON.stringify(next));
  }
  function clearMarker() {
    try {
      storage.removeItem(MARKER_KEY);
    } catch {
      /* ignore */
    }
  }

  /* ---- internal lifecycle state --------------------------------------- */
  let unsub = null;
  let disabled = false; // set by collision -> disconnect
  let collisionPending = null; // { fileId, driveBlob } while awaiting the user's choice
  let busy = false; // mutex: a Drive op is in flight
  let queuedWrite = false; // a dirty-write deferred until the mutex releases
  let debounceHandle = null;
  let backoffHandle = null;
  let backoffAttempt = 0;

  /* ---- mutex ----------------------------------------------------------- */
  // Single-threaded: `busy` is set/checked synchronously before any await, so no
  // two ops interleave. Reads drop when busy; writes coalesce into queuedWrite.
  // `pending` tracks every launched op (incl. cascaded queued writes) so callers
  // and tests can await full quiescence via whenIdle().
  const pending = new Set();
  async function acquire(fn) {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
      if (queuedWrite && !disabled && !collisionPending) {
        queuedWrite = false;
        launch(() => doWrite());
      }
    }
  }
  function launch(fn) {
    const p = acquire(fn);
    pending.add(p);
    p.then(() => pending.delete(p), () => pending.delete(p));
    return p;
  }
  async function whenIdle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  /* ---- find-or-create -------------------------------------------------- */
  async function ensureFileId() {
    const m = getMarker();
    if (m.driveFileId) return { id: m.driveFileId, created: false };

    const files = await driveClient.listByName(FILE_NAME);
    if (files.length > 1) throw new DuplicateFilesError(files.length);
    if (files.length === 1) {
      setMarker({ driveFileId: files[0].id });
      return { id: files[0].id, created: false };
    }
    // Zero files: create, seeding with the current local blob (an implicit push).
    const local = store.getSnapshot();
    const res = await driveClient.create(FILE_NAME, JSON.stringify(local));
    setMarker({ driveFileId: res.id, syncedHash: blobHash(local) });
    return { id: res.id, created: true };
  }

  /* ---- read + reconcile ------------------------------------------------ */
  async function doRead() {
    try {
      setStatus(SyncStatus.SYNCING);
      const { id: fileId, created } = await ensureFileId();
      if (created) {
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED); // just created from local — no read-back
        return;
      }
      const { text } = await driveClient.read(fileId);
      const driveBlob = parseOrNull(text);
      if (!isBlobShape(driveBlob)) {
        // Corrupt / non-blob head -> revision recovery (never adopt garbage).
        await recoverFromRevisions(fileId);
        return;
      }
      const local = store.getSnapshot();
      const decision = resolve({ local, drive: driveBlob, lastSynced: getMarker().syncedHash });
      await applyResolution(decision, fileId, local, driveBlob);
    } catch (e) {
      handleError(e);
    }
  }

  async function applyResolution(decision, fileId, local, driveBlob) {
    switch (decision.action) {
      case 'in_sync': {
        const h = blobHash(local); // === blobHash(driveBlob)
        if (getMarker().syncedHash !== h) setMarker({ syncedHash: h }); // fast-forward stale marker
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED);
        break;
      }
      case 'adopt_drive': {
        applyBlob(driveBlob);
        setMarker({ syncedHash: blobHash(driveBlob) });
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED);
        break;
      }
      case 'push_local': {
        await driveClient.update(fileId, JSON.stringify(local));
        setMarker({ syncedHash: blobHash(local) }); // only reached on 200
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED);
        break;
      }
      case 'merge': {
        // Strict order: (b) store first so the user sees the resolved state, then
        // (c) push, then (d) advance syncedHash ONLY on a 200. If the push fails,
        // local holds the merge and localHash !== syncedHash, so the next read's
        // resolve() reads it as push_local and recovers cleanly.
        applyBlob(decision.blob);
        const mergedHash = blobHash(decision.blob);
        await driveClient.update(fileId, JSON.stringify(decision.blob));
        setMarker({ syncedHash: mergedHash });
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED);
        break;
      }
      case 'collision': {
        // Unrelated histories — never auto-merge. Halt and await the user choice.
        collisionPending = { fileId, driveBlob };
        setStatus(SyncStatus.COLLISION_PENDING);
        break;
      }
      case 'recover': {
        await recoverFromRevisions(fileId);
        break;
      }
      default:
        break;
    }
  }

  /* ---- revision-based recovery ---------------------------------------- */
  async function recoverFromRevisions(fileId) {
    const revisions = await driveClient.listRevisions(fileId); // oldest -> newest
    // Try every revision below the (corrupt) head, newest first.
    const priors = revisions.slice(0, -1).reverse();
    for (const rev of priors) {
      let text;
      try {
        ({ text } = await driveClient.readRevision(fileId, rev.id));
      } catch {
        continue; // unreadable revision — try the next
      }
      const blob = parseOrNull(text);
      if (isBlobShape(blob)) {
        applyBlob(blob); // adopt the recovered state locally
        await driveClient.update(fileId, JSON.stringify(blob)); // overwrite the corrupt head
        setMarker({ syncedHash: blobHash(blob) });
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED);
        return;
      }
    }
    // Nothing parseable to recover from — surface, never adopt garbage.
    setStatus(SyncStatus.ERROR, 'no valid Drive revision to recover from');
  }

  /* ---- write (coalesced) ---------------------------------------------- */
  async function doWrite({ keepalive = false } = {}) {
    try {
      const local = store.getSnapshot();
      const h = blobHash(local);
      if (h === getMarker().syncedHash) {
        setStatus(SyncStatus.SYNCED); // nothing changed since last confirmed sync
        return;
      }
      setStatus(SyncStatus.SYNCING);
      const { id: fileId, created } = await ensureFileId();
      if (created) {
        backoffAttempt = 0;
        setStatus(SyncStatus.SYNCED); // create already uploaded local; no extra PATCH
        return;
      }
      await driveClient.update(fileId, JSON.stringify(local), { keepalive });
      setMarker({ syncedHash: h }); // confirmed by the 200; no read-back
      backoffAttempt = 0;
      setStatus(SyncStatus.SYNCED);
    } catch (e) {
      handleError(e);
    }
  }

  /* ---- error taxonomy -------------------------------------------------- */
  function handleError(e) {
    if (e instanceof DuplicateFilesError) {
      setStatus(SyncStatus.ERROR, e.message); // halt; user resolves duplicates
      return;
    }
    const code = e?.status;
    const reason = e?.reason;
    if (code === 401) {
      // Suspend writes; a failed silent token re-acquire lands here, visibly.
      setStatus(SyncStatus.PAUSED_RECONNECT, 'reconnect to Google to resume sync');
      return;
    }
    if (code === 403 && isQuotaReason(reason)) {
      setStatus(SyncStatus.PAUSED_QUOTA, 'Google Drive is full'); // no false reconnect hint
      return;
    }
    if (code === 403) {
      setStatus(SyncStatus.PAUSED_RATELIMITED, 'rate limited; retrying'); // no prompt
      scheduleBackoff();
      return;
    }
    // network / 5xx / unknown — transient: back off and retry in the background.
    setStatus(SyncStatus.ERROR, e?.message || 'sync error');
    scheduleBackoff();
  }

  function scheduleBackoff() {
    if (disabled) return;
    backoffAttempt = Math.min(backoffAttempt + 1, MAX_BACKOFF_ATTEMPT);
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (backoffAttempt - 1), MAX_BACKOFF_MS);
    if (backoffHandle) cancel(backoffHandle);
    backoffHandle = schedule(() => {
      backoffHandle = null;
      triggerRead(); // re-reconcile when the transient clears
    }, delay);
  }

  /* ---- public triggers ------------------------------------------------- */
  // READ: app load, window focus, manual sync. Dropped if a Drive op is in flight.
  function triggerRead() {
    if (disabled || collisionPending) return;
    if (!isSignedIn()) return;
    if (busy) return; // mutex busy -> drop the read
    return launch(() => doRead());
  }

  // WRITE: marked dirty by a store mutation; debounced; coalesced under the mutex.
  function requestWrite() {
    if (disabled || collisionPending) return;
    if (!isSignedIn()) return;
    if (busy) {
      queuedWrite = true; // run when the in-flight op releases the mutex
      return;
    }
    return launch(() => doWrite());
  }

  function markDirty() {
    if (disabled || collisionPending || !isSignedIn()) return;
    if (debounceHandle) cancel(debounceHandle);
    debounceHandle = schedule(() => {
      debounceHandle = null;
      requestWrite();
    }, debounceMs);
  }

  /* ---- collision resolution ------------------------------------------- */
  async function resolveCollision(choice) {
    if (!collisionPending) return;
    const { fileId, driveBlob } = collisionPending;
    // Retain the pre-action local blob as a safety copy BEFORE any destructive op.
    try {
      storage.setItem(SAFETY_KEY, JSON.stringify(store.getSnapshot()));
    } catch {
      /* best-effort safety copy */
    }
    try {
      if (choice === 'adopt_drive') {
        applyBlob(driveBlob);
        setMarker({ syncedHash: blobHash(driveBlob) });
      } else if (choice === 'upload_local') {
        const local = store.getSnapshot();
        await driveClient.update(fileId, JSON.stringify(local));
        setMarker({ syncedHash: blobHash(local) });
      } else if (choice === 'disconnect') {
        disabled = true;
        clearMarker();
      } else {
        return; // unknown choice — stay pending
      }
      collisionPending = null;
      setStatus(SyncStatus.SYNCED);
    } catch (e) {
      handleError(e);
    }
  }

  /* ---- lifecycle ------------------------------------------------------- */
  function start() {
    if (disabled || unsub) return;
    if (!isSignedIn()) {
      setStatus(SyncStatus.SYNCED); // signed out -> inert, board is local-only
      return;
    }
    unsub = store.subscribe(markDirty); // every mutation marks dirty
    // Background reconcile: a read subsumes the pending-push case (if local
    // advanced while drive is unchanged, resolve() returns push_local). Never
    // blocks render — the store already hydrated from localStorage.
    triggerRead();
  }

  /** Opportunistic flush on tab hide/close (browser only); best-effort keepalive. */
  function installLifecycleFlush() {
    if (typeof document === 'undefined') return () => {};
    const onHide = () => {
      if (document.visibilityState === 'hidden') requestWriteKeepalive();
    };
    const onPageHide = () => requestWriteKeepalive();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }
  function requestWriteKeepalive() {
    if (disabled || collisionPending || !isSignedIn() || busy) return;
    return launch(() => doWrite({ keepalive: true }));
  }

  function dispose() {
    if (unsub) unsub();
    unsub = null;
    if (debounceHandle) cancel(debounceHandle);
    if (backoffHandle) cancel(backoffHandle);
    debounceHandle = backoffHandle = null;
  }

  return {
    start,
    dispose,
    // triggers
    syncNow: triggerRead,
    onFocus: triggerRead,
    markDirty,
    flush: requestWrite,
    installLifecycleFlush,
    // collision
    resolveCollision,
    // status
    getStatus,
    subscribeStatus,
    // introspection (for the UI / tests)
    isBusy: () => busy,
    isCollisionPending: () => !!collisionPending,
    isDisabled: () => disabled,
    whenIdle, // resolves when all in-flight + queued Drive I/O has settled
  };
}
