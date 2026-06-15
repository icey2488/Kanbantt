/**
 * Tests for the Drive sync transport (Feature 2). Mock Drive client, no live
 * network. Run with: npm test (node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriveSync, SyncStatus } from './drive-sync.js';
import { blobHash } from './sync-merge.js';

/* ------------------------------------------------------------------ */
/* Doubles                                                            */
/* ------------------------------------------------------------------ */

const card = (id, version, extra = {}) => ({
  id, version, column_id: 'todo', order: 'V', deleted_at: null, tags: [], title: id, ...extra,
});
const blob = (over = {}) => ({
  schema_version: 1, seq: 0, cards: [], tags: [],
  columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }], settings: {}, ...over,
});

function mkStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _has: (k) => m.has(k),
    _raw: (k) => (m.has(k) ? m.get(k) : null),
  };
}

function mkStore(initial) {
  let snap = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    _set: (b) => { snap = b; for (const f of listeners) f(); },
  };
}

const httpError = (status, reason) => Object.assign(new Error(`HTTP ${status}`), { status, reason });

/** A deferred promise for driving mutex/timing tests. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Mock Drive client. `behavior` maps method -> fn(...) returning the result (or
 * throwing). Records all calls.
 */
function mkDrive(behavior = {}) {
  const calls = [];
  const run = (name, dflt, ...args) => {
    calls.push({ name, args });
    return behavior[name] ? behavior[name](...args) : dflt;
  };
  return {
    calls,
    count: (name) => calls.filter((c) => c.name === name).length,
    async listByName(name) { return run('listByName', [], name); },
    async create(name, content) { return run('create', { id: 'file-new', headRevisionId: 'r1' }, name, content); },
    async read(fileId) { return run('read', { text: '{}' }, fileId); },
    async update(fileId, content, opts) { return run('update', { id: fileId, headRevisionId: 'rX' }, fileId, content, opts); },
    async listRevisions(fileId) { return run('listRevisions', [], fileId); },
    async readRevision(fileId, revId) { return run('readRevision', { text: '{}' }, fileId, revId); },
  };
}

const signedIn = () => true;
const noopTimers = { schedule: () => 0, cancel: () => {} };

/* ================================================================== */
/* Find-or-create                                                     */
/* ================================================================== */

test('find-or-create: zero files -> create, store id + syncedHash', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const storage = mkStorage();
  const drive = mkDrive({ listByName: () => [], create: () => ({ id: 'file-1', headRevisionId: 'r1' }) });
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  await sync.syncNow();
  assert.equal(drive.count('create'), 1, 'created the file');
  assert.equal(drive.count('read'), 0, 'no read-back after create');
  const marker = JSON.parse(storage._raw('kanbantt_sync_marker'));
  assert.equal(marker.driveFileId, 'file-1');
  assert.equal(marker.syncedHash, blobHash(local));
  assert.equal(sync.getStatus().status, SyncStatus.SYNCED);
});

test('find-or-create: one file -> adopt id, no create', async () => {
  const store = mkStore(blob({ cards: [card('X', '1')] }));
  const storage = mkStorage();
  const drive = mkDrive({
    listByName: () => [{ id: 'file-7', name: 'kanbantt_data_v1' }],
    read: () => ({ text: JSON.stringify(store.getSnapshot()) }), // in_sync
  });
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  await sync.syncNow();
  assert.equal(drive.count('create'), 0);
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).driveFileId, 'file-7');
});

test('find-or-create: multiple files -> halt with error, no further I/O', async () => {
  const store = mkStore(blob({ cards: [card('X', '1')] }));
  const drive = mkDrive({
    listByName: () => [{ id: 'a' }, { id: 'b' }],
  });
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage: mkStorage(), isSignedIn: signedIn, ...noopTimers });

  await sync.syncNow();
  assert.equal(sync.getStatus().status, SyncStatus.ERROR);
  assert.match(sync.getStatus().reason, /duplicate/i);
  assert.equal(drive.count('create'), 0);
  assert.equal(drive.count('read'), 0);
});

/* ================================================================== */
/* Write confirmation — no read-back                                  */
/* ================================================================== */

test('write is confirmed by the 200 metadata; no second GET (no read-back)', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const storage = mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'file-1', syncedHash: 'old' }) });
  const drive = mkDrive();
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  await sync.flush();
  assert.equal(drive.count('update'), 1, 'one PATCH');
  assert.equal(drive.count('read'), 0, 'NO read-back GET');
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, blobHash(local), 'syncedHash advanced on 200');
});

