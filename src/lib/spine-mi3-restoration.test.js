/**
 * MI-3 read-layer restoration — TOTALITY proof over the conflict-fork shapes.
 *
 * Extends the spine convergence matrix. Proves the read-layer rule
 * resolveTaskLiveState (spine-mi3-restoration.js) is TOTAL over every converged
 * shape a concurrent Escalation-resolution can produce through the schema-dumb
 * merge (sync-merge.js, UNTOUCHED): for each reachable shape it returns exactly
 * one defined presentation state, the state the MI-3 biconditional requires, and
 * the SAME state in both merge orders (commutativity carried through to the
 * projection, not just the raw blob).
 *
 * The merge is NOT modified — enforcing MI-3 inside it is the R3 violation this
 * read-layer approach exists to avoid. This file is additive (new sibling).
 *
 * Run:  node --test src/lib/spine-mi3-restoration.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, mergeBlobs } from './sync-merge.js';
import {
  resolveTaskLiveState,
  projectTask,
  hasLiveEscalation,
  baseId,
  TASK_RANK,
  EFFECTIVE_STATES,
} from './spine-mi3-restoration.js';

const eq = (x, y) => canonicalize(x) === canonicalize(y);
const TS = '2026-06-16T00:00:00.000Z';

/* ------------------------------------------------------------------ */
/* Builders — minimal Task / Escalation shapes                         */
/* ------------------------------------------------------------------ */
const task = (id, state, version, extra = {}) => ({ id, state, version, deleted_at: null, ...extra });
const deadTask = (id, state, version, extra = {}) => task(id, state, version, { deleted_at: TS, ...extra });
const esc = (id, task_id, version, extra = {}) => ({ id, task_id, version, resolved_at: null, deleted_at: null, ...extra });
const resolvedEsc = (id, task_id, version, extra = {}) => esc(id, task_id, version, { resolved_at: TS, ...extra });
const deadEsc = (id, task_id, version, extra = {}) => esc(id, task_id, version, { deleted_at: TS, ...extra });

const blob = (over = {}) => ({
  schema_version: 1, seq: 0, projects: [], tasks: [], artifacts: [], escalations: [], ...over,
});

/* Merge a concurrent client pair through BOTH orders; assert the raw blob and
 * the projected presentation state both converge order-independently; return the
 * agreed presentation state (and the converged blob for raw-shape assertions). */
function bothOrders(clientA, clientB, taskId) {
  const ab = mergeBlobs(clientA, clientB);
  const ba = mergeBlobs(clientB, clientA);
  assert.ok(eq(ab, ba), 'raw blob converges identically in both merge orders');
  const pAB = projectTask(ab, taskId);
  const pBA = projectTask(ba, taskId);
  assert.equal(pAB, pBA, 'presentation state is order-independent (commutativity through the projection)');
  assert.ok(typeof pAB === 'string' && pAB.length > 0, 'presentation is a defined non-empty state');
  return { state: pAB, blob: ab };
}

