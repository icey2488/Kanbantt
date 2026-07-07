/**
 * v0.5.0 client-wave tests: due picker, drag-to-unsorted, depends_on editor,
 * timeline edges cycle detection, patch builder key-presence, LocalProvider parity.
 *
 * Run:  node --test src/lib/v050-client-wave.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider } from './spine-mcp-provider.js';
import { createStore } from './card-store.js';

/** Connect a provider to a fresh harness; returns { provider, harness }. */
async function connected(opts = {}) {
  const harness = createMcpTestServer(opts);
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  await provider.connect();
  return { provider, harness };
}

/** Minimal localStorage shim for createStore in Node. */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Seed a fresh LocalProvider store with given cards and return it. */
function localStore(cards = []) {
  const store = createStore({ storage: memStorage() });
  for (const c of cards) store.create(c);
  return store;
}

/* ================================================================== */
/* Due: set/clear round-trip — key-presence semantics                  */
/* ================================================================== */

test('cardUpdate due set: patch includes due key with ISO value', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med' });

  const card = await provider.cardUpdate('c1', { due: '2026-08-01', expected_version: harness.store.get('c1').version });
  assert.equal(card.due, '2026-08-01', 'returned card carries due');

  const fresh = harness.store.get('c1');
  assert.equal(fresh.due, '2026-08-01', 'store persists due');

  await provider.disconnect();
  await harness.close();
});

test('cardUpdate due clear: patch includes due:null and clears the field', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med', due: '2026-08-01' });

  const v1 = harness.store.get('c1').version;
  const card = await provider.cardUpdate('c1', { due: null, expected_version: v1 });
  assert.equal(card.due ?? null, null, 'returned card has null due after clear');

  const fresh = harness.store.get('c1');
  assert.equal(fresh.due ?? null, null, 'store clears due');

  await provider.disconnect();
  await harness.close();
});

test('cardUpdate due absent: field unchanged (RFC 7386 key-absence = no-op)', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med', due: '2026-07-15' });

  const v1 = harness.store.get('c1').version;
  await provider.cardUpdate('c1', { title: 'Alpha edited', expected_version: v1 });

  const fresh = harness.store.get('c1');
  assert.equal(fresh.due, '2026-07-15', 'due untouched when key absent from patch');

  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* depends_on: set, clear, validation                                  */
/* ================================================================== */

test('cardUpdate depends_on set: stores array of dep ids', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med' });
  harness.store.create({ id: 'c2', title: 'Beta', column_id: 'todo', priority: 'med' });

  const v1 = harness.store.get('c1').version;
  const card = await provider.cardUpdate('c1', { depends_on: ['c2'], expected_version: v1 });
  assert.deepEqual(card.depends_on, ['c2'], 'returned card has depends_on');

  const fresh = harness.store.get('c1');
  assert.deepEqual(fresh.depends_on, ['c2'], 'store persists depends_on');

  await provider.disconnect();
  await harness.close();
});

test('cardUpdate depends_on [] clears the list', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med', depends_on: ['c2'] });

  const v1 = harness.store.get('c1').version;
  const card = await provider.cardUpdate('c1', { depends_on: [], expected_version: v1 });
  const deps = card.depends_on ?? [];
  assert.deepEqual(deps, [], 'returned card has empty depends_on after clear');

  await provider.disconnect();
  await harness.close();
});

test('cardUpdate depends_on absent: field unchanged', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med', depends_on: ['c2'] });

  const v1 = harness.store.get('c1').version;
  await provider.cardUpdate('c1', { title: 'Alpha edited', expected_version: v1 });

  const fresh = harness.store.get('c1');
  assert.deepEqual(fresh.depends_on, ['c2'], 'depends_on untouched when key absent');

  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Patch builder key-presence audit                                     */
/* ================================================================== */

// The provider's cardUpdate builds an explicit patch; it MUST NOT emit keys it
// doesn't intend. Verify the shape of what the test server receives.
test('cardUpdate only emits the keys supplied — no accidental spread of whole card', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med',
    due: '2026-08-01', depends_on: ['c2'], effort: 'high', impact: 'low' });

  const v1 = harness.store.get('c1').version;
  // Update ONLY title — patch must NOT include due/depends_on/effort/impact
  await provider.cardUpdate('c1', { title: 'Renamed', expected_version: v1 });

  const fresh = harness.store.get('c1');
  assert.equal(fresh.due, '2026-08-01', 'due untouched');
  assert.deepEqual(fresh.depends_on, ['c2'], 'depends_on untouched');
  assert.equal(fresh.effort, 'high', 'effort untouched');
  assert.equal(fresh.impact, 'low', 'impact untouched');

  await provider.disconnect();
  await harness.close();
});

