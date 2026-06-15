/**
 * Tests for the local-first card store + legacy migration.
 * Run with: npm test   (node --test, no extra deps)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStore,
  runLegacyMigration,
  orderBetween,
  mintOrders,
  compareCards,
  validateBlob,
  StoreError,
  STORAGE_KEY,
  MIGRATED_MARKER,
  LEGACY_KEYS,
  SYNC_TOKEN_TTL_MS,
  DEFAULT_COLUMNS,
  DEFAULT_TAGS,
} from './card-store.js';

/* ------------------------------------------------------------------ */
/* Test doubles                                                       */
/* ------------------------------------------------------------------ */

/** In-memory localStorage with optional per-key setItem failure injection. */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  let fail = null; // { key, error }
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (fail && fail.key === k) throw fail.error;
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    // helpers
    _map: map,
    _has: (k) => map.has(k),
    _raw: (k) => (map.has(k) ? map.get(k) : null),
    _failSetItem: (key, error) => { fail = { key, error }; },
  };
}

const quotaError = () =>
  Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });

/** Run fn, return the thrown error (node:assert's throws() returns undefined). */
function grab(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new assert.AssertionError({ message: 'expected the function to throw, but it did not' });
}

/** Deterministic id minter. */
function counterUuid(prefix = 'u') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** A store with a controllable clock + deterministic ids. */
function freshStore(opts = {}) {
  const storage = opts.storage || makeStorage();
  const clock = { t: opts.t0 ?? Date.UTC(2026, 5, 11) };
  const store = createStore({
    storage,
    actor: opts.actor || 'tester',
    now: () => clock.t,
    uuid: opts.uuid || counterUuid(),
  });
  return { store, storage, clock };
}

/* ================================================================== */
/* create                                                             */
/* ================================================================== */

test('create then idempotent replay returns the existing card', () => {
  const { store } = freshStore();
  const first = store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  const replay = store.create({ id: 'c1', title: 'B', column_id: 'done' });

  assert.equal(replay.id, 'c1');
  assert.equal(replay.title, 'A', 'replay must not overwrite');
  assert.equal(replay.version, 1);
  assert.equal(replay.column_id, 'todo');
  assert.equal(store.list().cards.length, 1, 'no duplicate card');
});

test('create ignores client-supplied version/deleted_at/actor and stamps fresh', () => {
  const { store } = freshStore();
  const card = store.create({
    id: 'c1',
    title: 'x',
    column_id: 'todo',
    version: 99,
    deleted_at: '2020-01-01T00:00:00.000Z',
    created_by: 'evil',
    updated_by: 'evil',
    seq: 1234,
  });
  assert.equal(card.version, 1);
  assert.equal(card.deleted_at, null);
  assert.equal(card.created_by, 'tester');
  assert.equal(card.updated_by, 'tester');
  assert.equal(card.seq, 1);
  assert.ok(card.created_at && card.updated_at);
});

/* ================================================================== */
/* update / move / delete — version conflicts                         */
/* ================================================================== */

test('update with stale expected_version throws conflict with current card in meta', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  store.update('c1', { title: 'B' }, { expected_version: 1 }); // -> v2

  const err = grab(() => store.update('c1', { title: 'C' }, { expected_version: 1 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'conflict');
  assert.equal(err.meta.current.version, 2);
  assert.equal(err.meta.current.title, 'B');
});

test('move with stale expected_version throws conflict', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  store.update('c1', { title: 'B' }, { expected_version: 1 }); // -> v2

  const err = grab(() => store.move('c1', { column_id: 'done' }, { expected_version: 1 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'conflict');
  assert.equal(err.meta.current.version, 2);
});

test('delete with stale expected_version throws conflict', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  store.update('c1', { title: 'B' }, { expected_version: 1 }); // -> v2

  const err = grab(() => store.delete('c1', { expected_version: 1 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'conflict');
  assert.equal(err.meta.current.version, 2);
});

test('force bypasses version on update/move, but force on a tombstone still throws conflict', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });

  const u = store.update('c1', { title: 'B' }, { force: true }); // no expected_version
  assert.equal(u.version, 2);
  const m = store.move('c1', { column_id: 'done' }, { force: true });
  assert.equal(m.version, 3);
  assert.equal(m.column_id, 'done');

  const tomb = store.delete('c1', { expected_version: 3 }); // -> v4 tombstone
  assert.ok(tomb.deleted_at);

  const e1 = grab(() => store.update('c1', { title: 'C' }, { force: true }));
  assert.equal(e1.code, 'conflict');
  const e2 = grab(() => store.delete('c1', { force: true }));
  assert.equal(e2.code, 'conflict');
  const e3 = grab(() => store.move('c1', { column_id: 'todo' }, { force: true }));
  assert.equal(e3.code, 'conflict');
});