/* ================================================================== */
/* THE TOTALITY MATRIX — {Task-side} x {Escalation-side}, reachable     */
/* combos produced by two clients concurrently editing then merging.    */
/* Each case names the converged shape and its biconditionally-correct   */
/* presentation. T = 'T' in every case.                                  */
/* ================================================================== */
const MATRIX = [
  // ── single Task × escalation states ──────────────────────────────
  {
    name: 'single escalated + 1 live escalation -> escalated',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'v0')] }),
    expect: 'escalated',
  },
  {
    name: 'single escalated + 1 RESOLVED escalation -> dispatched (block lifted)',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'v0')] }),
    expect: 'dispatched',
  },
  {
    name: 'single escalated + 1 TOMBSTONED escalation -> dispatched',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [deadEsc('E', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [deadEsc('E', 'T', 'v0')] }),
    expect: 'dispatched',
  },
  {
    name: 'single escalated + ZERO escalations -> dispatched (degenerate raw, not blocked)',
    a: blob({ tasks: [task('T', 'escalated', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')] }),
    expect: 'dispatched',
  },
  {
    name: 'single advanced (delivered) + ZERO escalations -> delivered',
    a: blob({ tasks: [task('T', 'delivered', 'v0')] }),
    b: blob({ tasks: [task('T', 'delivered', 'v0')] }),
    expect: 'delivered',
  },
  {
    name: 'single dispatched + ZERO escalations -> dispatched',
    a: blob({ tasks: [task('T', 'dispatched', 'v0')] }),
    b: blob({ tasks: [task('T', 'dispatched', 'v0')] }),
    expect: 'dispatched',
  },
  {
    name: 'single tiered + ZERO escalations -> tiered',
    a: blob({ tasks: [task('T', 'tiered', 'v0')] }),
    b: blob({ tasks: [task('T', 'tiered', 'v0')] }),
    expect: 'tiered',
  },

  // ── Task CONFLICT-FORK (escalated + advanced) × escalation states ─
  {
    // fork advanced on one branch, but the escalation is STILL live -> escalated.
    // Proves the projection reads escalations, not just the task forks.
    name: 'fork {escalated, delivered} + LIVE escalation -> escalated',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [esc('E', 'T', 'v0')] }),
    expect: 'escalated',
  },
  {
    // LOAD-BEARING L1: escalation resolved on BOTH branches, task forked
    // escalated/delivered -> delivered (escalation over, NOT stuck escalated).
    name: 'fork {escalated, delivered} + escalation RESOLVED (all forks) -> delivered [L1]',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'va')] }),
    b: blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] }),
    expect: 'delivered',
  },
  {
    name: 'fork {escalated, judged} + escalation RESOLVED -> judged',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'va')] }),
    b: blob({ tasks: [task('T', 'judged', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] }),
    expect: 'judged',
  },
  {
    // LOAD-BEARING L2 (the subtle reduction): the escalation CONFLICT-FORKS into
    // {live, resolved} (one client edited its note, the other resolved it). The
    // task forked escalated/delivered. The grouped-liveness reduction treats the
    // resolved fork as terminal -> NOT live -> delivered.
    name: 'fork {escalated, delivered} + escalation forked {live, resolved} -> delivered [L2]',
    a: blob({ tasks: [task('T', 'escalated', 'va')], escalations: [esc('E', 'T', 'va', { note: 'A' })] }),
    b: blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] }),
    expect: 'delivered',
  },

  // ── Escalation-only divergence × single Task ─────────────────────
  {
    name: 'single escalated + escalation forked {live, resolved} -> dispatched (reduction)',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'va', { note: 'A' })] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'vb')] }),
    expect: 'dispatched',
  },
  {
    name: 'multiple escalations: one LIVE + one resolved -> escalated',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E1', 'T', 'v0'), resolvedEsc('E2', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E1', 'T', 'v0'), resolvedEsc('E2', 'T', 'v0')] }),
    expect: 'escalated',
  },
  {
    name: 'multiple escalations: ALL resolved -> dispatched',
    a: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E1', 'T', 'v0'), resolvedEsc('E2', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E1', 'T', 'v0'), resolvedEsc('E2', 'T', 'v0')] }),
    expect: 'dispatched',
  },

  // ── Task DELETION forks ──────────────────────────────────────────
  {
    // delete on one branch, advance on the other -> tomb wins base slot, advanced
    // fork preserved as conflict copy; projection takes the live (advanced) fork.
    name: 'delete-vs-advance fork {tomb, delivered} + no escalation -> delivered',
    a: blob({ tasks: [deadTask('T', 'dispatched', 'va')] }),
    b: blob({ tasks: [task('T', 'delivered', 'vb')] }),
    expect: 'delivered',
  },
  {
    name: 'delete on BOTH branches -> deleted',
    a: blob({ tasks: [deadTask('T', 'dispatched', 'va')] }),
    b: blob({ tasks: [deadTask('T', 'dispatched', 'vb')] }),
    expect: 'deleted',
  },
  {
    // partial delete + LIVE escalation: a live escalation keeps the surviving
    // (escalated) fork on-board as escalated (precedence: live escalation > a
    // concurrent delete of the other fork).
    name: 'delete-vs-escalated fork {tomb, escalated} + LIVE escalation -> escalated',
    a: blob({ tasks: [deadTask('T', 'dispatched', 'va')], escalations: [esc('E', 'T', 'v0')] }),
    b: blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [esc('E', 'T', 'v0')] }),
    expect: 'escalated',
  },
];

test('TOTALITY MATRIX: every reachable converged shape resolves to exactly one correct presentation state (both merge orders)', () => {
  for (const c of MATRIX) {
    const { state } = bothOrders(c.a, c.b, 'T');
    assert.equal(state, c.expect, `shape "${c.name}" -> expected ${c.expect}, got ${state}`);
    assert.ok(EFFECTIVE_STATES.has(state), `"${c.name}": ${state} is a defined effective spine state`);
  }
});

test('TOTALITY: resolveTaskLiveState never returns undefined/null and never throws over the matrix', () => {
  for (const c of MATRIX) {
    const m = mergeBlobs(c.a, c.b);
    let state;
    assert.doesNotThrow(() => { state = projectTask(m, 'T'); }, `"${c.name}" must not throw`);
    assert.ok(state !== undefined && state !== null, `"${c.name}" must yield a defined state`);
  }
});

/* ================================================================== */
/* THE LOAD-BEARING CASE + the naive-projection contrasts              */
/* ================================================================== */

// Naive A: read the Task forks directly, ignore the Escalation cross-check.
function naiveByTaskState(taskForks) {
  if ((taskForks || []).some((t) => t.deleted_at == null && t.state === 'escalated')) return 'escalated';
  // (the rest doesn't matter for the contrast)
  return 'not-blocked';
}
// Naive B: check escalations but with STRICT per-row liveness (no grouping
// reduction) — any live row blocks.
function naiveStrictLiveness(escalationsForTask) {
  return (escalationsForTask || []).some((e) => e.resolved_at == null && e.deleted_at == null)
    ? 'escalated'
    : 'not-blocked';
}

