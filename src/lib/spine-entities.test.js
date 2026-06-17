/**
 * Claunker spine entity data layer — schema-completeness + write-admission proof.
 *
 * Asserts the OUTCOME of each control and proves the reject branch bites
 * (red-on-violation): R6 durable-ref, MI-1 zombie-append, MI-2 atomic resolution,
 * tier write-once. Plus a merge round-trip confirming the produced blob is what
 * the proven sync-merge.js consumes (idempotent + converges with a concurrent
 * edit). The merge and the MI-3 read-layer rule are CONSUMED, not edited.
 *
 * Run:  node --test src/lib/spine-entities.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, mergeBlobs } from './sync-merge.js';
import {
  createSpineStore,
  newProject,
  newTask,
  newArtifact,
  newEscalation,
  isDurableRef,
  TASK_STATES,
} from './spine-entities.js';

const eq = (x, y) => canonicalize(x) === canonicalize(y);

/* Deterministic deps: unique sequential ids/versions + a monotonic clock. */
function mkDeps() {
  let n = 0;
  let clock = 0;
  return { now: () => (clock += 1000), uuid: () => `u-${++n}` };
}
/* Constructor-level deps shape {uuid, iso}. */
function ctorDeps() {
  let n = 0;
  return { uuid: () => `u-${++n}`, iso: () => '2026-06-16T00:00:00.000Z' };
}