test('delete then update fails', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  store.delete('c1', { expected_version: 1 });

  const err = grab(() => store.update('c1', { title: 'B' }, { expected_version: 2 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'conflict');
  assert.ok(err.meta.current.deleted_at);
});

/* ================================================================== */
/* list — full / delta / includeDeleted                              */
/* ================================================================== */

test('delta list returns tombstones', () => {
  const { store } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' });
  store.create({ id: 'b', title: 'B', column_id: 'todo' });

  const { sync_token } = store.list();
  store.delete('a', { expected_version: 1 });
  store.update('b', { title: 'B2' }, { expected_version: 1 });

  const delta = store.list({ since: sync_token });
  const ids = delta.cards.map((c) => c.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  const a = delta.cards.find((c) => c.id === 'a');
  assert.ok(a.deleted_at, 'tombstone present in delta');
});

test('full list respects includeDeleted', () => {
  const { store } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' });
  store.create({ id: 'b', title: 'B', column_id: 'todo' });
  store.delete('a', { expected_version: 1 });

  const live = store.list().cards.map((c) => c.id);
  assert.deepEqual(live, ['b']);

  const all = store.list({ includeDeleted: true }).cards.map((c) => c.id).sort();
  assert.deepEqual(all, ['a', 'b']);
});

/* ================================================================== */
/* order keys                                                         */
/* ================================================================== */

test('orderBetween: empty column, start, end, between, and id tiebreak', () => {
  // empty column
  const first = orderBetween(null, null);
  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);

  // start: strictly before an existing key
  const before = orderBetween(null, first);
  assert.ok(before < first, `${before} < ${first}`);

  // end: strictly after an existing key
  const after = orderBetween(first, null);
  assert.ok(after > first, `${after} > ${first}`);

  // between: strictly between two neighbors
  const mid = orderBetween(before, after);
  assert.ok(before < mid && mid < after, `${before} < ${mid} < ${after}`);

  // id tiebreak on an exact order collision
  const sorted = [
    { id: 'card-b', order: 'V' },
    { id: 'card-a', order: 'V' },
  ].sort(compareCards);
  assert.deepEqual(sorted.map((c) => c.id), ['card-a', 'card-b']);
});

test('orderBetween maintains a total order under random insertion', () => {
  // Property check: repeatedly insert between random neighbors; the keys must
  // stay strictly sorted and unique. Exercises avg/increment edge cases.
  let rng = 123456789;
  const rand = () => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  };
  const keys = [orderBetween(null, null)];
  for (let n = 0; n < 400; n++) {
    const i = Math.floor(rand() * (keys.length + 1)); // gap 0..len
    const a = i === 0 ? null : keys[i - 1];
    const b = i === keys.length ? null : keys[i];
    const k = orderBetween(a, b);
    if (a != null) assert.ok(a < k, `left: ${a} < ${k}`);
    if (b != null) assert.ok(k < b, `right: ${k} < ${b}`);
    keys.splice(i, 0, k);
  }
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1] < keys[i], `sorted at ${i}: ${keys[i - 1]} < ${keys[i]}`);
  }
  assert.equal(new Set(keys).size, keys.length, 'all keys unique');
});

test('id tiebreak through list() on a seeded order collision', () => {
  const blob = {
    schema_version: 1,
    seq: 2,
    cards: [
      { id: 'card-b', column_id: 'todo', order: 'V', version: 1, deleted_at: null, seq: 1 },
      { id: 'card-a', column_id: 'todo', order: 'V', version: 1, deleted_at: null, seq: 2 },
    ],
    tags: [],
    columns: DEFAULT_COLUMNS,
    settings: {},
  };
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(blob) });
  const { store } = freshStore({ storage });
  assert.deepEqual(store.list().cards.map((c) => c.id), ['card-a', 'card-b']);
});

/* ================================================================== */
/* sync tokens                                                         */
/* ================================================================== */

test('expired sync token throws sync_token_expired', () => {
  const { store, clock } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' });
  const { sync_token } = store.list();

  clock.t += SYNC_TOKEN_TTL_MS + 1; // advance past TTL
  const err = grab(() => store.list({ since: sync_token }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'sync_token_expired');
});

test('malformed or foreign sync token throws a clean domain error, never a TypeError', () => {
  const { store } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' });

  const bad = [
    'null',
    'not-a-real-token-zzz!!!',
    String(Date.now()),
    '2026-06-11T00:00:00.000Z',
    1718000000000, // a bare numeric timestamp
    '',
  ];
  for (const tok of bad) {
    const err = grab(() => store.list({ since: tok }));
    assert.ok(err instanceof StoreError, `token ${tok}: ${err && err.name}`);
    assert.equal(err.code, 'invalid_sync_token', `token: ${tok}`);
    assert.ok(!(err instanceof TypeError));
  }
});

/* ================================================================== */
/* unknown-field round trips                                          */
/* ================================================================== */

test('unknown-field round-trip at blob, card, and legacy-task level', () => {
  // --- blob + card level: unknown fields survive load + a mutation + reload.
  const seeded = {
    schema_version: 1,
    seq: 1,
    mascot: 'penguin', // unknown top-level field
    cards: [
      {
        id: 'c0', column_id: 'todo', order: 'V', version: 1, deleted_at: null, seq: 1,
        title: 'Seed', quirk: { nested: true }, // unknown card field
      },
    ],
    tags: [],
    columns: DEFAULT_COLUMNS,
    settings: {},
  };
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(seeded) });
  const { store } = freshStore({ storage });

  const created = store.create({ id: 'c1', title: 'New', column_id: 'todo', weird: 42 });
  assert.equal(created.weird, 42, 'unknown field preserved on create');
  const updated = store.update('c1', { another: 'kept' }, { expected_version: 1 });
  assert.equal(updated.weird, 42, 'unknown field survives update');
  assert.equal(updated.another, 'kept');

  const reread = JSON.parse(storage._raw(STORAGE_KEY));
  assert.equal(reread.mascot, 'penguin', 'unknown blob field preserved');
  const c0 = reread.cards.find((c) => c.id === 'c0');
  assert.deepEqual(c0.quirk, { nested: true }, 'unknown card field preserved');

  // --- legacy-task level: unknown task fields land on the migrated card.
  const legacy = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify([
      { id: 't1', title: 'L', status: 'todo', tags: [], mystery: 'preserve-me', count: 7 },
    ]),
  });
  runLegacyMigration({ storage: legacy, now: () => 0, uuid: counterUuid('m') });
  const migrated = JSON.parse(legacy._raw(STORAGE_KEY)).cards[0];
  assert.equal(migrated.mystery, 'preserve-me');
  assert.equal(migrated.count, 7);
});

