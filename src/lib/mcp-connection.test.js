/**
 * MCP connection controller tests — auto-detect selection + capability gating +
 * the polling loop, driven against the REAL MCPProvider over a conforming
 * in-process MCP server (spine-mcp-test-server.js). createMcpConnection →
 * makeProvider() → real createMCPProvider → in-memory StreamableHTTP → real SDK
 * Server backed by card-store. No mock provider; the two real seams meet.
 *
 * Run:  node --test src/lib/mcp-connection.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider } from './spine-mcp-provider.js';
import {
  createMcpConnection,
  toBoardColumns,
  LOCAL_INDICATOR,
  MCP_UNAVAILABLE_INDICATOR,
} from './mcp-connection.js';

/** A makeProvider bound to a harness — the controller owns connect()/timeout. */
function providerFactory(harness) {
  return () => createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
}

/** Manual scheduler: captures scheduled callbacks so a test fires the next poll
 *  deterministically (the ping-timeout handle is cancelled before it would fire). */
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
const oneCard = (s) => s.create({ id: 'c1', title: 'T', column_id: 'todo', priority: 'med' });

/* ================================================================== */
/* No URL → LocalProvider, "Local", default flags, no polling          */
/* ================================================================== */

test('no MCP URL → LocalProvider active, "Local" indicator, no polling', async () => {
  const conn = createMcpConnection({ config: { data_source: 'auto' } }); // no mcp.url
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, LOCAL_INDICATOR);
  assert.equal(st.featureFlags.escalations, false);
  assert.equal(conn.isPolling(), false, 'LocalProvider does not poll');
});

test('data_source:"local" with a url present still stays Local (wantsMcp false)', async () => {
  const conn = createMcpConnection({ config: { data_source: 'local', mcp: { url: 'http://mcp.test/mcp' } } });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(conn.isPolling(), false);
});

/* ================================================================== */
/* Reachable server → MCPProvider active, indicator, flags, board model */
/* ================================================================== */

test('reachable server → MCPProvider active, "MCP: Claunker", flags, polling, board model applied', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const sched = manualScheduler();
  let model = null;
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    applyModel: (m) => { model = m; },
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'mcp');
  assert.equal(st.indicator, 'MCP: Claunker');
  assert.deepEqual(st.featureFlags, { escalations: true, artifacts: true, columns: true, tags: true, realtime: false });
  assert.equal(conn.supportsRealtime(), false, 'realtime:false → board polls');
  assert.ok(conn.isPolling(), 'MCP activation starts the poll loop');

  // The immediate first poll painted the board: spec columns mapped to the
  // board's { id, label, accentKey } shape, and the seeded card present.
  const todo = model.columns.find((c) => c.id === 'todo');
  assert.ok(todo.label && todo.accentKey, 'server columns mapped to board shape');
  assert.equal(model.cards.find((c) => c.id === 'c1').column_id, 'todo');
  conn.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Polling reflects a server-side change WITHOUT a manual refresh       */
/* ================================================================== */

test('poll reflects a server-side move on the next tick (no manual refresh)', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const sched = manualScheduler();
  let model = null;
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    applyModel: (m) => { model = m; },
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect(); // immediate first poll
  assert.equal(model.cards.find((c) => c.id === 'c1').column_id, 'todo', 'initial poll: card in todo');

  // A server-side move (the Hermes-feed analog); the board does NOT call refresh.
  const cur = harness.store.get('c1');
  harness.store.move('c1', { column_id: 'doing' }, { expected_version: cur.version });

  await sched.fireNext(); // advance ONE poll tick — the poll alone moves the card
  assert.equal(model.cards.find((c) => c.id === 'c1').column_id, 'doing', 'poll moved the card, no manual refresh');
  conn.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Unreachable / incompatible → fallback, never blank                  */
/* ================================================================== */

test('unreachable server → "Local (MCP unavailable)" + retry recovers when it comes up', async () => {
  let up = false;
  const harness = createMcpTestServer({ seed: oneCard });
  // makeProvider returns a throwing provider until "up", then the real one.
  const makeProvider = () => (up
    ? createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn })
    : { connect: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' }); } });
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider,
    schedule: manualScheduler().schedule,
    cancel: () => {},
  });
  const down = await conn.connect();
  assert.equal(down.provider, 'local');
  assert.equal(down.indicator, MCP_UNAVAILABLE_INDICATOR);
  assert.equal(down.fallback, true);
  assert.ok(down.error, 'error detail retained for settings');

  up = true;
  const recovered = await conn.retry();
  assert.equal(recovered.provider, 'mcp');
  assert.equal(recovered.indicator, 'MCP: Claunker');
  conn.disconnect();
  await harness.close();
});

test('incompatible server (missing a required tool) → fallback, never blank', async () => {
  const harness = createMcpTestServer({ omitTools: ['card_list'] });
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    schedule: manualScheduler().schedule,
    cancel: () => {},
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, MCP_UNAVAILABLE_INDICATOR);
  assert.equal(st.error.code, 'incompatible_server');
  await harness.close();
});

test('timeout (connect hangs past the ping timeout) → fallback', async () => {
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'http://mcp.test/mcp' } },
    makeProvider: () => ({ connect: () => new Promise(() => {}) }), // never resolves
    pingTimeoutMs: 20, // real timers fire this
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, MCP_UNAVAILABLE_INDICATOR);
  assert.equal(st.error.code, 'timeout');
});

/* ================================================================== */
/* Version conflict via the active provider surfaces in the UI shape    */
/* ================================================================== */

test('a stale write through the active provider surfaces code:"conflict" with meta.current (board parity)', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  const provider = conn.getProvider(); // board writes go through the active provider
  await assert.rejects(
    () => provider.update('c1', { title: 'x' }, { expected_version: 'STALE' }),
    (e) => e.code === 'conflict' && e.meta.current && e.meta.current.id === 'c1',
  );
  conn.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Polling stops on disconnect (no stacked timers)                     */
/* ================================================================== */

test('disconnect stops the poll loop and returns to Local (clean, not a fallback)', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.ok(conn.isPolling());
  conn.disconnect();
  assert.equal(conn.isPolling(), false);
  assert.equal(conn.getState().provider, 'local');
  assert.equal(conn.getState().fallback, false, 'a clean disconnect is not a fallback');
  await harness.close();
});

/* ================================================================== */
/* Column mapping unit (spec Board column → board render shape)         */
/* ================================================================== */

test('toBoardColumns maps { id, name, color, order } → { id, label, accentKey }, sorted by order', () => {
  const mapped = toBoardColumns([
    { id: 'done', name: 'Done', color: 'mint', order: 'z' },
    { id: 'todo', name: 'To Do', color: 'ice', order: 'a' },
    { id: 'weird', name: 'Weird', color: '#ff0000', order: 'm' }, // non-accent color → derived
  ]);
  assert.deepEqual(mapped.map((c) => c.id), ['todo', 'weird', 'done'], 'sorted by LexoRank order');
  assert.deepEqual(mapped[0], { id: 'todo', label: 'To Do', accentKey: 'ice' }, 'color "ice" is a known accent → used directly');
  assert.equal(mapped[2].accentKey, 'mint', 'color "mint" is a known accent → used directly');
  assert.ok(['textDim', 'frost', 'ice', 'amber', 'mint', 'coral'].includes(mapped[1].accentKey), 'non-accent color "#ff0000" → derived to a valid theme accent');
});

test('toBoardColumns falls back to the reserved spine columns when given none', () => {
  assert.equal(toBoardColumns([]).length, 4);
  assert.equal(toBoardColumns(undefined)[0].id, 'todo');
});