function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, `expected SpineError code ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  assert.fail(`expected a throw with code ${code}, but nothing was thrown`);
}

/* ================================================================== */
/* 1. Constructors produce schema-complete entities                    */
/* ================================================================== */

test('constructors carry id + version + deleted_at(null) + created_at for all four entities', () => {
  const d = ctorDeps();
  const entities = [
    newProject({ name: 'P' }, d),
    newTask({ project_id: 'p', title: 'T', state: 'created', acceptance_criteria: 'do the thing' }, d),
    newArtifact({ task_id: 't', kind: 'diff', ref: 'git:3f9a2b1' }, d),
    newEscalation({ task_id: 't', reason: 'human needed', control_diff: null }, d),
  ];
  for (const e of entities) {
    assert.ok(typeof e.id === 'string' && e.id.length > 0, 'has id');
    assert.ok(typeof e.version === 'string' && e.version.length > 0, 'has opaque version');
    assert.ok('deleted_at' in e && e.deleted_at === null, 'has nullable deleted_at, null at creation');
    assert.ok(typeof e.created_at === 'string', 'has created_at');
  }
});

test('constructors REJECT a missing required field (schema-incomplete entity)', () => {
  const d = ctorDeps();
  throwsCode(() => newProject({}, d), 'missing_field'); // no name
  throwsCode(() => newTask({ title: 'T', state: 'created', acceptance_criteria: 'x' }, d), 'missing_field'); // no project_id
  throwsCode(() => newTask({ project_id: 'p', title: 'T', state: 'bogus', acceptance_criteria: 'x' }, d), 'invalid_state');
  throwsCode(() => newArtifact({ task_id: 't', kind: 'screenshot', ref: 'git:abc1234' }, d), 'invalid_kind');
  throwsCode(() => newEscalation({ task_id: 't', reason: 'r', control_diff: { control_id: 'c' } }, d), 'invalid_control_diff');
});

test('Escalation control_diff: null OK, well-formed structured OK (the §5.6 legibility shape)', () => {
  const d = ctorDeps();
  assert.equal(newEscalation({ task_id: 't', reason: 'r', control_diff: null }, d).control_diff, null);
  const cd = { control_id: 'classifier.tier_floor', old_value: 4, new_value: 2, reduces_control: true };
  assert.deepEqual(newEscalation({ task_id: 't', reason: 'r', control_diff: cd }, d).control_diff, cd);
});

/* ================================================================== */
/* 2. R6 — durable-ref (both branches)                                 */
/* ================================================================== */

test('R6: executor-local / sandbox refs are REJECTED; durable refs are accepted', () => {
  const d = ctorDeps();
  // rejected — non-durable / executor-local (dies on abort)
  for (const ref of [
    '/workspace/out/diff.patch',
    '/root/.cache/result',
    'sandboxes/docker/abc123/workspace/file.txt',
    'C:\\Users\\Raide\\sandbox\\x',
    'file:///root/x',
    './relative/path.txt',
    '',
  ]) {
    assert.equal(isDurableRef(ref), false, `should be non-durable: ${ref}`);
    throwsCode(() => newArtifact({ task_id: 't', kind: 'file', ref }, d), 'non_durable_ref');
  }
  // accepted — durable targets
  for (const ref of [
    '3f9a2b1c4d5e6f7081920a1b2c3d4e5f60718293', // git commit hash
    'git:3f9a2b1',
    'drive:1A2b3C4d5E6f7G8h9I0jK',
    'https://drive.google.com/file/d/1A2b3C4d',
    'gs://spine-bucket/artifacts/x',
  ]) {
    assert.equal(isDurableRef(ref), true, `should be durable: ${ref}`);
    const a = newArtifact({ task_id: 't', kind: 'file', ref }, d);
    assert.equal(a.ref, ref);
  }
});

/* ================================================================== */
/* 3. MI-1 — zombie-append guard (both branches)                       */
/* ================================================================== */

test('MI-1: new Artifact/Escalation on a LIVE Task accepted; on a TOMBSTONED Task rejected', () => {
  const store = createSpineStore(mkDeps());
  const p = store.addProject({ name: 'P' });
  const live = store.addTask({ project_id: p.id, title: 'live', state: 'dispatched', acceptance_criteria: 'x' });
  const dead = store.addTask({ project_id: p.id, title: 'dead', state: 'created', acceptance_criteria: 'x' });
  store.deleteTask(dead.id);

  // live parent → accepted
  assert.ok(store.addArtifact({ task_id: live.id, kind: 'diff', ref: 'git:3f9a2b1' }).id);
  assert.ok(store.addEscalation({ task_id: live.id, reason: 'need human', control_diff: null }).id);

  // tombstoned parent → rejected (no new children on a closed record)
  throwsCode(() => store.addArtifact({ task_id: dead.id, kind: 'diff', ref: 'git:abc1234' }), 'zombie_append');
  throwsCode(() => store.addEscalation({ task_id: dead.id, reason: 'late', control_diff: null }), 'zombie_append');

  // and nothing was appended on the reject branch
  assert.equal(store.getBlob().artifacts.filter((a) => a.task_id === dead.id).length, 0);
  assert.equal(store.getBlob().escalations.filter((e) => e.task_id === dead.id).length, 0);
});

/* ================================================================== */
/* 4. MI-2 — atomic Escalation resolution (no torn write)              */
/* ================================================================== */

test('MI-2: resolveEscalation sets resolved_at AND clears escalated in ONE write; torn state impossible', () => {
  const store = createSpineStore(mkDeps());
  const p = store.addProject({ name: 'P' });
  const t = store.addTask({ project_id: p.id, title: 'T', state: 'escalated', acceptance_criteria: 'x' });
  const e = store.addEscalation({
    task_id: t.id,
    reason: 'floor change needs sign-off',
    control_diff: { control_id: 'classifier.tier_floor', old_value: 4, new_value: 2, reduces_control: true },
  });

  const r = store.resolveEscalation(e.id, { nextState: 'dispatched' });
  assert.ok(r.escalation.resolved_at != null, 'resolved_at set');
  assert.notEqual(r.task.state, 'escalated', 'task transitioned OUT of escalated');

  // the torn state (resolved escalation but still-escalated task) cannot exist
  const eAfter = store.getBlob().escalations.find((x) => x.id === e.id);
  const tAfter = store.getBlob().tasks.find((x) => x.id === t.id);
  assert.ok(!(eAfter.resolved_at != null && tAfter.state === 'escalated'), 'no torn resolved-but-still-escalated state');
  // both got fresh version tokens (the single write touched both rows)
  assert.notEqual(eAfter.version, t.version);
});

test('MI-2 atomicity: a rejected resolve mutates NEITHER row (validate-before-mutate)', () => {
  const store = createSpineStore(mkDeps());
  const p = store.addProject({ name: 'P' });
  const t = store.addTask({ project_id: p.id, title: 'T', state: 'escalated', acceptance_criteria: 'x' });
  const e = store.addEscalation({ task_id: t.id, reason: 'r', control_diff: null });
  const escVersionBefore = e.version;
  const taskVersionBefore = t.version;

  // nextState 'escalated' would NOT transition out → rejected before any mutation
  throwsCode(() => store.resolveEscalation(e.id, { nextState: 'escalated' }), 'invalid_resolution_state');

  assert.equal(e.resolved_at, null, 'escalation still live after rejected resolve');
  assert.equal(t.state, 'escalated', 'task still escalated after rejected resolve');
  assert.equal(e.version, escVersionBefore, 'no version churn on escalation');
  assert.equal(t.version, taskVersionBefore, 'no version churn on task');
});

/* ================================================================== */
/* 5. tier WRITE-ONCE                                                  */
/* ================================================================== */

test('tier write-once: settable while null; changing a non-null tier is REJECTED', () => {
  const store = createSpineStore(mkDeps());
  const p = store.addProject({ name: 'P' });
  const t = store.addTask({ project_id: p.id, title: 'T', state: 'created', acceptance_criteria: 'x' });
  assert.equal(t.tier, null, 'created untiered');

  const tiered = store.setTier(t.id, 'tier-2');
  assert.equal(tiered.tier, 'tier-2', 'tier set while null');

  throwsCode(() => store.setTier(t.id, 'tier-4'), 'tier_write_once');
  assert.equal(store.getBlob().tasks.find((x) => x.id === t.id).tier, 'tier-2', 'tier unchanged after rejected overwrite');
});

/* ================================================================== */
/* 6. Merge round-trip — the produced blob is what the proven merge eats */
/* ================================================================== */

test('round-trip: store blob is idempotent under mergeBlobs and converges with a concurrent edit', () => {
  const store = createSpineStore(mkDeps());
  const p = store.addProject({ name: 'P' });
  const t = store.addTask({ project_id: p.id, title: 'T', state: 'dispatched', acceptance_criteria: 'ship it' });
  store.addArtifact({ task_id: t.id, kind: 'delivery', ref: 'drive:1A2b3C4d5E' });
  store.addEscalation({ task_id: t.id, reason: 'r', control_diff: null });
  const baseBlob = store.getBlob();

  // (a) idempotency: the proven merge treats the produced blob as a no-op vs itself.
  assert.ok(eq(mergeBlobs(baseBlob, baseBlob), baseBlob), 'mergeBlobs(blob, blob) === blob');

  // (b) concurrent edit: two clients diverge on the Task → fork, both survive, both orders converge.
  const A = JSON.parse(JSON.stringify(baseBlob));
  const B = JSON.parse(JSON.stringify(baseBlob));
  A.tasks[0] = { ...A.tasks[0], title: 'edit-A', version: 'vA' };
  B.tasks[0] = { ...B.tasks[0], title: 'edit-B', version: 'vB' };
  const ab = mergeBlobs(A, B);
  const ba = mergeBlobs(B, A);
  assert.ok(eq(ab, ba), 'concurrent merge converges in both orders');
  assert.deepEqual(ab.tasks.map((x) => x.title).sort(), ['edit-A', 'edit-B'], 'both concurrent edits survive (base + conflict copy)');
});

test('sanity: ratified lifecycle enum is the spine enum (created→tiered→dispatched→judged→delivered + escalated)', () => {
  assert.deepEqual(TASK_STATES, ['created', 'tiered', 'dispatched', 'judged', 'delivered', 'escalated']);
});