/* ================================================================== */
/* schema refusal                                                     */
/* ================================================================== */

test('a blob with schema_version 2 is refused with zero data in memory', () => {
  const future = {
    schema_version: 2,
    seq: 5,
    cards: [{ id: 'x', column_id: 'todo', order: 'V', version: 1, deleted_at: null, seq: 1 }],
    tags: [],
    columns: DEFAULT_COLUMNS,
    settings: {},
  };
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(future) });
  const { store } = freshStore({ storage });

  const err = grab(() => store.load());
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'schema_unsupported');
  assert.equal(err.meta.found, 2);

  // Assert ZERO data in memory — not just "didn't crash".
  assert.equal(store.snapshot(), null, 'no blob held in memory');
  assert.equal(store.isLoaded(), false);
  assert.throws(() => store.list(), (e) => e.code === 'schema_unsupported');
  // And the untouched future blob is still on disk.
  assert.equal(JSON.parse(storage._raw(STORAGE_KEY)).schema_version, 2);
});

/* ================================================================== */
/* migration                                                          */
/* ================================================================== */

test('migration from a full legacy fixture', () => {
  const legacyTasks = [
    { id: 't-a', title: 'Alpha', status: 'todo', tags: ['tag-frontend'], priority: 'high', dueDate: '2026-01-01', custom: 'keep' },
    { id: 't-b', title: 'Beta', status: 'todo', tags: ['tag-backend', 'tag-frontend'], checklist: [{ id: 'x', text: 'y', done: false }] },
    { id: 't-c', title: 'Gamma', status: 'done', tags: [] },
    { title: 'NoId', status: 'doing' }, // id minted
  ];
  const storage = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify(legacyTasks),
    [LEGACY_KEYS.columns]: JSON.stringify(DEFAULT_COLUMNS),
    [LEGACY_KEYS.tags]: JSON.stringify(DEFAULT_TAGS),
  });

  const res = runLegacyMigration({ storage, actor: 'migration', now: () => Date.UTC(2026, 0, 2), uuid: counterUuid('m') });
  assert.equal(res.status, 'migrated');
  assert.equal(res.cards, 4);

  // Marker written; legacy keys untouched (natural backup).
  assert.ok(storage._has(MIGRATED_MARKER));
  assert.ok(storage._has(LEGACY_KEYS.tasks));
  assert.ok(storage._has(LEGACY_KEYS.columns));

  const { store } = freshStore({ storage });
  const all = store.list({ includeDeleted: true }).cards;
  assert.equal(all.length, 4);

  const a = store.get('t-a');
  assert.equal(a.column_id, 'todo', 'status maps to column_id');
  assert.equal(a.version, 1);
  assert.equal(a.created_by, 'migration');
  assert.equal(a.deleted_at, null);
  assert.equal(a.custom, 'keep', 'unknown field preserved');
  assert.equal(a.created_at, new Date(Date.UTC(2026, 0, 2)).toISOString(), 'timestamp = now when absent');
  assert.deepEqual(a.tags, ['tag-frontend']);

  // 'todo' column orders are strictly increasing in legacy order (t-a before t-b).
  const todo = all.filter((c) => c.column_id === 'todo').sort((x, y) => x.seq - y.seq);
  assert.deepEqual(todo.map((c) => c.id), ['t-a', 't-b']);
  assert.ok(todo[0].order < todo[1].order);

  // NoId task got a minted id.
  const noId = all.find((c) => c.title === 'NoId');
  assert.ok(noId.id && noId.id.length > 0);
  assert.equal(noId.column_id, 'doing');

  // Store continues the seq line after migration.
  const next = store.create({ title: 'New', column_id: 'todo' });
  assert.equal(next.version, 1);
  assert.ok(next.seq > 4);
});

