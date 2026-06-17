/**
 * Spine boundary projections — ingest (Hermes→spine) + render (spine→Kanbantt).
 *
 * Asserts each schema row (both disambiguated branches for ingest), the render
 * map, the LOAD-BEARING render test (an escalated fork with a resolved Escalation
 * renders to its ADVANCED column via the MI-3 effective state — NOT blocked, with
 * a raw-state RED contrast), and the ingest→render round-trip composition.
 *
 * Run:  node --test src/lib/spine-projections.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeBlobs } from './sync-merge.js';
import { baseId } from './spine-mi3-restoration.js';
import { ingestState, columnForState, renderColumn, KANBANTT_COLUMNS } from './spine-projections.js';

const TS = '2026-06-16T00:00:00.000Z';
const task = (id, state, version, extra = {}) => ({ id, state, version, deleted_at: null, ...extra });
const esc = (id, task_id, version, extra = {}) => ({ id, task_id, version, resolved_at: null, deleted_at: null, ...extra });
const resolvedEsc = (id, task_id, version, extra = {}) => esc(id, task_id, version, { resolved_at: TS, ...extra });
const artifact = (id, task_id, kind) => ({ id, task_id, kind, ref: 'git:deadbee', deleted_at: null });
const blob = (over = {}) => ({ schema_version: 1, seq: 0, projects: [], tasks: [], artifacts: [], escalations: [], ...over });

/* ================================================================== */
/* PART B — INGEST (Hermes → spine), each row + both disambiguations   */
/* ================================================================== */

test('ingest: running -> dispatched; blocked -> escalated', () => {
  assert.equal(ingestState('running', task('T', 'x', '1'), []), 'dispatched');
  assert.equal(ingestState('blocked', task('T', 'x', '1'), []), 'escalated');
});

test('ingest disambiguation: ready/claimed -> tiered IF tier set, else created', () => {
  assert.equal(ingestState('ready', task('T', 'x', '1', { tier: null }), []), 'created');
  assert.equal(ingestState('ready', task('T', 'x', '1', { tier: 'tier-2' }), []), 'tiered');
  assert.equal(ingestState('claimed', task('T', 'x', '1', { tier: null }), []), 'created');
  assert.equal(ingestState('claimed', task('T', 'x', '1', { tier: 'tier-4' }), []), 'tiered');
});

test('ingest disambiguation: done -> delivered IF a kind:delivery Artifact exists, else judged', () => {
  const t = task('T', 'x', '1');
  // no delivery receipt → judged
  assert.equal(ingestState('done', t, [artifact('a1', 'T', 'verdict')]), 'judged');
  assert.equal(ingestState('done', t, []), 'judged');
  // delivery receipt present → delivered (this is why verdict ≠ delivery)
  assert.equal(ingestState('done', t, [artifact('a1', 'T', 'verdict'), artifact('a2', 'T', 'delivery')]), 'delivered');
  // a tombstoned delivery receipt does NOT count
  assert.equal(ingestState('done', t, [{ ...artifact('a2', 'T', 'delivery'), deleted_at: TS }]), 'judged');
});

test('ingest: an unknown Hermes state is rejected (boundary is total over the known rows)', () => {
  assert.throws(() => ingestState('frobnicated', task('T', 'x', '1'), []), (e) => e.code === 'unknown_hermes_state');
});

/* ================================================================== */
/* PART C — RENDER (spine → Kanbantt), the state→column map            */
/* ================================================================== */

test('render map: each ratified spine state → its reserved column', () => {
  assert.equal(columnForState('created'), 'todo');
  assert.equal(columnForState('tiered'), 'todo');
  assert.equal(columnForState('dispatched'), 'in_progress');
  assert.equal(columnForState('judged'), 'in_progress');
  assert.equal(columnForState('escalated'), 'blocked');
  assert.equal(columnForState('delivered'), 'done');
  assert.equal(columnForState('deleted'), null, 'fully-tombstoned task is off-board');
  for (const s of ['created', 'tiered', 'dispatched', 'judged', 'escalated', 'delivered']) {
    assert.ok(KANBANTT_COLUMNS.has(columnForState(s)), `${s} maps into a reserved column`);
  }
});

