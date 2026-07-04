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
  createMcpConnectionFromConfig,
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

/* ================================================================== */
/* HARDENING FIX A (teardown guard) + FIX C (poll strike counter)      */
/* ------------------------------------------------------------------- */
/* Driven against a fully CONTROLLABLE provider double: its poll reads  */
/* (getBoard/list) can be armed to throw a classified FATAL and — like  */
/* the real provider's call() — invoke the injected onFatal BEFORE      */
/* throwing, so the controller's degrade policy runs. connect()/        */
/* getBoard() can be deferred to a test-resolved promise to drive the   */
/* teardown race deterministically.                                     */
/* ================================================================== */

function controllableProvider() {
  const caps = { canWrite: true, canRetier: true, escalations: true, artifacts: true, columns: true, tags: true, realtime: false };
  const ctl = {
    onFatal: null,
    fail: null,          // null | 'auth' | 'unreachable'  — arms getBoard/list
    boardCalls: 0,
    disconnects: 0,
    deferConnect: null,  // a Promise the test resolves to complete connect()
    deferBoard: null,    // a Promise the test resolves to complete getBoard()
    board: { columns: [{ id: 'todo', name: 'To Do', order: 'a' }] },
    cards: [],
  };
  const fatalErr = (kind) => Object.assign(
    new Error(kind === 'auth' ? '401 unauthorized' : 'Failed to fetch'),
    { code: kind, fatalKind: kind },
  );
  function maybeFatal() {
    if (ctl.fail) {
      const err = fatalErr(ctl.fail);
      if (typeof ctl.onFatal === 'function') ctl.onFatal(err); // mirrors provider call(): onFatal BEFORE throw
      throw err;
    }
  }
  ctl.provider = {
    async connect() { if (ctl.deferConnect) await ctl.deferConnect; return { ok: true, server: { name: 'Fake' }, capabilities: caps }; },
    async getBoard() { ctl.boardCalls += 1; if (ctl.deferBoard) await ctl.deferBoard; maybeFatal(); return { board: ctl.board }; },
    async list() { maybeFatal(); return { cards: ctl.cards }; },
    disconnect() { ctl.disconnects += 1; },
    // Simulate a USER-INITIATED op fatal: funnels through onFatal exactly like a write op's call().
    async opFatal(kind) { const err = fatalErr(kind); if (typeof ctl.onFatal === 'function') ctl.onFatal(err); throw err; },
  };
  ctl.make = (hooks = {}) => { ctl.onFatal = hooks.onFatal; return ctl.provider; };
  return ctl;
}

const mcpConfig = { data_source: 'mcp', mcp: { url: 'http://x/mcp' } };
/** Spin the microtask queue until `cond()` (bounded) — lets a parked async continuation run. */
async function flushUntil(cond, max = 20) { for (let i = 0; i < max && !cond(); i++) await Promise.resolve(); }

test('FIX C: background-poll "unreachable" rides out 2 strikes; the 3rd consecutive degrades', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let applied = 0;
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => { applied += 1; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(conn.getState().provider, 'mcp');
  assert.ok(applied >= 1, 'the first poll painted the board');

  ctl.fail = 'unreachable';
  await sched.fireNext();
  assert.equal(conn.getState().provider, 'mcp', 'strike 1: board stays live');
  await sched.fireNext();
  assert.equal(conn.getState().provider, 'mcp', 'strike 2: board stays live');
  assert.ok(conn.isPolling(), 'still polling through strikes 1-2');
  await sched.fireNext();
  assert.equal(conn.getState().provider, 'local', 'strike 3: degraded to Local');
  assert.equal(conn.getState().fallback, true, 'the degrade is a fallback');
  assert.equal(conn.isPolling(), false, 'the poll loop stopped on degrade');
});

test('FIX C: a clean poll between failures resets the strike counter', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();

  ctl.fail = 'unreachable';
  await sched.fireNext();          // strike 1
  ctl.fail = null;
  await sched.fireNext();          // clean poll → reset to 0
  assert.equal(conn.getState().provider, 'mcp');
  ctl.fail = 'unreachable';
  await sched.fireNext();          // strike 1 (post-reset), NOT the 2nd
  await sched.fireNext();          // strike 2
  assert.equal(conn.getState().provider, 'mcp', 'reset worked: 2 post-reset strikes still live');
  await sched.fireNext();          // strike 3 → degrade
  assert.equal(conn.getState().provider, 'local', 'degrades only after 3 CONSECUTIVE post-reset');
});

test('FIX C: a fatal "auth" on the poll degrades immediately (no strike tolerance)', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();
  ctl.fail = 'auth';
  await sched.fireNext();
  assert.equal(conn.getState().provider, 'local', 'auth degrades on the FIRST poll fatal');
  assert.equal(conn.getState().error.code, 'auth');
  assert.equal(conn.isPolling(), false);
});

test('FIX C: a user-op "unreachable" degrades immediately (strike tolerance is poll-only)', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(conn.getState().provider, 'mcp');
  // A write op (NOT the poll) hits an unreachable spine: pollInFlight is false ⇒ instant degrade.
  await assert.rejects(() => conn.getProvider().opFatal('unreachable'));
  assert.equal(conn.getState().provider, 'local', 'user-op unreachable degrades on the FIRST fatal');
  assert.equal(conn.getState().fallback, true);
  assert.equal(conn.isPolling(), false);
});