test('migration with K_COLUMNS/K_TAGS absent uses defaults', () => {
  const storage = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify([
      { id: 't1', title: 'A', status: 'todo', tags: ['tag-frontend'] },
    ]),
    // no columns, no tags
  });
  const res = runLegacyMigration({ storage, now: () => 0, uuid: counterUuid('m') });
  assert.equal(res.status, 'migrated');

  const blob = JSON.parse(storage._raw(STORAGE_KEY));
  assert.deepEqual(blob.columns, DEFAULT_COLUMNS);
  assert.deepEqual(blob.tags, DEFAULT_TAGS);
});

test('migration even-distribution produces sorted short strings for a 150-card column', () => {
  const tasks = [];
  for (let i = 0; i < 150; i++) tasks.push({ id: `t-${i}`, title: `T${i}`, status: 'todo', tags: [] });
  const storage = makeStorage({ [LEGACY_KEYS.tasks]: JSON.stringify(tasks) });

  runLegacyMigration({ storage, now: () => 0, uuid: counterUuid('m') });
  const blob = JSON.parse(storage._raw(STORAGE_KEY));
  const todo = blob.cards.filter((c) => c.column_id === 'todo').sort((a, b) => a.seq - b.seq);
  assert.equal(todo.length, 150);

  const orders = todo.map((c) => c.order);
  // strictly increasing, matching legacy order
  for (let i = 1; i < orders.length; i++) {
    assert.ok(orders[i - 1] < orders[i], `sorted: ${orders[i - 1]} < ${orders[i]}`);
  }
  // short + uniform: 150 cards => width 2
  assert.ok(orders.every((o) => o.length <= 3), 'short');
  assert.equal(new Set(orders.map((o) => o.length)).size, 1, 'uniform length');
  assert.equal(new Set(orders).size, 150, 'distinct');

  // mintOrders is the dedicated even-distribution pass used by migration.
  const minted = mintOrders(150);
  assert.deepEqual(orders, minted);
});

test('migration with a corrupt K_TASKS writes nothing', () => {
  const storage = makeStorage({ [LEGACY_KEYS.tasks]: '{ this is not json' });
  const err = grab(() => runLegacyMigration({ storage, now: () => 0 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'migration_failed');
  assert.equal(storage._has(STORAGE_KEY), false, 'no blob written');
  assert.equal(storage._has(MIGRATED_MARKER), false, 'no marker written');
  assert.equal(storage._raw(LEGACY_KEYS.tasks), '{ this is not json', 'legacy untouched');
});

test('migration with a corrupt K_COLUMNS halts with nothing written', () => {
  const storage = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify([{ id: 't1', title: 'A', status: 'todo', tags: [] }]),
    [LEGACY_KEYS.columns]: '<<<corrupt>>>',
  });
  const err = grab(() => runLegacyMigration({ storage, now: () => 0 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'migration_failed');
  assert.equal(storage._has(STORAGE_KEY), false);
  assert.equal(storage._has(MIGRATED_MARKER), false);
});

test('migration with an orphaned tag reference produces the synthetic tag', () => {
  const storage = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify([
      { id: 't1', title: 'A', status: 'todo', tags: ['ghost-123', 'tag-frontend'] },
      { id: 't2', title: 'B', status: 'todo', tags: ['ghost-123'] },
    ]),
    [LEGACY_KEYS.tags]: JSON.stringify(DEFAULT_TAGS),
  });
  const res = runLegacyMigration({ storage, now: () => 0, uuid: counterUuid('m') });
  assert.deepEqual(res.synthetic_tags, ['orphaned-ghost-123']);

  const blob = JSON.parse(storage._raw(STORAGE_KEY));
  const synth = blob.tags.find((t) => t.id === 'orphaned-ghost-123');
  assert.ok(synth, 'synthetic tag minted');
  assert.equal(synth.name, 'Unknown tag (ghost-123)');
  assert.equal(synth.color, 'gray');

  // The reference is NEVER dropped — it now points at the synthetic tag.
  const t1 = blob.cards.find((c) => c.id === 't1');
  assert.deepEqual(t1.tags, ['orphaned-ghost-123', 'tag-frontend']);
  const t2 = blob.cards.find((c) => c.id === 't2');
  assert.deepEqual(t2.tags, ['orphaned-ghost-123']);
});

test('simulated QuotaExceededError mid-write leaves legacy keys intact and no v1 blob', () => {
  const storage = makeStorage({
    [LEGACY_KEYS.tasks]: JSON.stringify([{ id: 't1', title: 'A', status: 'todo', tags: [] }]),
    [LEGACY_KEYS.columns]: JSON.stringify(DEFAULT_COLUMNS),
    [LEGACY_KEYS.tags]: JSON.stringify(DEFAULT_TAGS),
  });
  storage._failSetItem(STORAGE_KEY, quotaError());

  const err = grab(() => runLegacyMigration({ storage, now: () => 0 }));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'migration_failed');

  assert.equal(storage._has(STORAGE_KEY), false, 'no v1 blob');
  assert.equal(storage._has(MIGRATED_MARKER), false, 'no marker');
  assert.ok(storage._has(LEGACY_KEYS.tasks), 'legacy tasks intact');
  assert.ok(storage._has(LEGACY_KEYS.columns), 'legacy columns intact');
  assert.ok(storage._has(LEGACY_KEYS.tags), 'legacy tags intact');
});