test('renderColumn goes through the effective state: a live-escalation Task renders blocked', () => {
  const b = blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'v0')] });
  assert.equal(renderColumn(b, 'T'), 'blocked');
});

/* ── THE LOAD-BEARING RENDER TEST ─────────────────────────────────── */
// A naive render that reads RAW Task.state: an escalated fork → blocked tray.
function naiveRenderRawColumn(b, taskId) {
  const forks = (b.tasks || []).filter((t) => baseId(t.id) === taskId && t.deleted_at == null);
  if (forks.some((t) => t.state === 'escalated')) return 'blocked'; // raw escalated → blocked, ignores escalations
  return columnForState(forks[0] ? forks[0].state : 'deleted');
}

test('LOAD-BEARING: escalated-fork + resolved-Escalation renders to the ADVANCED column (done), NOT blocked; raw-state render is RED', () => {
  // The MI-3 L1 converged shape, reached by a real concurrent merge.
  const a = blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'va')] });
  const bClient = blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] });
  const m = mergeBlobs(a, bClient);

  // sanity: the raw converged state really has an escalated fork (the trap)
  assert.ok(m.tasks.some((t) => baseId(t.id) === 'T' && t.state === 'escalated'), 'raw escalated fork present');

  // GREEN: render goes through the MI-3 effective state (delivered) → done.
  assert.equal(renderColumn(m, 'T'), 'done', 'renders the advanced column, escalation is over');

  // RED contrast: a render reading raw Task.state puts the escalated fork in blocked.
  assert.equal(naiveRenderRawColumn(m, 'T'), 'blocked', 'CONTRAST: raw-state render → blocked (the stuck tray the MI-3 path fixes)');
  assert.notEqual(renderColumn(m, 'T'), naiveRenderRawColumn(m, 'T'), 'render path diverges from raw-state — it consumes resolveTaskLiveState');
});

test('render: a fully-tombstoned Task is off-board (null), not a column', () => {
  const b = blob({ tasks: [{ ...task('T', 'dispatched', 'v0'), deleted_at: TS }] });
  assert.equal(renderColumn(b, 'T'), null);
});

/* ================================================================== */
/* ROUND-TRIP — the two tables compose (Hermes → spine → Kanbantt)     */
/* ================================================================== */

test('round-trip: ingest then render lands in the schema-composed column', () => {
  // Hermes running → spine dispatched → Kanbantt in_progress
  {
    const s = ingestState('running', task('T', 'x', '1'), []);
    const b = blob({ tasks: [task('T', s, 'v')] });
    assert.equal(s, 'dispatched');
    assert.equal(renderColumn(b, 'T'), 'in_progress');
  }
  // Hermes ready (tier set) → spine tiered → Kanbantt todo
  {
    const s = ingestState('ready', task('T', 'x', '1', { tier: 'tier-2' }), []);
    const b = blob({ tasks: [task('T', s, 'v', { tier: 'tier-2' })] });
    assert.equal(s, 'tiered');
    assert.equal(renderColumn(b, 'T'), 'todo');
  }
  // Hermes done (delivery receipt) → spine delivered → Kanbantt done
  {
    const s = ingestState('done', task('T', 'x', '1'), [artifact('a', 'T', 'delivery')]);
    const b = blob({ tasks: [task('T', s, 'v')], artifacts: [artifact('a', 'T', 'delivery')] });
    assert.equal(s, 'delivered');
    assert.equal(renderColumn(b, 'T'), 'done');
  }
  // Hermes done (no delivery) → spine judged → Kanbantt in_progress
  {
    const s = ingestState('done', task('T', 'x', '1'), [artifact('a', 'T', 'verdict')]);
    const b = blob({ tasks: [task('T', s, 'v')] });
    assert.equal(s, 'judged');
    assert.equal(renderColumn(b, 'T'), 'in_progress');
  }
  // Hermes blocked → spine escalated → Kanbantt blocked (MI-3: needs a live Escalation)
  {
    const s = ingestState('blocked', task('T', 'x', '1'), []);
    const b = blob({ tasks: [task('T', s, 'v')], escalations: [esc('E', 'T', 'v')] });
    assert.equal(s, 'escalated');
    assert.equal(renderColumn(b, 'T'), 'blocked');
  }
});