test('write is skipped when local already equals syncedHash', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const storage = mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'file-1', syncedHash: blobHash(local) }) });
  const drive = mkDrive();
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  await sync.flush();
  assert.equal(drive.count('update'), 0, 'nothing to write');
});

/* ================================================================== */
/* resolve() action handling                                          */
/* ================================================================== */

function setup({ local, driveText, marker, behavior = {} }) {
  const store = mkStore(local);
  const storage = mkStorage(marker ? { kanbantt_sync_marker: JSON.stringify(marker) } : {});
  const applied = [];
  const log = [];
  const drive = mkDrive({
    read: () => ({ text: driveText }),
    ...behavior,
    // Always log the push attempt (even when the injected behavior throws), so
    // order assertions see 'update' after 'apply' on a failed push too.
    update: (fileId, content, opts) => {
      log.push('update');
      if (behavior.update) return behavior.update(fileId, content, opts);
      return { id: fileId, headRevisionId: 'r' };
    },
  });
  const applyBlob = (b) => { applied.push(b); log.push('apply'); };
  const sync = createDriveSync({ store, applyBlob, drive, storage, isSignedIn: signedIn, ...noopTimers });
  return { store, storage, drive, applied, log, sync };
}

test('action in_sync: no write, stale syncedHash fast-forwarded', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const { drive, sync, storage } = setup({
    local, driveText: JSON.stringify(local),
    marker: { driveFileId: 'f', syncedHash: 'stale' },
  });
  await sync.syncNow();
  assert.equal(drive.count('update'), 0);
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, blobHash(local), 'fast-forwarded');
  assert.equal(sync.getStatus().status, SyncStatus.SYNCED);
});

test('action adopt_drive: local unchanged since sync, drive advanced -> apply drive, no push', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const driveBlob = blob({ cards: [card('X', '1'), card('Y', '1')] });
  const { drive, sync, applied, storage } = setup({
    local, driveText: JSON.stringify(driveBlob),
    marker: { driveFileId: 'f', syncedHash: blobHash(local) },
  });
  await sync.syncNow();
  assert.equal(applied.length, 1);
  assert.equal(blobHash(applied[0]), blobHash(driveBlob), 'adopted the drive blob');
  assert.equal(drive.count('update'), 0, 'no push on adopt');
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, blobHash(driveBlob));
});

test('action push_local: drive unchanged since sync, local advanced -> push, no apply', async () => {
  const driveBlob = blob({ cards: [card('X', '1')] });
  const local = blob({ cards: [card('X', '1'), card('Y', '1')] });
  const { drive, sync, applied, storage } = setup({
    local, driveText: JSON.stringify(driveBlob),
    marker: { driveFileId: 'f', syncedHash: blobHash(driveBlob) },
  });
  await sync.syncNow();
  assert.equal(applied.length, 0, 'no local apply on push');
  assert.equal(drive.count('update'), 1, 'pushed local');
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, blobHash(local));
});

test('action merge: store updated BEFORE push; syncedHash advances on 200', async () => {
  const local = blob({ cards: [card('X', 'a1', { title: 'AA' })] });
  const driveBlob = blob({ cards: [card('X', 'b1', { title: 'BB' })] });
  const { sync, applied, log, drive, storage } = setup({
    local, driveText: JSON.stringify(driveBlob),
    marker: { driveFileId: 'f', syncedHash: 'a-shared-prior' }, // matches neither -> merge
  });
  await sync.syncNow();
  assert.equal(applied.length, 1, 'merged blob applied to the store');
  assert.deepEqual(log, ['apply', 'update'], 'store updated BEFORE push');
  assert.equal(drive.count('update'), 1);
  const merged = applied[0];
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, blobHash(merged));
});

test('merge with a push-401: store holds the merge, syncedHash NOT advanced (next resolve = push_local)', async () => {
  const local = blob({ cards: [card('X', 'a1', { title: 'AA' })] });
  const driveBlob = blob({ cards: [card('X', 'b1', { title: 'BB' })] });
  const priorHash = 'a-shared-prior';
  const { sync, applied, log, storage } = setup({
    local, driveText: JSON.stringify(driveBlob),
    marker: { driveFileId: 'f', syncedHash: priorHash },
    behavior: { update: () => { throw httpError(401); } },
  });
  await sync.syncNow();
  assert.equal(applied.length, 1, 'merge applied to the store first');
  assert.deepEqual(log, ['apply', 'update'], 'apply happened before the failing push');
  assert.equal(JSON.parse(storage._raw('kanbantt_sync_marker')).syncedHash, priorHash, 'syncedHash NOT advanced on push failure');
  assert.equal(sync.getStatus().status, SyncStatus.PAUSED_RECONNECT);
  // The merged local now differs from syncedHash -> a subsequent reconcile is push_local.
  assert.notEqual(blobHash(applied[0]), priorHash);
});