test('migration is skipped when a v1 blob already exists', () => {
  const storage = makeStorage({
    [STORAGE_KEY]: JSON.stringify({ schema_version: 1, seq: 0, cards: [], tags: [], columns: DEFAULT_COLUMNS, settings: {} }),
    [LEGACY_KEYS.tasks]: JSON.stringify([{ id: 't1', title: 'A', status: 'todo', tags: [] }]),
  });
  const res = runLegacyMigration({ storage, now: () => 0 });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'already_migrated');
});

test('migration is skipped for a fresh user with no legacy data', () => {
  const storage = makeStorage();
  const res = runLegacyMigration({ storage, now: () => 0 });
  assert.equal(res.status, 'skipped');
  assert.equal(res.reason, 'no_legacy_data');
  assert.equal(storage._has(STORAGE_KEY), false);
});

/* ================================================================== */
/* reactivity bridge (subscribe / getSnapshot / board writers)        */
/* ================================================================== */

test('subscribe fires a listener on every successful mutation', () => {
  const { store } = freshStore();
  let calls = 0;
  const unsub = store.subscribe(() => calls++);

  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  assert.equal(calls, 1);
  store.update('c1', { title: 'B' }, { expected_version: 1 });
  assert.equal(calls, 2);
  store.move('c1', { column_id: 'done' }, { expected_version: 2 });
  assert.equal(calls, 3);
  store.columnUpdate('todo', { label: 'To Do' });
  assert.equal(calls, 4);
  store.tagCreate({ id: 't1', name: 'x', color: 'gray' });
  assert.equal(calls, 5);
  store.delete('c1', { expected_version: 3 });
  assert.equal(calls, 6);

  unsub();
  store.create({ id: 'c2', title: 'C', column_id: 'todo' });
  assert.equal(calls, 6, 'no notification after unsubscribe');
});

test('a thrown (conflicting) mutation does not notify', () => {
  const { store } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  let calls = 0;
  store.subscribe(() => calls++);
  assert.throws(() => store.update('c1', { title: 'B' }, { expected_version: 999 }));
  assert.equal(calls, 0, 'failed mutation must not fire listeners');
});

test('getSnapshot is referentially stable between mutations and fresh after one', () => {
  const { store } = freshStore();
  const s0 = store.getSnapshot();
  assert.equal(store.getSnapshot(), s0, 'stable across reads with no mutation');

  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  const s1 = store.getSnapshot();
  assert.notEqual(s1, s0, 'fresh reference after a mutation');
  assert.equal(store.getSnapshot(), s1, 'stable again until next mutation');

  store.update('c1', { title: 'B' }, { expected_version: 1 });
  const s2 = store.getSnapshot();
  assert.notEqual(s2, s1);

  // Older snapshots are immutable — not retroactively mutated by later writes.
  assert.equal(s1.cards[0].title, 'A');
  assert.equal(s2.cards[0].title, 'B');
});

test('columnCreate/Update and tagCreate/Update update the snapshot and persist', () => {
  const { store, storage } = freshStore();
  store.columnCreate({ id: 'alpha', label: 'Alpha', accentKey: 'ice' });
  store.columnUpdate('backlog', { label: 'Backlog!' });
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  store.tagUpdate('tag-x', { name: 'X2' });

  const snap = store.getSnapshot();
  assert.ok(snap.columns.some((c) => c.id === 'alpha'), 'created column in snapshot');
  assert.equal(snap.columns.find((c) => c.id === 'backlog').label, 'Backlog!', 'rename applied');
  assert.equal(snap.tags.find((t) => t.id === 'tag-x').name, 'X2', 'tag rename applied');

  // Persisted to storage under the v1 blob.
  const onDisk = JSON.parse(storage._raw(STORAGE_KEY));
  assert.ok(onDisk.columns.some((c) => c.id === 'alpha'));
  assert.equal(onDisk.tags.find((t) => t.id === 'tag-x').name, 'X2');
});

test('columnCreate/tagCreate reject a duplicate id; update/reorder reject an unknown id', () => {
  const { store } = freshStore();
  assert.equal(grab(() => store.columnCreate({ id: 'todo', label: 'dup' })).code, 'validation_failed');
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  assert.equal(grab(() => store.tagCreate({ id: 'tag-x', name: 'y', color: 'blue' })).code, 'validation_failed');
  assert.equal(grab(() => store.columnUpdate('nope', { label: 'x' })).code, 'column_unknown');
  assert.equal(grab(() => store.columnReorder('nope', 0)).code, 'column_unknown');
  assert.equal(grab(() => store.tagUpdate('nope', { name: 'x' })).code, 'not_found');
});

/* ================================================================== */
/* board-config bulk ops — orphan-move, ref-strip, atomicity (A.5)    */
/* ================================================================== */

