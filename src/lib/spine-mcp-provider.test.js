/**
 * MCPProvider (Phase 3a) — the Kanbantt provider driven against the REAL spine
 * server over the wire contract, in-process. No mock server: createMCPProvider →
 * makeInProcessTransport → createSpineHttpHandler → the real createSpineServer
 * (real entity layer, real projections, real merge). A mock would prove nothing —
 * the point of Phase 3 is the two real seams meeting.
 *
 * Run:  node --test src/lib/spine-mcp-provider.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeBlobs } from './sync-merge.js';
import { createSpineServer, createMemoryPersistence } from './spine-server.js';
import { createSpineHttpHandler } from './spine-http.js';
import { createMCPProvider, makeInProcessTransport, MCPProviderError } from './spine-mcp-provider.js';

/** Stand up the real server + its wire face + a provider over the in-process transport. */
function standUp(seed = null) {
  const server = createSpineServer({ persistence: createMemoryPersistence(seed) });
  const handler = createSpineHttpHandler(server);
  const provider = createMCPProvider({ transport: makeInProcessTransport(handler) });
  return { server, handler, provider };
}

/* A transport over a fixed capabilities map — for connection-rejection / gating. */
function fixedCapsTransport(capabilities) {
  return async (req) => {
    if (req.method === 'GET' && req.path === '/mcp/capabilities') {
      return { status: 200, body: { server: { name: 'Fake', version: '1.0.0', schema_version: 1 }, capabilities } };
    }
    return { status: 200, body: [] };
  };
}

/* ================================================================== */
/* connect() against the REAL server + connection rejection            */
/* ================================================================== */

test('connect() returns the REAL CapabilityMap; projects:false is REJECTED', async () => {
  const { provider } = standUp();
  const res = await provider.connect();
  assert.deepEqual(res.capabilities, {
    projects: true, tasks: true, artifacts: true, escalations: true, realtime: false, corpus: false,
  });
  assert.equal(res.server.schema_version, 1);

  // a server missing a REQUIRED capability cannot back Kanbantt
  const bad = createMCPProvider({ transport: fixedCapsTransport({ projects: false, tasks: true, artifacts: true, escalations: true, realtime: false, corpus: false }) });
  await assert.rejects(() => bad.connect(), (e) => e instanceof MCPProviderError && e.code === 'incompatible_server');

  const bad2 = createMCPProvider({ transport: fixedCapsTransport({ projects: true, tasks: false }) });
  await assert.rejects(() => bad2.connect(), (e) => e.code === 'incompatible_server');
});

/* ================================================================== */
/* Round-trip: provider → server → back, column comes FROM the server  */
/* ================================================================== */

test('round-trip: createProject/createTask render todo; a server-side ingest shows in_progress via the provider', async () => {
  const { server, provider } = standUp();
  await provider.connect();

  const p = await provider.createProject({ name: 'Spine board' });
  assert.equal(p.name, 'Spine board');

  const t = await provider.createTask({ project_id: p.id, title: 'ship it', acceptance_criteria: 'all green' });
  assert.equal(t.column, 'todo', 'fresh task renders todo (column from the server)');
  assert.equal(t.state, 'created');

  // Hermes feeds a running state SERVER-SIDE (the spine extension; not a board op).
  server.ingestTaskState(t.id, 'running');

  // The provider reads the column the server computed — it does NOT recompute it.
  const tasks = await provider.getTasks(p.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state, 'dispatched');
  assert.equal(tasks[0].column, 'in_progress', 'in_progress came from the server-side renderColumn');

  const one = await provider.getTask(t.id);
  assert.equal(one.column, 'in_progress');

  // artifacts round-trip through the wire too
  server.createArtifact({ task_id: t.id, kind: 'delivery', ref: 'drive:1A2b3C' });
  const arts = await provider.getArtifacts(t.id);
  assert.equal(arts.length, 1);
  assert.equal(arts[0].kind, 'delivery');
});

/* ================================================================== */
/* THE LOAD-BEARING one: escalated-fork + resolved-Escalation OVER THE  */
/* WIRE renders the ADVANCED column, not blocked.                      */
/* ================================================================== */

const TS = '2026-06-16T00:00:00.000Z';
const taskRow = (id, state, version) => ({ id, state, version, deleted_at: null, project_id: 'P', title: 'T', tier: null, acceptance_criteria: 'x', created_at: TS });
const escRow = (id, task_id, version, resolved_at) => ({ id, task_id, version, reason: 'r', control_diff: null, resolved_at, deleted_at: null, created_at: TS });
const spineBlob = (over) => ({
  schema_version: 1, seq: 0,
  projects: [{ id: 'P', name: 'P', version: 'p', deleted_at: null, created_at: TS }],
  tasks: [], artifacts: [], escalations: [], ...over,
});

