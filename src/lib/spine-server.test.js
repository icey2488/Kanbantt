/**
 * Claunker MCP spine SERVER — the seam, asserted over the proven layers.
 *
 * Proves the method surface ASSEMBLES the proven parts correctly (no new domain
 * logic): writes route through the entity layer, reads through the projections
 * (effective state, never raw), persistence is a separate Drive file that
 * survives restart, and concurrent clients converge through the proven merge —
 * all exercised THROUGH THE METHODS. Plus the method-boundary version-token
 * conflict and the load-bearing MI-3 render-through-the-method case.
 *
 * Run:  node --test src/lib/spine-server.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, mergeBlobs } from './sync-merge.js';
import { STORAGE_KEY } from './card-store.js';
import { createSpineStore } from './spine-entities.js';
import { createSpineServer, createMemoryPersistence, SPINE_FILE_NAME } from './spine-server.js';

const newServer = (seed = null) => createSpineServer({ persistence: createMemoryPersistence(seed) });

/* ================================================================== */
/* Persistence is a SEPARATE Drive file from the Kanbantt board blob   */
/* ================================================================== */

test('persistence: the spine blob is a SEPARATE Drive file from the Kanbantt board blob', () => {
  assert.equal(STORAGE_KEY, 'kanbantt_data_v1', 'card board file (sanity)');
  assert.equal(SPINE_FILE_NAME, 'claunker_spine_v1');
  assert.notEqual(SPINE_FILE_NAME, STORAGE_KEY, 'spine state never co-mingles with the board state');
  assert.equal(createMemoryPersistence().name, SPINE_FILE_NAME);
});

/* ================================================================== */
/* End-to-end dispatch lifecycle THROUGH THE METHODS                   */
/* ================================================================== */

test('lifecycle through the METHODS: created → tiered → dispatched → judged → delivered, right columns each step', () => {
  const s = newServer();

  // create Project
  const p = s.createProject({ name: 'Spine build' });
  assert.equal(s.getProject(p.id).name, 'Spine build');

  // create Task → created → todo
  let t = s.createTask({ project_id: p.id, title: 'ship it', acceptance_criteria: 'all green' });
  assert.equal(t.state, 'created');
  assert.equal(t.column, 'todo');

  // setTier → tier recorded; pre-dispatch state still created → todo
  t = s.setTier(t.id, 'tier-2', { expectedVersion: t.version });
  assert.equal(t.tier, 'tier-2');
  assert.equal(s.getTask(t.id).column, 'todo');

  // a tiered Hermes state confirms the tiered projection (ready + tier set → tiered)
  assert.equal(s.ingestTaskState(t.id, 'ready', { expectedVersion: t.version }).state, 'tiered');
  t = s.getTask(t.id);
  assert.equal(t.column, 'todo', 'tiered renders todo');

  // ingest running → dispatched → in_progress
  t = s.ingestTaskState(t.id, 'running', { expectedVersion: t.version });
  assert.equal(t.state, 'dispatched');
  assert.equal(t.column, 'in_progress');

  // verdict artifact, then ingest done with NO delivery yet → judged → in_progress
  s.createArtifact({ task_id: t.id, kind: 'verdict', ref: 'git:3f9a2b1' });
  const judged = s.ingestTaskState(t.id, 'done', { expectedVersion: t.version });
  assert.equal(judged.state, 'judged');
  assert.equal(judged.column, 'in_progress');

  // delivery artifact, then ingest done → delivered → done (why verdict ≠ delivery)
  s.createArtifact({ task_id: t.id, kind: 'delivery', ref: 'drive:1A2b3C4d5E' });
  const delivered = s.ingestTaskState(t.id, 'done', { expectedVersion: judged.version });
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.column, 'done');

  // read back the rows through the methods
  assert.equal(s.getArtifacts(t.id).length, 2);
  const tasks = s.getTasks(p.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].column, 'done');
});

/* ================================================================== */
/* Persistence survives a restart                                      */
/* ================================================================== */