test('action collision: collision_pending, no auto-merge, safety copy on resolve', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const driveBlob = blob({ cards: [card('Y', '1')] });
  const { sync, applied, drive, storage } = setup({
    local, driveText: JSON.stringify(driveBlob),
    marker: { driveFileId: 'f' }, // lastSynced absent -> collision (both non-empty)
  });
  await sync.syncNow();
  assert.equal(sync.getStatus().status, SyncStatus.COLLISION_PENDING);
  assert.equal(applied.length, 0, 'no auto-merge / no apply');
  assert.equal(drive.count('update'), 0, 'no auto write');
  assert.ok(sync.isCollisionPending());

  await sync.resolveCollision('adopt_drive');
  assert.ok(storage._has('kanbantt_sync_safety'), 'pre-action local retained as a safety copy');
  assert.equal(blobHash(JSON.parse(storage._raw('kanbantt_sync_safety'))), blobHash(local), 'safety copy is the pre-action local');
  assert.equal(applied.length, 1, 'adopt applied drive after the user chose');
  assert.equal(sync.getStatus().status, SyncStatus.SYNCED);
});

/* ================================================================== */
/* Corrupt read -> revision recovery                                  */
/* ================================================================== */

test('corrupt head -> fetch prior revision, adopt + repush', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const good = blob({ cards: [card('X', '1'), card('Y', '1')] });
  const store = mkStore(local);
  const storage = mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: 'whatever' }) });
  const applied = [];
  const drive = mkDrive({
    read: () => ({ text: '{ this is corrupt json' }),
    listRevisions: () => [{ id: 'rev-1' }, { id: 'rev-2-head' }],
    readRevision: (fileId, revId) => ({ text: revId === 'rev-1' ? JSON.stringify(good) : 'also-bad' }),
  });
  const sync = createDriveSync({ store, applyBlob: (b) => applied.push(b), drive, storage, isSignedIn: signedIn, ...noopTimers });

  await sync.syncNow();
  assert.equal(drive.count('listRevisions'), 1);
  assert.equal(applied.length, 1, 'adopted the recovered revision');
  assert.equal(blobHash(applied[0]), blobHash(good));
  assert.equal(drive.count('update'), 1, 'repushed to overwrite the corrupt head');
  assert.equal(sync.getStatus().status, SyncStatus.SYNCED);
});

test('corrupt head with NO valid revision -> error, never adopt garbage', async () => {
  const store = mkStore(blob({ cards: [card('X', '1')] }));
  const applied = [];
  const drive = mkDrive({
    read: () => ({ text: 'corrupt' }),
    listRevisions: () => [{ id: 'r1' }, { id: 'head' }],
    readRevision: () => ({ text: 'still-corrupt' }),
  });
  const sync = createDriveSync({
    store, applyBlob: (b) => applied.push(b), drive,
    storage: mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f' }) }),
    isSignedIn: signedIn, ...noopTimers,
  });
  await sync.syncNow();
  assert.equal(applied.length, 0, 'never adopt garbage');
  assert.equal(drive.count('update'), 0, 'never overwrite local with unparseable data');
  assert.equal(sync.getStatus().status, SyncStatus.ERROR);
});

/* ================================================================== */
/* Mutex                                                              */
/* ================================================================== */

test('mutex: a dirty-write is queued (not run) while a read is in flight, then runs', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const storage = mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: blobHash(local) }) });
  const readGate = deferred();
  const drive = mkDrive({
    read: () => readGate.promise.then(() => ({ text: JSON.stringify(local) })), // in_sync once resolved
  });
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  const readP = sync.syncNow(); // acquires the mutex, blocks on readGate
  assert.ok(sync.isBusy(), 'read in flight');
  // a store mutation advances local so a write has something to do
  store._set(blob({ cards: [card('X', '1'), card('Z', '1')] }));
  sync.flush(); // requestWrite -> queued (busy)
  assert.equal(drive.count('update'), 0, 'queued write did NOT run during the read');

  readGate.resolve();
  await readP;
  await sync.whenIdle(); // let the queued write drain
  assert.equal(drive.count('update'), 1, 'queued write ran after the read released the mutex');
});