test('LOAD-BEARING L1: escalated-fork + resolved-escalation projects ADVANCED (delivered), NOT stuck-blocked; naive-by-task-state is RED', () => {
  const a = blob({ tasks: [task('T', 'escalated', 'v0')], escalations: [resolvedEsc('E', 'T', 'va')] });
  const b = blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] });
  const m = mergeBlobs(a, b);

  // Prove the converged RAW shape is the load-bearing one: an 'escalated' fork
  // exists AND no live escalation remains.
  const taskForks = m.tasks.filter((t) => baseId(t.id) === 'T');
  const escs = m.escalations.filter((e) => e.task_id === 'T');
  assert.ok(taskForks.some((t) => t.state === 'escalated'), 'raw state still has an escalated fork');
  assert.equal(hasLiveEscalation(escs), false, 'no live escalation remains after resolution');

  // GREEN: restoration resolves the transient violation to the advanced state.
  assert.equal(projectTask(m, 'T'), 'delivered', 'restoration -> delivered (escalation is over)');

  // RED: the naive projection (read task.state, ignore escalations) sticks at blocked.
  assert.equal(naiveByTaskState(taskForks), 'escalated', 'CONTRAST: naive-by-task-state projects blocked — the stuck-block the rule must fix');
  assert.notEqual(projectTask(m, 'T'), naiveByTaskState(taskForks), 'restoration diverges from the naive projection — the rule does real work');
});

test('LOAD-BEARING L2: escalation forked {live, resolved} still unblocks; naive STRICT-liveness is RED (proves the grouping reduction bites)', () => {
  const a = blob({ tasks: [task('T', 'escalated', 'va')], escalations: [esc('E', 'T', 'va', { note: 'A' })] });
  const b = blob({ tasks: [task('T', 'delivered', 'vb')], escalations: [resolvedEsc('E', 'T', 'vb')] });
  const m = mergeBlobs(a, b);

  const escs = m.escalations.filter((e) => e.task_id === 'T');
  // The escalation genuinely forked into a live + a resolved row.
  assert.ok(escs.length >= 2, 'escalation conflict-forked into multiple rows');
  assert.ok(escs.some((e) => e.resolved_at == null) && escs.some((e) => e.resolved_at != null), 'one live fork AND one resolved fork present');

  // GREEN: grouped-liveness reduction treats the resolved fork as terminal.
  assert.equal(hasLiveEscalation(escs), false, 'grouped reduction: escalation is NOT live (a resolved fork is terminal)');
  assert.equal(projectTask(m, 'T'), 'delivered', 'restoration -> delivered');

  // RED: strict per-row liveness sees the live fork and blocks.
  assert.equal(naiveStrictLiveness(escs), 'escalated', 'CONTRAST: strict per-row liveness projects blocked — the reduction is what unblocks it');
  assert.notEqual(projectTask(m, 'T'), 'escalated', 'restoration is NOT blocked');
});

/* ================================================================== */
/* Direct unit coverage of the rule's pieces (defined + deterministic) */
/* ================================================================== */

test('hasLiveEscalation: grouping + terminal-reduction semantics', () => {
  assert.equal(hasLiveEscalation([]), false, 'zero escalations -> not live');
  assert.equal(hasLiveEscalation([esc('E', 'T', '1')]), true, 'one live -> live');
  assert.equal(hasLiveEscalation([resolvedEsc('E', 'T', '1')]), false, 'one resolved -> not live');
  assert.equal(hasLiveEscalation([deadEsc('E', 'T', '1')]), false, 'one tombstoned -> not live');
  assert.equal(
    hasLiveEscalation([esc('E', 'T', 'a'), { ...resolvedEsc('E', 'T', 'b'), id: 'E.conflict.deadbeef' }]),
    false,
    'forked {live, resolved} under the same base id -> NOT live (terminal reduction)',
  );
  assert.equal(
    hasLiveEscalation([esc('E1', 'T', '1'), resolvedEsc('E2', 'T', '1')]),
    true,
    'two distinct escalations, one live -> live',
  );
});

test('resolveTaskLiveState is total on degenerate inputs (no throw, defined state)', () => {
  assert.equal(resolveTaskLiveState([], []), 'deleted', 'no live task fork -> deleted');
  assert.equal(resolveTaskLiveState([task('T', 'escalated', '1')], []), 'dispatched', 'escalated + no esc -> in_progress');
  assert.equal(resolveTaskLiveState([task('T', undefined, '1')], []), 'created', 'missing state -> created (defined)');
  // unknown state passes through as itself, never undefined
  assert.equal(resolveTaskLiveState([task('T', 'archived_weird', '1')], []), 'archived_weird', 'unknown state -> itself, total');
  assert.ok(TASK_RANK.delivered > TASK_RANK.escalated, 'rank sanity');
});