test('LOAD-BEARING: escalated-fork + resolved-Escalation read through getTask via the provider → advanced column (done), NOT blocked', async () => {
  // MI-3 L1 converged shape, reached by a REAL merge.
  const a = spineBlob({ tasks: [taskRow('T', 'escalated', 'va')], escalations: [escRow('E', 'T', 'va', TS)] });
  const b = spineBlob({ tasks: [taskRow('T', 'delivered', 'vb')], escalations: [escRow('E', 'T', 'vb', TS)] });
  const converged = mergeBlobs(a, b);

  const { provider } = standUp(converged);
  await provider.connect();

  const view = await provider.getTask('T');
  assert.equal(view.state, 'delivered', 'effective state survives the wire (escalation is over)');
  assert.equal(view.column, 'done', 'the ADVANCED column survives the wire — NOT the blocked tray');

  // contrast over the same wire: a LIVE escalation really does render blocked
  const live = spineBlob({ tasks: [taskRow('T', 'escalated', 'v0')], escalations: [escRow('E', 'T', 'v0', null)] });
  const p2 = standUp(live).provider;
  await p2.connect();
  assert.equal((await p2.getTask('T')).column, 'blocked', 'live escalation → blocked, via the provider');
});

/* ================================================================== */
/* Version-token conflict surfaces through the provider (no overwrite)  */
/* ================================================================== */

test('version-token: a stale token surfaces a conflict through the provider, does not silently overwrite', async () => {
  const { server, provider } = standUp();
  await provider.connect();

  const p = await provider.createProject({ name: 'P' });
  const t0 = await provider.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });

  // a SERVER-SIDE write (the Hermes seam) advances the opaque version
  server.ingestTaskState(t0.id, 'running');

  // a provider write carrying the now-STALE token surfaces a conflict (board parity)
  await assert.rejects(
    () => provider.cancelTask(t0.id, t0.version),
    (e) => e instanceof MCPProviderError && e.code === 'conflict' && e.meta.current && e.meta.current.state === 'dispatched',
  );
  // ...and it did NOT overwrite (the task still exists, still dispatched)
  assert.equal((await provider.getTask(t0.id)).state, 'dispatched');

  // CONTROL: the FRESH token succeeds (the gate is staleness, not the field).
  // A cancelled Task is off-board, not erased: the spine keeps the tombstone
  // (R4 audit ledger), so it leaves the board view but reads back as 'deleted'.
  const current = await provider.getTask(t0.id);
  await provider.cancelTask(t0.id, current.version);
  assert.equal((await provider.getTasks(p.id)).length, 0, 'cancelled task leaves the board view');
  const after = await provider.getTask(t0.id);
  assert.equal(after.column, null, 'off-board');
  assert.equal(after.state, 'deleted');
});

/* ================================================================== */
/* Optional-method discipline + no faked WebSocket                     */
/* ================================================================== */

test('subscribe is unsupported (realtime:false) → the board polls; no WebSocket faked', async () => {
  const { provider } = standUp();
  await provider.connect();
  assert.equal(provider.supportsRealtime(), false);
  assert.throws(() => provider.subscribe('task.updated', () => {}), (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability');
});

test('optional-method gating: getEscalations is rejected when the server does not advertise escalations', async () => {
  // real server DOES advertise escalations → callable
  const { server, provider } = standUp();
  await provider.connect();
  const p = await provider.createProject({ name: 'P' });
  const t = await provider.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  server.createEscalation({ task_id: t.id, reason: 'need human', control_diff: null });
  const open = await provider.getEscalations({ status: 'pending' });
  assert.equal(open.length, 1);
  assert.equal(open[0].status, 'pending');

  // a server that does NOT advertise escalations → the optional method is gated off
  const gated = createMCPProvider({ transport: fixedCapsTransport({ projects: true, tasks: true, artifacts: true, escalations: false, realtime: false, corpus: false }) });
  await gated.connect();
  await assert.rejects(() => gated.getEscalations(), (e) => e.code === 'unsupported_capability');
});

/* ================================================================== */
/* updateProject divergence: spine Project inert → unsupported_operation */
/* ================================================================== */

test('updateProject surfaces unsupported_operation (spine Project is inert at v1)', async () => {
  const { provider } = standUp();
  await provider.connect();
  const p = await provider.createProject({ name: 'P' });
  await assert.rejects(() => provider.updateProject(p.id, { name: 'renamed' }), (e) => e.code === 'unsupported_operation');
});