test('FIX A: a connect that RESOLVES AFTER teardown invokes nothing (no applyModel/subscriber/poll/degrade)', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let applied = 0;
  let notifies = 0;
  let resolveConnect;
  ctl.deferConnect = new Promise((r) => { resolveConnect = r; });
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => { applied += 1; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  conn.subscribe(() => { notifies += 1; });
  const p = conn.connect();      // activate is parked awaiting deferConnect
  conn.disconnect();             // teardown BEFORE connect resolves
  resolveConnect();              // the late connect completion arrives
  await p;                       // let activate run its post-await disposed guard
  await flushUntil(() => false, 3);

  assert.equal(applied, 0, 'no applyModel after teardown');
  assert.equal(notifies, 0, 'no subscriber notify after teardown');
  assert.equal(ctl.boardCalls, 0, 'the late connect never started polling');
  assert.equal(conn.isPolling(), false);
  assert.equal(conn.getState().provider, 'local');
  assert.equal(conn.getState().fallback, false, 'a clean teardown is not a degrade-fallback');
  assert.equal(ctl.disconnects, 1, 'the late-connected provider was closed on the disposed bail');
});

test('FIX A: a poll IN FLIGHT at teardown never applies its late result (no applyModel/degrade)', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let applied = 0;
  let resolveBoard;
  ctl.deferBoard = new Promise((r) => { resolveBoard = r; });
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => { applied += 1; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  const p = conn.connect();                     // connect resolves; first pollOnce parks on deferBoard
  await flushUntil(() => ctl.boardCalls === 1); // wait until the first poll has entered getBoard
  assert.equal(applied, 0, 'nothing applied yet (board read is parked)');
  conn.disconnect();                            // teardown WHILE the first poll is in flight
  resolveBoard();                               // the late board result arrives
  await p.catch(() => {});                       // activate/startPolling settle
  await flushUntil(() => false, 3);

  assert.equal(applied, 0, 'the in-flight poll did NOT apply its stale result after teardown');
  assert.equal(conn.isPolling(), false);
  assert.equal(conn.getState().provider, 'local');
  assert.equal(conn.getState().fallback, false, 'a clean teardown mid-poll is not a degrade-fallback');
});

/* ================================================================== */
/* Auth v1: remember-token opt-in — token threading                    */
/* -------------------------------------------------------------------- */
/* These tests verify that createMcpConnectionFromConfig passes the     */
/* right token to the provider, keyed off the capturing fetch wrapper:  */
/* the StreamableHTTPClientTransport merges requestInit.headers into    */
/* every outbound request, so the Authorization header appears in the   */
/* first `init` object the fetchFn receives.                            */
/* ================================================================== */

/** Capture the first Authorization header seen across all fetch calls. */
function authCapture(harness) {
  let captured = 'NOT_SET';
  const fetchFn = (url, init = {}) => {
    if (captured === 'NOT_SET') {
      const hs = init.headers;
      captured = hs
        ? (typeof hs.get === 'function' ? (hs.get('Authorization') ?? null) : (hs.Authorization ?? null))
        : null;
    }
    return harness.fetchFn(url, init);
  };
  return { fetchFn, getAuth: () => captured };
}

test('Auth v1: remember_token: true — createMcpConnectionFromConfig uses stored auth_token', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const { fetchFn, getAuth } = authCapture(harness);
  const sched = manualScheduler();
  const conn = createMcpConnectionFromConfig({
    config: { data_source: 'mcp', mcp: { url: harness.url, remember_token: true, auth_token: 'stored-tok' } },
    fetchFn,
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(getAuth(), 'Bearer stored-tok', 'stored token should appear in Authorization header');
  conn.disconnect();
  await harness.close();
});

test('Auth v1: remember_token: false with in-memory authToken — provider uses the in-memory token', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const { fetchFn, getAuth } = authCapture(harness);
  const sched = manualScheduler();
  const conn = createMcpConnectionFromConfig({
    config: { data_source: 'mcp', mcp: { url: harness.url, remember_token: false } }, // no auth_token in config
    authToken: 'mem-tok',
    fetchFn,
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(getAuth(), 'Bearer mem-tok', 'in-memory token should appear in Authorization header');
  conn.disconnect();
  await harness.close();
});

test('Auth v1: reload without remembered token → no Authorization header (no auto-connect with token)', async () => {
  const harness = createMcpTestServer({ seed: oneCard });
  const { fetchFn, getAuth } = authCapture(harness);
  const sched = manualScheduler();
  const conn = createMcpConnectionFromConfig({
    config: { data_source: 'mcp', mcp: { url: harness.url, remember_token: false } }, // no token anywhere
    // authToken omitted (as on page reload when remember_token: false — in-memory token is gone)
    fetchFn,
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(getAuth(), null, 'no token provided → no Authorization header');
  conn.disconnect();
  await harness.close();
});