test('tagDelete strips the tag from every referencing card and leaves no dangling ref', () => {
  const { store } = freshStore();
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  store.create({ id: 'c1', title: 'A', column_id: 'todo', tags: ['tag-x', 'tag-y'] });
  store.create({ id: 'c2', title: 'B', column_id: 'todo', tags: ['tag-y'] });
  store.create({ id: 'c3', title: 'C', column_id: 'done', tags: ['tag-x'] });

  const v1Before = store.get('c1').version;
  store.tagDelete('tag-x');

  // Tag gone from the board, and not one surviving card still references it.
  assert.equal(store.getSnapshot().tags.some((t) => t.id === 'tag-x'), false);
  const all = store.list({ includeDeleted: true }).cards;
  assert.equal(all.some((c) => (c.tags || []).includes('tag-x')), false, 'no dangling tag ref');

  // Affected cards stripped + version bumped; untouched cards left alone.
  assert.deepEqual(store.get('c1').tags, ['tag-y']);
  assert.equal(store.get('c1').version, v1Before + 1, 'affected card version bumped');
  assert.deepEqual(store.get('c3').tags, []);
  assert.equal(store.get('c2').version, 1, 'unaffected card untouched');
});

test('tagDelete strips the ref from a tombstoned card without resurrecting it', () => {
  const { store } = freshStore();
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  store.create({ id: 'c1', title: 'A', column_id: 'todo', tags: ['tag-x'] });
  const tomb = store.delete('c1', { expected_version: 1 }); // -> v2 tombstone
  assert.ok(tomb.deleted_at);

  store.tagDelete('tag-x');

  const dead = store.list({ includeDeleted: true }).cards.find((c) => c.id === 'c1');
  assert.deepEqual(dead.tags, [], 'ref stripped from the tombstone too');
  assert.ok(dead.deleted_at, 'still a tombstone — never resurrected');
  assert.equal(dead.version, 3, 'version bumped by the system strip');
  assert.equal(store.list().cards.find((c) => c.id === 'c1'), undefined, 'not in the live list');
});

test('columnDelete moves live cards to the destination, preserving order, with bumped versions', () => {
  const { store } = freshStore();
  store.create({ id: 'd1', title: 'D1', column_id: 'done' });   // sits in destination
  store.create({ id: 'c1', title: 'C1', column_id: 'todo' });
  store.create({ id: 'c2', title: 'C2', column_id: 'todo' });
  store.create({ id: 'c3', title: 'C3', column_id: 'todo' });
  const tomb = store.create({ id: 'tz', title: 'Tomb', column_id: 'todo' });
  store.delete('tz', { expected_version: tomb.version }); // a tombstone in the doomed column
  const vBefore = store.get('c1').version;

  store.columnDelete('todo', 'done');

  // Column gone; no LIVE card still points at it.
  assert.equal(store.getSnapshot().columns.some((c) => c.id === 'todo'), false);
  assert.equal(store.list().cards.some((c) => c.column_id === 'todo'), false, 'no live orphan');

  // The three live cards landed in 'done', after d1, in their original order.
  const done = store.list().cards.filter((c) => c.column_id === 'done').sort(compareCards);
  assert.deepEqual(done.map((c) => c.id), ['d1', 'c1', 'c2', 'c3'], 'appended below, order preserved');
  assert.ok(done.find((c) => c.id === 'c1').order > done.find((c) => c.id === 'd1').order);
  assert.equal(store.get('c1').version, vBefore + 1, 'moved card version bumped');

  // The tombstone was skipped: not moved, not bumped, still dead with its old column_id.
  const dead = store.list({ includeDeleted: true }).cards.find((c) => c.id === 'tz');
  assert.equal(dead.column_id, 'todo', 'tombstone keeps its defunct column_id (skipped)');
  assert.equal(dead.version, 2, 'tombstone version untouched');
});

test('each bulk op fires notify exactly once, regardless of how many cards it touches', () => {
  const { store } = freshStore();
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  store.create({ id: 'c1', title: 'A', column_id: 'todo', tags: ['tag-x'] });
  store.create({ id: 'c2', title: 'B', column_id: 'todo', tags: ['tag-x'] });
  store.create({ id: 'c3', title: 'C', column_id: 'todo', tags: ['tag-x'] });

  let calls = 0;
  store.subscribe(() => calls++); // subscribe AFTER seeding

  store.tagDelete('tag-x');          // touches 3 cards
  assert.equal(calls, 1, 'tagDelete notified exactly once');

  store.columnDelete('todo', 'done'); // moves 3 cards
  assert.equal(calls, 2, 'columnDelete notified exactly once');
});

test('columnDelete to an unknown/invalid destination throws and changes nothing', () => {
  const { store, storage } = freshStore();
  store.create({ id: 'c1', title: 'A', column_id: 'todo' });
  const before = storage._raw(STORAGE_KEY);
  const snapBefore = store.getSnapshot();

  for (const [dest, code] of [['ghost', 'column_unknown'], ['todo', 'column_unknown'], [null, 'column_unknown']]) {
    const err = grab(() => store.columnDelete('todo', dest));
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, code, `dest ${dest}`);
  }
  // Byte-identical on disk + same snapshot reference (no notify happened).
  assert.equal(storage._raw(STORAGE_KEY), before, 'localStorage untouched');
  assert.equal(store.getSnapshot(), snapBefore, 'snapshot reference unchanged');
});