test('persistence: state survives a server restart (reload the blob from the persistence layer)', () => {
  const persistence = createMemoryPersistence();
  const s1 = createSpineServer({ persistence });
  const p = s1.createProject({ name: 'P' });
  const t = s1.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  s1.setTier(t.id, 'tier-4', { expectedVersion: t.version });
  s1.ingestTaskState(t.id, 'running'); // → dispatched

  // "restart": a brand-new server instance hydrates from the SAME persisted bytes.
  const s2 = createSpineServer({ persistence });
  const t2 = s2.getTask(t.id);
  assert.equal(t2.tier, 'tier-4', 'tier survived restart');
  assert.equal(t2.state, 'dispatched', 'state survived restart');
  assert.equal(t2.column, 'in_progress');
  assert.equal(s2.getProjects().length, 1);
  assert.equal(s2.getProjects()[0].name, 'P');
});

/* ================================================================== */
/* A second client reads the same state through the method surface     */
/* ================================================================== */

test('multi-client: a second client reads the same state through the method surface', () => {
  const s1 = newServer();
  const p = s1.createProject({ name: 'P' });
  const t = s1.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  s1.ingestTaskState(t.id, 'running');

  // second client opens over the SAME persisted blob bytes
  const s2 = createSpineServer({ persistence: createMemoryPersistence(s1.getBlob()) });
  assert.deepEqual(s2.getTask(t.id), s1.getTask(t.id), 'both clients render the identical view');
  assert.equal(s2.getTasks(p.id)[0].state, 'dispatched');
});

/* ================================================================== */
/* Concurrent divergent writes converge without clobber — via methods  */
/* ================================================================== */

test('multi-client: concurrent divergent writes converge without clobber (merge through the method surface)', () => {
  // shared base both clients start from
  const base = newServer();
  const p = base.createProject({ name: 'P' });
  const t = base.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  const baseBlob = base.getBlob();

  const A = createSpineServer({ persistence: createMemoryPersistence(baseBlob) });
  const B = createSpineServer({ persistence: createMemoryPersistence(baseBlob) });

  // divergent edits to the SAME Task row, each applied through the methods
  A.ingestTaskState(t.id, 'running'); // A: state → dispatched
  B.setTier(t.id, 'tier-3');          // B: tier  → tier-3

  const blobA = A.getBlob();
  const blobB = B.getBlob();
  A.merge(blobB); // merge() = proven sync-merge.js mergeBlobs, exposed at the method boundary
  B.merge(blobA);

  // convergence: byte-identical canonical state in both merge orders
  assert.equal(canonicalize(A.getBlob()), canonicalize(B.getBlob()), 'both clients converge');

  // no clobber: BOTH divergent edits survived (base + .conflict fork of the Task)
  const forks = A.getBlob().tasks.filter((x) => x.id === t.id || x.id.startsWith(t.id + '.conflict.'));
  assert.equal(forks.length, 2, 'both concurrent edits survive as forks (no silent clobber)');

  // the projection still renders ONE coherent effective state through the method
  assert.equal(A.getTask(t.id).state, 'dispatched', 'max-rank live fork (dispatched > created)');
  assert.equal(A.getTask(t.id).column, 'in_progress');
});

/* ================================================================== */
/* Method-boundary version-token conflict                              */
/* ================================================================== */

test('version-token: a write carrying a STALE expected-version is rejected, not silently applied', () => {
  const s = newServer();
  const p = s.createProject({ name: 'P' });
  const t0 = s.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });

  // one good write advances the opaque version
  const t1 = s.ingestTaskState(t0.id, 'running', { expectedVersion: t0.version });
  assert.notEqual(t1.version, t0.version, 'version advanced on write');

  // a second write carrying the STALE token is rejected per the error taxonomy
  assert.throws(
    () => s.ingestTaskState(t0.id, 'done', { expectedVersion: t0.version }),
    (e) => e.code === 'version_conflict',
  );
  // ...and it was NOT applied (still dispatched, not judged)
  assert.equal(s.getTask(t0.id).state, 'dispatched', 'stale write left state untouched');

  // CONTROL: the gate is the staleness, not the field — the FRESH token succeeds
  const t2 = s.ingestTaskState(t0.id, 'done', { expectedVersion: t1.version });
  assert.equal(t2.state, 'judged');
});

/* ================================================================== */
/* THE LOAD-BEARING render: MI-3 through the METHOD (not just the unit) */
/* ================================================================== */