test('mutex: a focus-read is dropped while a write is in flight', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const storage = mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: 'old' }) });
  const writeGate = deferred();
  const drive = mkDrive({
    update: () => writeGate.promise.then(() => ({ id: 'f', headRevisionId: 'r' })),
  });
  const sync = createDriveSync({ store, applyBlob: () => {}, drive, storage, isSignedIn: signedIn, ...noopTimers });

  const writeP = sync.flush(); // acquires the mutex, blocks on writeGate
  assert.ok(sync.isBusy(), 'write in flight');
  sync.onFocus(); // focus-read -> dropped (busy)
  assert.equal(drive.count('read'), 0, 'focus-read dropped during the in-flight write');

  writeGate.resolve();
  await writeP;
  await sync.whenIdle();
  assert.equal(drive.count('read'), 0, 'still no read — it was dropped, not queued');
});

/* ================================================================== */
/* Error taxonomy                                                     */
/* ================================================================== */

test('401 on write -> paused_reconnect', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const sync = createDriveSync({
    store: mkStore(local), applyBlob: () => {},
    drive: mkDrive({ update: () => { throw httpError(401); } }),
    storage: mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: 'old' }) }),
    isSignedIn: signedIn, ...noopTimers,
  });
  await sync.flush();
  assert.equal(sync.getStatus().status, SyncStatus.PAUSED_RECONNECT);
});

test('403 rate-limit -> paused_ratelimited, schedules a background retry, no prompt', async () => {
  let scheduled = 0;
  const sync = createDriveSync({
    store: mkStore(blob({ cards: [card('X', '1')] })), applyBlob: () => {},
    drive: mkDrive({ update: () => { throw httpError(403, 'userRateLimitExceeded'); } }),
    storage: mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: 'old' }) }),
    isSignedIn: signedIn, schedule: () => { scheduled++; return 1; }, cancel: () => {},
  });
  await sync.flush();
  assert.equal(sync.getStatus().status, SyncStatus.PAUSED_RATELIMITED);
  assert.ok(scheduled >= 1, 'a backoff retry was scheduled');
  assert.ok(!sync.isCollisionPending(), 'no user prompt for rate-limit');
});

test('403 quota/storage-full -> paused_quota, no retry scheduled', async () => {
  let scheduled = 0;
  const sync = createDriveSync({
    store: mkStore(blob({ cards: [card('X', '1')] })), applyBlob: () => {},
    drive: mkDrive({ update: () => { throw httpError(403, 'storageQuotaExceeded'); } }),
    storage: mkStorage({ kanbantt_sync_marker: JSON.stringify({ driveFileId: 'f', syncedHash: 'old' }) }),
    isSignedIn: signedIn, schedule: () => { scheduled++; return 1; }, cancel: () => {},
  });
  await sync.flush();
  assert.equal(sync.getStatus().status, SyncStatus.PAUSED_QUOTA);
  assert.equal(scheduled, 0, 'quota suspends — does not auto-retry');
});

/* ================================================================== */
/* Local-first: sync failure never blocks the board                   */
/* ================================================================== */

test('local-first: a throwing Drive client never throws out of sync, never touches local', async () => {
  const local = blob({ cards: [card('X', '1')] });
  const store = mkStore(local);
  const applied = [];
  const drive = mkDrive({
    listByName: () => { throw httpError(500); },
    read: () => { throw httpError(500); },
    update: () => { throw httpError(500); },
  });
  const sync = createDriveSync({
    store, applyBlob: (b) => applied.push(b), drive,
    storage: mkStorage(), isSignedIn: signedIn, schedule: () => 1, cancel: () => {},
  });

  // Must not reject, must not mutate local, must surface a status.
  await assert.doesNotReject(async () => { await sync.syncNow(); });
  assert.equal(applied.length, 0, 'local never overwritten on a Drive failure');
  assert.equal(store.getSnapshot(), local, 'store snapshot untouched');
  assert.equal(sync.getStatus().status, SyncStatus.ERROR);
});

test('signed out: sync is inert (no Drive I/O)', async () => {
  const drive = mkDrive();
  const sync = createDriveSync({
    store: mkStore(blob({ cards: [card('X', '1')] })), applyBlob: () => {},
    drive, storage: mkStorage(), isSignedIn: () => false, ...noopTimers,
  });
  sync.start();
  await sync.syncNow();
  await sync.flush();
  assert.equal(drive.calls.length, 0, 'no Drive calls while signed out');
});