test('columnDelete on the last remaining column throws column_last_forbidden', () => {
  const { store } = freshStore();
  // Reduce to a single column via the store, then try to delete it.
  store.columnDelete('backlog', 'todo');
  store.columnDelete('doing', 'todo');
  store.columnDelete('done', 'todo');
  assert.deepEqual(store.getSnapshot().columns.map((c) => c.id), ['todo']);

  const err = grab(() => store.columnDelete('todo', 'todo'));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'column_last_forbidden');
  assert.deepEqual(store.getSnapshot().columns.map((c) => c.id), ['todo'], 'still there');
});

test('a bulk op whose single persist throws rolls back to a byte-identical state', () => {
  const { store, storage } = freshStore();
  store.tagCreate({ id: 'tag-x', name: 'x', color: 'red' });
  store.create({ id: 'c1', title: 'A', column_id: 'todo', tags: ['tag-x'] });
  store.create({ id: 'c2', title: 'B', column_id: 'todo', tags: ['tag-x'] });

  const before = storage._raw(STORAGE_KEY);
  const snapBefore = store.getSnapshot();
  let calls = 0;
  store.subscribe(() => calls++);

  storage._failSetItem(STORAGE_KEY, quotaError()); // the one write will throw
  const err = grab(() => store.tagDelete('tag-x'));
  assert.ok(err instanceof StoreError);
  assert.equal(err.code, 'persist_failed');
  assert.deepEqual(err.meta.affectedCardIds.sort(), ['c1', 'c2'], 'error names the cards it would touch');

  assert.equal(storage._raw(STORAGE_KEY), before, 'nothing written to localStorage');
  assert.equal(store.getSnapshot(), snapBefore, 'snapshot reference unchanged');
  assert.deepEqual(store.get('c1').tags, ['tag-x'], 'in-memory state intact');
  assert.equal(calls, 0, 'no notify on a failed bulk op');
});

test('the raw whole-array setters are not exported on the store', () => {
  const { store } = freshStore();
  assert.equal(typeof store.setColumns, 'undefined', 'setColumns must not be externally callable');
  assert.equal(typeof store.setTags, 'undefined', 'setTags must not be externally callable');
});

/* ================================================================== */
/* hydrate(blob) + shared validateBlob (Feature 3a)                   */
/* ================================================================== */

// A structurally-valid blob (passes validateBlob) for the hydrate tests.
const validBlob = (over = {}) => ({
  schema_version: 1,
  seq: 5,
  cards: [
    { id: 'k1', column_id: 'todo', order: 'V', version: 1, deleted_at: null, seq: 1, title: 'K1', tags: ['t1'] },
    { id: 'k2', column_id: 'done', order: 'W', version: 1, deleted_at: null, seq: 2, title: 'K2', tags: [] },
  ],
  tags: [{ id: 't1', name: 'one', color: 'red' }],
  columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }, { id: 'done', label: 'Done', accentKey: 'mint' }],
  settings: {},
  ...over,
});

test('hydrate replaces the whole blob, fires exactly one notify, snapshot reflects it', () => {
  const { store } = freshStore();
  store.create({ id: 'old', title: 'Old', column_id: 'todo' });
  let calls = 0;
  store.subscribe(() => calls++);

  const result = store.hydrate(validBlob());
  assert.equal(calls, 1, 'exactly one notify');
  const snap = store.getSnapshot();
  assert.deepEqual(snap.cards.map((c) => c.id).sort(), ['k1', 'k2'], 'old state fully replaced');
  assert.deepEqual(snap.tags.map((t) => t.id), ['t1']);
  assert.deepEqual(snap.columns.map((c) => c.id).sort(), ['done', 'todo']);
  assert.ok(result && result.cards.length === 2, 'returns the applied blob');
});

test('hydrate produces a fresh snapshot reference (drives a useSyncExternalStore re-render)', () => {
  const { store } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' });
  const before = store.getSnapshot();
  let fired = false;
  store.subscribe(() => { fired = true; });

  store.hydrate(validBlob());
  assert.ok(fired, 'subscription fired');
  assert.notEqual(store.getSnapshot(), before, 'fresh snapshot reference after hydrate');
});

test('hydrate never regresses seq; the next mutation mints strictly above the prior local max', () => {
  const { store } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo' }); // seq 1
  store.create({ id: 'b', title: 'B', column_id: 'todo' }); // seq 2
  store.update('a', { title: 'A2' }, { expected_version: 1 }); // seq 3
  assert.equal(store.getSnapshot().seq, 3);

  store.hydrate(validBlob({ seq: 1 })); // incoming seq LOWER than local
  assert.equal(store.getSnapshot().seq, 3, 'counter held at the higher local value');

  const c = store.create({ id: 'fresh', title: 'New', column_id: 'todo' });
  assert.ok(c.seq > 3, `next mutation seq ${c.seq} strictly above prior local max 3`);
  assert.ok(c.seq > 1, 'and above the incoming seq (no reissue of consumed numbers)');
});