const TS = '2026-06-16T00:00:00.000Z';
const taskRow = (id, state, version) => ({ id, state, version, deleted_at: null, project_id: 'P', title: 'T', tier: null, acceptance_criteria: 'x', created_at: TS });
const escRow = (id, task_id, version, resolved_at) => ({ id, task_id, version, reason: 'r', control_diff: null, resolved_at, deleted_at: null, created_at: TS });
const spineBlob = (over) => ({
  schema_version: 1, seq: 0,
  projects: [{ id: 'P', name: 'P', version: 'p', deleted_at: null, created_at: TS }],
  tasks: [], artifacts: [], escalations: [], ...over,
});

test('render METHOD goes through resolveTaskLiveState: escalated-fork + resolved-Escalation renders done (NOT blocked)', () => {
  // The MI-3 L1 converged shape, reached by a REAL merge (as in the projection proof).
  const a = spineBlob({ tasks: [taskRow('T', 'escalated', 'va')], escalations: [escRow('E', 'T', 'va', TS)] });
  const b = spineBlob({ tasks: [taskRow('T', 'delivered', 'vb')], escalations: [escRow('E', 'T', 'vb', TS)] });
  const converged = mergeBlobs(a, b);

  // load the converged shape into a SERVER and render through the METHOD
  const s = createSpineServer({ persistence: createMemoryPersistence(converged) });

  // sanity: the raw converged state really has an escalated fork (the trap)
  assert.ok(s.getBlob().tasks.some((t) => t.state === 'escalated'), 'raw escalated fork present');

  const view = s.getTask('T');
  assert.equal(view.state, 'delivered', 'effective state via MI-3 — the escalation is over');
  assert.equal(view.column, 'done', 'renders the ADVANCED column THROUGH THE METHOD, not the blocked tray');

  // CONTRAST through the same method: a LIVE escalation does render blocked.
  const live = spineBlob({ tasks: [taskRow('T', 'escalated', 'v0')], escalations: [escRow('E', 'T', 'v0', null)] });
  const s2 = createSpineServer({ persistence: createMemoryPersistence(live) });
  assert.equal(s2.getTask('T').column, 'blocked', 'live escalation → blocked (MI-3 biconditional, via the method)');
  assert.equal(s2.getTask('T').state, 'escalated');
});

/* ================================================================== */
/* The added setState entity op — its guards bite (red-on-violation)    */
/* ================================================================== */

test('setState (the added lifecycle-record op) rejects an off-enum state and a tombstoned Task', () => {
  // enum guard — directly at the entity layer (the server never emits an off-enum
  // state, so this branch is only reachable below the seam).
  const store = createSpineStore();
  const p = store.addProject({ name: 'P' });
  const t = store.addTask({ project_id: p.id, title: 'T', state: 'created', acceptance_criteria: 'x' });
  assert.throws(() => store.setState(t.id, 'frobnicated'), (e) => e.code === 'invalid_state');
  // a valid transition is recorded with a fresh version (the control)
  const before = t.version;
  const moved = store.setState(t.id, 'dispatched');
  assert.equal(moved.state, 'dispatched');
  assert.notEqual(moved.version, before);

  // tombstone guard — through the METHOD: a cancelled Task is not resurrectable by ingest.
  const s = newServer();
  const p2 = s.createProject({ name: 'P' });
  const t2 = s.createTask({ project_id: p2.id, title: 'T', acceptance_criteria: 'x' });
  s.cancelTask(t2.id);
  assert.throws(() => s.ingestTaskState(t2.id, 'running'), (e) => e.code === 'closed_task');
});

/* ================================================================== */
/* Governed-write boundary: the server adds NO authorization gate      */
/* ================================================================== */

test('governed-write is INHERITED: the server records writes without a classifier/auth gate of its own', () => {
  // A write the dispatch path already governed is simply recorded — no tier/auth
  // check is performed here (governance lives on the Hermes dispatch path).
  const s = newServer();
  const p = s.createProject({ name: 'P' });
  const t = s.createTask({ project_id: p.id, title: 'apex-tool task', acceptance_criteria: 'x' });
  // Apex-tier work records exactly like any other — the ledger does not re-govern.
  const tiered = s.setTier(t.id, 'tier-4', { expectedVersion: t.version });
  assert.equal(tiered.tier, 'tier-4');
  assert.equal(s.getTask(t.id).state, 'created', 'no gate mutated the recorded state');
});
