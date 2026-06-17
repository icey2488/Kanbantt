/**
 * MCP connection controller (Phase 3b) — auto-detect flow + capability gating +
 * polling, driven against the REAL spine server via the 3a transport (no mock).
 * createMcpConnection → makeProvider() → real createMCPProvider → in-process
 * spine wire face → real createSpineServer.
 *
 * Run:  node --test src/lib/mcp-connection.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeBlobs } from './sync-merge.js';
import { createSpineServer, createMemoryPersistence } from './spine-server.js';
import { createSpineHttpHandler } from './spine-http.js';
import { createMCPProvider, makeInProcessTransport } from './spine-mcp-provider.js';
import {
  createMcpConnection,
  LOCAL_INDICATOR,
  MCP_UNAVAILABLE_INDICATOR,
} from './mcp-connection.js';

/** Real server + wire face + a makeProvider the controller can connect in-process. */
function realBackend(seed = null) {
  const server = createSpineServer({ persistence: createMemoryPersistence(seed) });
  const handler = createSpineHttpHandler(server);
  const makeProvider = () => createMCPProvider({ transport: makeInProcessTransport(handler) });
  return { server, handler, makeProvider };
}

/** A manual scheduler: captures scheduled callbacks so a test can fire the next
 *  poll deterministically (the ping-timeout handle is cancelled before it fires). */
function manualScheduler() {
  let items = [];
  return {
    schedule: (fn, ms) => { const h = { fn, ms, cancelled: false }; items.push(h); return h; },
    cancel: (h) => { if (h) h.cancelled = true; },
    async fireNext() {
      const live = items.filter((h) => !h.cancelled);
      const h = live[live.length - 1];
      items = items.filter((x) => x !== h);
      if (h) await h.fn();
      return !!h;
    },
    pending: () => items.filter((h) => !h.cancelled).length,
  };
}

/* ================================================================== */
/* No URL → LocalProvider, "Local", board renders (unchanged default)  */
/* ================================================================== */

test('no MCP URL → LocalProvider active, "Local" indicator, default flags', async () => {
  const conn = createMcpConnection({ config: { data_source: 'auto' } }); // no mcp.url
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, LOCAL_INDICATOR);
  assert.equal(st.featureFlags.escalations, false);
  assert.equal(conn.isPolling(), false, 'LocalProvider does not poll');
});

/* ================================================================== */
/* Reachable real server → MCPProvider, "MCP: <name>", capability flags */
/* ================================================================== */

test('reachable real server → MCPProvider active, "MCP: Claunker", capability flags set', async () => {
  const { makeProvider } = realBackend();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine' } },
    makeProvider,
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'mcp');
  assert.equal(st.indicator, 'MCP: Claunker');
  assert.deepEqual(st.featureFlags, { escalations: true, artifacts: true, corpus: false, realtime: false });
  assert.equal(conn.supportsRealtime(), false, 'realtime:false → board polls, no WebSocket');
  assert.ok(conn.isPolling(), 'MCP activation starts the poll loop');
});

/* ================================================================== */
/* Unreachable / invalid-schema / timeout → fallback, never blank      */
/* ================================================================== */

test('unreachable server → fallback to "Local (MCP unavailable)" + retry recovers', async () => {
  let healthy = false;
  const live = realBackend();
  // makeProvider throws (unreachable) until "healthy", then returns the real provider.
  const makeProvider = () => {
    if (!healthy) return { connect: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' }); } };
    return live.makeProvider();
  };
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://down' } },
    makeProvider,
    schedule: manualScheduler().schedule,
    cancel: () => {},
  });
  const down = await conn.connect();
  assert.equal(down.provider, 'local');
  assert.equal(down.indicator, MCP_UNAVAILABLE_INDICATOR);
  assert.equal(down.fallback, true);
  assert.ok(down.error, 'error detail retained for settings');

  // retry after the server comes up → MCP active
  healthy = true;
  const up = await conn.retry();
  assert.equal(up.provider, 'mcp');
  assert.equal(up.indicator, 'MCP: Claunker');
});

test('invalid-schema server (projects:false) → fallback, never blank', async () => {
  const badTransport = async (req) => {
    if (req.path === '/mcp/capabilities') {
      return { status: 200, body: { server: { name: 'Bad', version: '1', schema_version: 1 }, capabilities: { projects: false, tasks: true } } };
    }
    return { status: 200, body: [] };
  };
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://bad' } },
    makeProvider: () => createMCPProvider({ transport: badTransport }),
    schedule: manualScheduler().schedule,
    cancel: () => {},
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, MCP_UNAVAILABLE_INDICATOR);
});