test('hydrate preserves local settings verbatim (no guessed device-local/board-wide merge)', () => {
  // Seed a store whose persisted blob carries device-local settings.
  const seeded = validBlob({ settings: { theme_pref: 'dark', deviceId: 'A' } });
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(seeded) });
  const { store } = freshStore({ storage });
  store.load();

  store.hydrate(validBlob({ settings: { theme_pref: 'light', other: 'x' } }));
  assert.deepEqual(
    store.getSnapshot().settings,
    { theme_pref: 'dark', deviceId: 'A' },
    'local settings preserved; incoming settings NOT adopted (stop-and-report: no explicit key split)',
  );
});

// Deferred: the full device-local-vs-board-wide settings merge requires an
// explicit key split, which the codebase does not define (settings is a reserved,
// always-empty object; theme — the one device-local pref — lives outside the blob).
// Per the batch's step-3 stop-and-report rule, hydrate preserves local settings
// (tested above) and this graduates to a real test once the split is defined.
test('settings device-local-vs-board-wide merge', { skip: 'deferred: no explicit settings key split (step 3 stop-and-report)' }, () => {});

// Refusal must leave EVERYTHING byte-identical. Reference identity alone is
// insufficient (a poisoned singleton still passes ===), so assert deep-equality of
// in-memory state, the stringified localStorage value, AND that no notify fired.
function assertRefused(store, storage, badBlob, code) {
  const deepBefore = store.snapshot(); // deep clone of the in-memory blob
  const rawBefore = storage._raw(STORAGE_KEY);
  const refBefore = store.getSnapshot();
  let calls = 0;
  const unsub = store.subscribe(() => calls++);

  const err = grab(() => store.hydrate(badBlob));
  unsub();

  assert.ok(err instanceof StoreError, 'refusal throws a StoreError');
  if (code) assert.equal(err.code, code, 'expected refusal code');
  assert.deepEqual(store.snapshot(), deepBefore, 'in-memory blob byte-identical (deep)');
  assert.equal(storage._raw(STORAGE_KEY), rawBefore, 'localStorage byte-identical');
  assert.equal(store.getSnapshot(), refBefore, 'no new snapshot reference produced');
  assert.equal(calls, 0, 'no notify fired on refusal');
}

test('hydrate atomic refusal: every invalid blob leaves state + localStorage byte-identical, no notify', () => {
  const { store, storage } = freshStore();
  store.create({ id: 'a', title: 'A', column_id: 'todo', tags: [] });
  store.create({ id: 'b', title: 'B', column_id: 'done', tags: [] });
  const oneCol = [{ id: 'todo', label: 'T', accentKey: 'ice' }];

  // schema_version too new
  assertRefused(store, storage, validBlob({ schema_version: 2 }), 'schema_unsupported');
  // dangling tag ref
  assertRefused(store, storage, validBlob({
    cards: [{ id: 'x', column_id: 'todo', order: 'V', version: 1, deleted_at: null, tags: ['ghost'] }],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
  // card missing column_id
  assertRefused(store, storage, validBlob({
    cards: [{ id: 'x', order: 'V', version: 1, deleted_at: null, tags: [] }],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
  // card missing id
  assertRefused(store, storage, validBlob({
    cards: [{ column_id: 'todo', order: 'V', version: 1, deleted_at: null, tags: [] }],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
  // card missing order
  assertRefused(store, storage, validBlob({
    cards: [{ id: 'x', column_id: 'todo', version: 1, deleted_at: null, tags: [] }],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
  // card column_id absent from this blob's own columns
  assertRefused(store, storage, validBlob({
    cards: [{ id: 'x', column_id: 'ghostcol', order: 'V', version: 1, deleted_at: null, tags: [] }],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
  // duplicate card id
  assertRefused(store, storage, validBlob({
    cards: [
      { id: 'dup', column_id: 'todo', order: 'V', version: 1, deleted_at: null, tags: [] },
      { id: 'dup', column_id: 'todo', order: 'W', version: 1, deleted_at: null, tags: [] },
    ],
    tags: [], columns: oneCol,
  }), 'invalid_blob');
});

test('validator parity: a blob load() refuses is refused identically by hydrate (shared validateBlob)', () => {
  const bad = validBlob({
    cards: [{ id: 'x', column_id: 'todo', order: 'V', version: 1, deleted_at: null, tags: ['ghost'] }],
    tags: [], columns: [{ id: 'todo', label: 'T', accentKey: 'ice' }],
  });

  // load() reading this persisted blob refuses it, with nothing in memory.
  const storage = makeStorage({ [STORAGE_KEY]: JSON.stringify(bad) });
  const { store } = freshStore({ storage });
  const loadErr = grab(() => store.load());
  assert.equal(loadErr.code, 'invalid_blob', 'load refuses the dangling-ref blob');
  assert.equal(store.isLoaded(), false, 'nothing loaded into memory on refusal');

  // hydrate on a healthy store refuses the SAME blob with the SAME code.
  const { store: store2 } = freshStore();
  store2.create({ id: 'a', title: 'A', column_id: 'todo' });
  assert.equal(grab(() => store2.hydrate(bad)).code, 'invalid_blob', 'hydrate refuses identically');

  // and the shared helper called directly.
  assert.equal(grab(() => validateBlob(bad)).code, 'invalid_blob');
  assert.doesNotThrow(() => validateBlob(validBlob()), 'a valid blob passes the shared validator');
});