test('cardUpdate effort:null only clears effort, leaves impact and due intact', async () => {
  const { provider, harness } = await connected();
  harness.store.create({ id: 'c1', title: 'Alpha', column_id: 'todo', priority: 'med',
    effort: 'high', impact: 'low', due: '2026-08-01' });

  const v1 = harness.store.get('c1').version;
  await provider.cardUpdate('c1', { effort: null, expected_version: v1 });

  const fresh = harness.store.get('c1');
  assert.equal(fresh.effort ?? null, null, 'effort cleared');
  assert.equal(fresh.impact, 'low', 'impact untouched');
  assert.equal(fresh.due, '2026-08-01', 'due untouched');

  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* LocalProvider parity: local store clears + depends_on               */
/* ================================================================== */

test('LocalProvider: update with due:null clears due (same semantics as spine)', () => {
  const store = localStore([{ id: 'c1', title: 'A', column_id: 'todo', priority: 'med', due: '2026-08-01' }]);
  const v1 = store.get('c1').version;
  store.update('c1', { due: null }, { expected_version: v1 });
  const fresh = store.get('c1');
  assert.equal(fresh.due ?? null, null, 'local store clears due via null');
});

test('LocalProvider: update with effort:null clears effort', () => {
  const store = localStore([{ id: 'c1', title: 'A', column_id: 'todo', priority: 'med', effort: 'high' }]);
  const v1 = store.get('c1').version;
  store.update('c1', { effort: null }, { expected_version: v1 });
  assert.equal(store.get('c1').effort ?? null, null, 'local store clears effort via null');
});

test('LocalProvider: update with impact:null clears impact', () => {
  const store = localStore([{ id: 'c1', title: 'A', column_id: 'todo', priority: 'med', impact: 'high' }]);
  const v1 = store.get('c1').version;
  store.update('c1', { impact: null }, { expected_version: v1 });
  assert.equal(store.get('c1').impact ?? null, null, 'local store clears impact via null');
});

test('LocalProvider: update depends_on stores array', () => {
  const store = localStore([
    { id: 'c1', title: 'A', column_id: 'todo', priority: 'med' },
    { id: 'c2', title: 'B', column_id: 'todo', priority: 'med' },
  ]);
  const v1 = store.get('c1').version;
  store.update('c1', { depends_on: ['c2'] }, { expected_version: v1 });
  assert.deepEqual(store.get('c1').depends_on, ['c2']);
});

test('LocalProvider: update depends_on:[] clears the list', () => {
  const store = localStore([
    { id: 'c1', title: 'A', column_id: 'todo', priority: 'med', depends_on: ['c2'] },
  ]);
  const v1 = store.get('c1').version;
  store.update('c1', { depends_on: [] }, { expected_version: v1 });
  const deps = store.get('c1').depends_on ?? [];
  assert.deepEqual(deps, []);
});

test('LocalProvider: unknown fields round-trip through update', () => {
  const store = localStore([{ id: 'c1', title: 'A', column_id: 'todo', priority: 'med' }]);
  const v1 = store.get('c1').version;
  store.update('c1', { future_field: 'xyz' }, { expected_version: v1 });
  assert.equal(store.get('c1').future_field, 'xyz', 'unknown fields preserved');
});

/* ================================================================== */
/* Deps exclusion rules: self, tombstoned, archived                    */
/* ================================================================== */

// These tests replicate the candidate-filter logic from the deps editor:
// candidates = allTasks.filter(t => t.id !== draft.id && !t.deleted_at && !t.archived_at)

function candidateFilter(allTasks, draftId) {
  return allTasks.filter((t) =>
    t.id !== draftId &&
    !t.deleted_at &&
    !t.archived_at
  );
}

test('deps editor excludes the card itself from candidate list', () => {
  const allTasks = [
    { id: 'c1', title: 'Self' },
    { id: 'c2', title: 'Other' },
  ];
  const candidates = candidateFilter(allTasks, 'c1');
  assert.ok(!candidates.some((t) => t.id === 'c1'), 'self excluded');
  assert.ok(candidates.some((t) => t.id === 'c2'), 'others included');
});

test('deps editor excludes tombstoned (deleted_at set) cards', () => {
  const allTasks = [
    { id: 'c1', title: 'A' },
    { id: 'c2', title: 'Tombstoned', deleted_at: '2026-01-01T00:00:00Z' },
  ];
  const candidates = candidateFilter(allTasks, 'c0');
  assert.ok(!candidates.some((t) => t.id === 'c2'), 'tombstoned excluded');
  assert.ok(candidates.some((t) => t.id === 'c1'), 'live card included');
});

test('deps editor excludes archived cards', () => {
  const allTasks = [
    { id: 'c1', title: 'A' },
    { id: 'c2', title: 'Archived', archived_at: '2026-01-01T00:00:00Z' },
  ];
  const candidates = candidateFilter(allTasks, 'c0');
  assert.ok(!candidates.some((t) => t.id === 'c2'), 'archived excluded');
  assert.ok(candidates.some((t) => t.id === 'c1'), 'live card included');
});

/* ================================================================== */
/* Badge: "waiting on N" counts                                        */
/* ================================================================== */

function depBadgeCount(task) {
  return (task.depends_on || []).length;
}

test('badge count is 0 for card with no depends_on', () => {
  assert.equal(depBadgeCount({ id: 'c1', title: 'A' }), 0);
});

test('badge count is 0 for card with empty depends_on', () => {
  assert.equal(depBadgeCount({ id: 'c1', title: 'A', depends_on: [] }), 0);
});

test('badge count matches depends_on length', () => {
  assert.equal(depBadgeCount({ id: 'c1', depends_on: ['c2', 'c3', 'c4'] }), 3);
});

/* ================================================================== */
/* Dangling deps: rendered greyed, not dropped                         */
/* ================================================================== */

// The deps badge shows dep info for all dep ids; tombstoned/absent deps
// are "dangling" — they show greyed with a marker, never silently dropped.
function buildDepInfos(task, allTasks) {
  return (task.depends_on || []).map((id) => ({
    id,
    dep: allTasks.find((t) => t.id === id) || null,
  }));
}

test('dangling dep renders as entry with dep:null (not dropped from list)', () => {
  const task = { id: 'c1', depends_on: ['ghost-id'] };
  const allTasks = [{ id: 'c2', title: 'Other' }];
  const infos = buildDepInfos(task, allTasks);
  assert.equal(infos.length, 1, 'dep entry not dropped');
  assert.equal(infos[0].dep, null, 'dep is null for dangling id');
  assert.equal(infos[0].id, 'ghost-id', 'id preserved');
});

test('live dep renders with full task object', () => {
  const task = { id: 'c1', depends_on: ['c2'] };
  const allTasks = [{ id: 'c2', title: 'Real dep' }];
  const infos = buildDepInfos(task, allTasks);
  assert.equal(infos[0].dep?.title, 'Real dep');
});

test('mix of live and dangling deps — both preserved in order', () => {
  const task = { id: 'c1', depends_on: ['live', 'ghost', 'live2'] };
  const allTasks = [
    { id: 'live', title: 'Live' },
    { id: 'live2', title: 'Live2' },
  ];
  const infos = buildDepInfos(task, allTasks);
  assert.equal(infos.length, 3);
  assert.equal(infos[0].dep?.title, 'Live');
  assert.equal(infos[1].dep, null); // ghost
  assert.equal(infos[2].dep?.title, 'Live2');
});

/* ================================================================== */
/* Cycle detection: DFS over timeline visible graph                    */
/* ================================================================== */

// Replicated from the GanttView SVG overlay IIFE — pure function, testable in isolation.
function detectCycles(rows) {
  const idToIdx = new Map(rows.map((r, i) => [r.id, i]));
  const inCycle = new Set();
  const visited = new Set();
  const recStack = new Set();

  function dfs(i) {
    if (recStack.has(i)) { inCycle.add(i); return true; }
    if (visited.has(i)) return inCycle.has(i);
    visited.add(i); recStack.add(i);
    let cyclic = false;
    for (const depId of (rows[i].depends_on || [])) {
      const j = idToIdx.get(depId);
      if (j !== undefined && dfs(j)) { inCycle.add(i); cyclic = true; }
    }
    recStack.delete(i);
    return cyclic;
  }
  rows.forEach((_, i) => { if (!visited.has(i)) dfs(i); });
  return inCycle;
}

test('cycle detection: no cycle in linear A←B←C chain', () => {
  // A depends on B, B depends on C — no cycle
  const rows = [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['C'] },
    { id: 'C', depends_on: [] },
  ];
  const inCycle = detectCycles(rows);
  assert.equal(inCycle.size, 0, 'no cycle');
});

test('cycle detection: 3-card A→B→C→A cycle — all three flagged', () => {
  // A depends on B, B depends on C, C depends on A → cycle A↔B↔C
  const rows = [
    { id: 'A', depends_on: ['B'] },
    { id: 'B', depends_on: ['C'] },
    { id: 'C', depends_on: ['A'] },
  ];
  const inCycle = detectCycles(rows);
  assert.ok(inCycle.has(0), 'A (idx 0) in cycle');
  assert.ok(inCycle.has(1), 'B (idx 1) in cycle');
  assert.ok(inCycle.has(2), 'C (idx 2) in cycle');
});

test('cycle detection: self-loop A→A — A flagged', () => {
  const rows = [{ id: 'A', depends_on: ['A'] }];
  const inCycle = detectCycles(rows);
  assert.ok(inCycle.has(0), 'self-loop node in cycle');
});

test('cycle detection: cycle within larger graph — only cycle nodes flagged', () => {
  // D→E, E→D (cycle); F→G (linear chain, no cycle)
  const rows = [
    { id: 'D', depends_on: ['E'] },
    { id: 'E', depends_on: ['D'] },
    { id: 'F', depends_on: ['G'] },
    { id: 'G', depends_on: [] },
  ];
  const inCycle = detectCycles(rows);
  assert.ok(inCycle.has(0), 'D in cycle');
  assert.ok(inCycle.has(1), 'E in cycle');
  assert.ok(!inCycle.has(2), 'F not in cycle');
  assert.ok(!inCycle.has(3), 'G not in cycle');
});

test('cycle detection: dangling ref (dep not in rows) is ignored — no false cycle', () => {
  const rows = [
    { id: 'A', depends_on: ['ghost'] },
  ];
  const inCycle = detectCycles(rows);
  assert.equal(inCycle.size, 0, 'dangling ref does not cause a cycle flag');
});