test('timeout (server hangs past the ping timeout) → fallback', async () => {
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://slow' } },
    makeProvider: () => ({ connect: () => new Promise(() => {}) }), // never resolves
    pingTimeoutMs: 20, // real timers fire this
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, MCP_UNAVAILABLE_INDICATOR);
  assert.equal(st.error.code, 'timeout');
});

/* ================================================================== */
/* Polling reflects a server-side change WITHOUT a manual refresh       */
/* ================================================================== */

test('poll reflects a server-side ingest: task moves to in_progress on the next tick (no manual refresh)', async () => {
  const { server, makeProvider } = realBackend();
  // seed one project + task server-side
  const p = server.createProject({ name: 'P' });
  const t = server.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });

  let lastModel = null;
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine' } },
    makeProvider,
    applyModel: (m) => { lastModel = m; },
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect(); // immediate first poll
  let card = lastModel.cards.find((c) => c.id === t.id);
  assert.equal(card.column_id, 'todo', 'initial poll: task in todo');

  // Hermes feeds a running state SERVER-SIDE; the board does NOT call refresh.
  server.ingestTaskState(t.id, 'running');

  // advance ONE poll tick — the poll alone moves the card.
  await sched.fireNext();
  card = lastModel.cards.find((c) => c.id === t.id);
  assert.equal(card.column_id, 'in_progress', 'poll moved the card to in_progress, no manual refresh');
});

/* ================================================================== */
/* Live-board MI-3 carry-through: escalated-fork+resolved → advanced    */
/* ================================================================== */

const TS = '2026-06-16T00:00:00.000Z';
const taskRow = (id, state, version) => ({ id, state, version, deleted_at: null, project_id: 'P', title: 'T', tier: null, acceptance_criteria: 'x', created_at: TS });
const escRow = (id, task_id, version, resolved_at) => ({ id, task_id, version, reason: 'r', control_diff: null, resolved_at, deleted_at: null, created_at: TS });
const spineBlob = (over) => ({
  schema_version: 1, seq: 0,
  projects: [{ id: 'P', name: 'P', version: 'p', deleted_at: null, created_at: TS }],
  tasks: [], artifacts: [], escalations: [], ...over,
});

test('live-board MI-3: an escalated-fork + resolved-Escalation polls into the ADVANCED column, not blocked', async () => {
  const a = spineBlob({ tasks: [taskRow('T', 'escalated', 'va')], escalations: [escRow('E', 'T', 'va', TS)] });
  const b = spineBlob({ tasks: [taskRow('T', 'delivered', 'vb')], escalations: [escRow('E', 'T', 'vb', TS)] });
  const converged = mergeBlobs(a, b);

  const { makeProvider } = realBackend(converged);
  let lastModel = null;
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine' } },
    makeProvider,
    applyModel: (m) => { lastModel = m; },
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  const card = lastModel.cards.find((c) => c.id === 'T');
  assert.equal(card.column_id, 'done', 'the live board lands the resolved-escalation task in done, NOT blocked');

  // contrast: a genuinely live escalation polls into blocked
  const live = spineBlob({ tasks: [taskRow('T', 'escalated', 'v0')], escalations: [escRow('E', 'T', 'v0', null)] });
  let m2 = null;
  const sched2 = manualScheduler();
  const conn2 = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine2' } },
    makeProvider: realBackend(live).makeProvider,
    applyModel: (m) => { m2 = m; },
    schedule: sched2.schedule,
    cancel: sched2.cancel,
  });
  await conn2.connect();
  assert.equal(m2.cards.find((c) => c.id === 'T').column_id, 'blocked', 'live escalation → blocked tray');
});

/* ================================================================== */
/* Version-token conflict via the MCP path surfaces in the EXISTING UI  */
/* ================================================================== */

test('version-token conflict from the MCP path surfaces code:"conflict" (board-parity), not a silent overwrite', async () => {
  const { server, makeProvider } = realBackend();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine' } },
    makeProvider,
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  const provider = conn.getProvider(); // board writes go through the active provider

  const p = await provider.createProject({ name: 'P' });
  const t0 = await provider.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });

  // a server-side write advances the version → the board's token is now stale
  server.ingestTaskState(t0.id, 'running');

  await assert.rejects(
    () => provider.cancelTask(t0.id, t0.version),
    (e) => e.code === 'conflict' && e.meta.current && e.meta.current.state === 'dispatched',
  );
});

/* ================================================================== */
/* Polling stops on disconnect (no stacked timers)                     */
/* ================================================================== */

test('disconnect stops the poll loop (no stacked timers) and returns to Local', async () => {
  const { makeProvider } = realBackend();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'inproc://spine' } },
    makeProvider,
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.ok(conn.isPolling());
  conn.disconnect();
  assert.equal(conn.isPolling(), false);
  assert.equal(conn.getState().provider, 'local');
  assert.equal(conn.getState().fallback, false, 'a clean disconnect is not a fallback');
});
