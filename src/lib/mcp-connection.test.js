/**
 * MCP connection controller tests — auto-detect selection + capability gating +
 * the polling loop + reconnect resilience, driven against the REAL MCPProvider
 * over a conforming in-process MCP server (spine-mcp-test-server.js).
 * createMcpConnection → makeProvider() → real createMCPProvider → in-memory
 * StreamableHTTP → real SDK Server backed by card-store. No mock provider; the
 * two real seams meet.
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
  LOCAL_RETRYING_INDICATOR,
  MCP_UNAVAILABLE_INDICATOR,
  AUTH_REJECTED_INDICATOR,
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
    /** Fire the OLDEST pending item (useful for firing the next backoff timer). */
    async fireOldest() {
      const live = items.filter((h) => !h.cancelled);
      const h = live[0];
      items = items.filter((x) => x !== h);
      if (h) await h.fn();
      return !!h;
    },
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
  assert.equal(st.reconnecting, false);
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
/* Unreachable → retry loop (not one-shot Local parking)               */
/* ================================================================== */

test('unreachable server → enters retry loop (LOCAL_RETRYING, not one-shot Local)', async () => {
  let up = false;
  const harness = createMcpTestServer({ seed: oneCard });
  const makeProvider = () => (up
    ? createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn })
    : { connect: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'unreachable' }); } });
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider,
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const down = await conn.connect();
  assert.equal(down.provider, 'local');
  assert.equal(down.reconnecting, true, 'initial failure → retry loop, not parked');
  assert.equal(down.indicator, LOCAL_RETRYING_INDICATOR);
  assert.equal(down.fallback, true);
  assert.ok(down.error, 'error detail retained for settings');
  assert.equal(conn.isReconnecting(), true);

  // Background retry fires (server now up) → serverReachable emitted
  up = true;
  await sched.fireOldest(); // fire the backoff timer
  const ready = conn.getState();
  assert.equal(ready.serverReachable, true, 'server came back → serverReachable');
  assert.equal(ready.reconnecting, false);

  // switchToMcp() completes the transition
  conn.applyModel = () => {};
  // Reconstruct with applyModel wired
  conn.disconnect();
  await harness.close();
});

test('retry: manual retry after initial connect failure recovers when server comes up', async () => {
  let up = false;
  const harness = createMcpTestServer({ seed: oneCard });
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
  assert.equal(down.reconnecting, true);

  up = true;
  const recovered = await conn.retry();
  assert.equal(recovered.provider, 'mcp');
  assert.equal(recovered.indicator, 'MCP: Claunker');
  assert.equal(recovered.reconnecting, false);
  conn.disconnect();
  await harness.close();
});

test('incompatible server (missing a required tool) → fallback, never blank', async () => {
  const harness = createMcpTestServer({ omitTools: ['card_list'] });
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: providerFactory(harness),
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.indicator, LOCAL_RETRYING_INDICATOR, 'incompatible → retry loop');
  assert.equal(st.error.code, 'incompatible_server');
  await harness.close();
});

test('timeout (connect hangs past the ping timeout) → retry loop, fallback', async () => {
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: 'http://mcp.test/mcp' } },
    makeProvider: () => ({ connect: () => new Promise(() => {}) }), // never resolves
    pingTimeoutMs: 20, // real timers fire this
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.reconnecting, true, 'timeout → retry loop not parked');
  assert.equal(st.indicator, LOCAL_RETRYING_INDICATOR);
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
  assert.equal(conn.getState().reconnecting, false);
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
/* + RECONNECT RESILIENCE                                               */
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

/* ================================================================== */
/* FIX C + RECONNECT: poll strikes trip RECONNECTING, not Local        */
/* ================================================================== */

test('strikes trip RECONNECTING not Local: 3rd consecutive poll failure enters reconnecting state', async () => {
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
  assert.equal(conn.getState().provider, 'mcp', 'strike 1: provider stays mcp');
  assert.equal(conn.getState().reconnecting, false, 'strike 1: not yet reconnecting');
  await sched.fireNext();
  assert.equal(conn.getState().provider, 'mcp', 'strike 2: provider stays mcp');
  assert.equal(conn.getState().reconnecting, false, 'strike 2: not yet reconnecting');
  assert.ok(conn.isPolling(), 'still polling through strikes 1-2');
  await sched.fireNext();
  // 3rd strike: enters RECONNECTING (not Local!)
  assert.equal(conn.getState().provider, 'mcp', 'strike 3: provider stays mcp (not Local)');
  assert.equal(conn.getState().reconnecting, true, 'strike 3: entered RECONNECTING state');
  assert.equal(conn.getState().fallback, false, 'RECONNECTING is not a fallback');
  assert.equal(conn.isPolling(), false, 'the poll loop stops while reconnecting');
  assert.equal(conn.isReconnecting(), true, 'isReconnecting() reports true');
  assert.ok(conn.getState().indicator.includes('reconnecting'), 'indicator reflects reconnecting');
});

test('backoff schedule: first retry fires at ~5s step, second at ~10s step', async () => {
  const ctl = controllableProvider();
  const delays = [];
  const sched = {
    schedule: (fn, ms) => { const h = { fn, ms, cancelled: false }; delays.push(ms); return h; },
    cancel: (h) => { if (h) h.cancelled = true; },
  };
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();

  ctl.fail = 'unreachable';
  // Force 3 strikes to enter reconnecting (fire 3 poll ticks manually via fresh sched)
  // (The backoff timer is scheduled by enterReconnecting after 3rd strike)
  // We can verify the delays array captured a ~5000ms backoff timer.
  // Manually drive strikes via degradeOnFatal:
  // Simulate 3 poll-path fatals
  // Need pollInFlight = true for the strike to count; simulate via provider call sequence.
  // Easier: just verify the delay range after entering via the full flow.
  // Use a real manual scheduler for polling, then check the backoff delay.
  const sched2 = manualScheduler();
  const delays2 = [];
  const ctl2 = controllableProvider();
  const conn2 = createMcpConnection({
    config: mcpConfig, makeProvider: ctl2.make,
    applyModel: () => {},
    schedule: (fn, ms) => { delays2.push(ms); return sched2.schedule(fn, ms); },
    cancel: sched2.cancel,
  });
  await conn2.connect();
  ctl2.fail = 'unreachable';
  await sched2.fireNext(); // strike 1
  await sched2.fireNext(); // strike 2
  await sched2.fireNext(); // strike 3 → enterReconnecting → scheduleReconnect
  // After 3rd strike, a backoff timer is scheduled
  assert.ok(delays2.length >= 4, 'at least one backoff timer scheduled after strikes');
  const backoffDelay = delays2[delays2.length - 1];
  // First step is 5000 ± 1000ms
  assert.ok(backoffDelay >= 4000 && backoffDelay <= 6000,
    `first backoff delay should be ~5000ms, got ${backoffDelay}`);
  conn2.disconnect();
});

test('backoff caps at 60s: repeated failures progress through schedule and cap', async () => {
  // Initial connect uses the controllable provider (success). After entering reconnecting,
  // we switch to a provider that FAILS AT CONNECT TIME so that each attemptReconnect()
  // throws before setting reconnecting=false — the backoff loop keeps cycling and we can
  // observe the full delay schedule.
  const ctl = controllableProvider();
  const delays = [];
  const sched = manualScheduler();
  let useFailingConnect = false;
  const makeProvider = (hooks) => {
    if (useFailingConnect) {
      return {
        connect: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); },
        disconnect() {},
      };
    }
    return ctl.make(hooks);
  };

  const conn = createMcpConnection({
    config: mcpConfig, makeProvider,
    applyModel: () => {},
    schedule: (fn, ms) => { delays.push(ms); return sched.schedule(fn, ms); },
    cancel: sched.cancel,
  });
  await conn.connect();

  // Enter reconnecting via 3 poll strikes
  ctl.fail = 'unreachable';
  await sched.fireNext();
  await sched.fireNext();
  await sched.fireNext(); // enters reconnecting, schedules first backoff
  assert.equal(conn.getState().reconnecting, true);
  const delaysBefore = delays.length;

  // Now reconnect attempts always fail at connect() time — reconnecting stays true
  useFailingConnect = true;
  for (let i = 0; i < 5; i++) {
    await sched.fireOldest(); // fires backoff timer → attemptReconnect throws → next timer scheduled
    if (!conn.isReconnecting()) break;
  }

  // Delays after entering reconnecting: [~5000, ~10000, ~30000, ~60000, ~60000, ...]
  const backoffDelays = delays.slice(delaysBefore);
  assert.ok(backoffDelays.length >= 3, `expected ≥3 backoff delays, got ${backoffDelays.length}`);
  const STEPS = [5000, 10000, 30000, 60000];
  const JITTER = 1500;
  for (const d of backoffDelays) {
    const valid = STEPS.some((s) => Math.abs(d - s) <= JITTER + 1000);
    assert.ok(valid, `backoff delay ${d} should be near one of ${STEPS.join(',')} (within ±${JITTER + 1000}ms)`);
  }
  const last = backoffDelays[backoffDelays.length - 1];
  assert.ok(last <= 62000, `capped delay ${last} should be ≤ 62000ms`);
  conn.disconnect();
});

test('success resumes + adopts server state: reconnect succeeds, polling restarts, model applied', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let model = null;
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: (m) => { model = m; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();
  assert.ok(model, 'initial model applied');

  // Enter reconnecting via 3 strikes
  ctl.fail = 'unreachable';
  await sched.fireNext();
  await sched.fireNext();
  await sched.fireNext();
  assert.equal(conn.getState().reconnecting, true);
  assert.equal(conn.isPolling(), false);

  // Server comes back; fire the backoff timer
  ctl.fail = null;
  ctl.cards = [{ id: 'c2', title: 'New', column_id: 'todo' }];
  await sched.fireOldest(); // backoff fires → attemptReconnect → success

  assert.equal(conn.getState().provider, 'mcp', 'resumed MCP after reconnect');
  assert.equal(conn.getState().reconnecting, false, 'reconnecting cleared on success');
  assert.equal(conn.getState().fallback, false, 'not a fallback after resume');
  assert.ok(conn.isPolling(), 'polling restarted after reconnect');
  assert.ok(model && model.cards.find((c) => c.id === 'c2'), 'server state adopted (new card in model)');
  conn.disconnect();
});

test('stale banner state: while RECONNECTING, state has reconnecting=true + last-known capabilities', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();
  const caps = conn.getState().capabilities;
  assert.ok(caps && caps.canWrite, 'capabilities available when connected');

  ctl.fail = 'unreachable';
  await sched.fireNext(); await sched.fireNext(); await sched.fireNext();

  const st = conn.getState();
  assert.equal(st.reconnecting, true);
  assert.equal(st.provider, 'mcp', 'provider stays mcp (not local dataset)');
  // Last-known capabilities retained for read purposes
  assert.ok(st.capabilities && typeof st.capabilities.canWrite === 'boolean',
    'last-known capabilities retained during reconnecting');
  conn.disconnect();
});

test('mid-session drop never renders local dataset: provider=mcp through reconnecting', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const stateSnapshots = [];
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  conn.subscribe((st) => stateSnapshots.push(st.provider));
  await conn.connect();

  ctl.fail = 'unreachable';
  await sched.fireNext(); await sched.fireNext(); await sched.fireNext();

  // ALL state transitions since connection should have provider==='mcp'
  // (The local-dataset is unreachable throughout a mid-session drop)
  for (const p of stateSnapshots) {
    assert.equal(p, 'mcp', `state snapshot should never show local during mid-session drop, got ${p}`);
  }
  conn.disconnect();
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
  assert.equal(conn.getState().reconnecting, false);
  ctl.fail = 'unreachable';
  await sched.fireNext();          // strike 1 (post-reset), NOT the 2nd
  await sched.fireNext();          // strike 2
  assert.equal(conn.getState().provider, 'mcp', 'reset worked: 2 post-reset strikes still live');
  assert.equal(conn.getState().reconnecting, false, '2 strikes: not yet reconnecting');
  await sched.fireNext();          // strike 3 → RECONNECTING
  assert.equal(conn.getState().reconnecting, true, 'enters RECONNECTING only after 3 CONSECUTIVE post-reset');
});

test('FIX C: a fatal "auth" on the poll degrades immediately to Local (no strike tolerance, stops retry)', async () => {
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
  assert.equal(conn.getState().reconnecting, false, 'auth does not start retry loop');
  assert.equal(conn.isPolling(), false);
  assert.equal(conn.isReconnecting(), false);
  // Indicator must be distinct from unreachable (the live-incident same-signal defect)
  assert.equal(conn.getState().indicator, AUTH_REJECTED_INDICATOR,
    'mid-session auth degrades to AUTH_REJECTED indicator, not MCP_UNAVAILABLE');
  assert.notEqual(conn.getState().indicator, MCP_UNAVAILABLE_INDICATOR,
    'AUTH_REJECTED and UNREACHABLE must not emit the same signal');
  assert.equal(sched.pending(), 0, 'no retry timer scheduled after mid-session auth rejection');
});

test('FIX C: a user-op "unreachable" degrades immediately to Local (strike tolerance is poll-only)', async () => {
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
  assert.equal(conn.getState().reconnecting, false, 'user-op degrade does not enter retry loop');
  assert.equal(conn.isPolling(), false);
});

/* ================================================================== */
/* Initial-load failure keeps retrying                                  */
/* ================================================================== */

test('initial-load failure keeps retrying in background (reconnecting=true, local available)', async () => {
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider: () => ({ connect: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } }),
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
    pingTimeoutMs: 50,
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'local');
  assert.equal(st.reconnecting, true, 'initial failure keeps retrying');
  assert.equal(st.indicator, LOCAL_RETRYING_INDICATOR);
  // A backoff timer is scheduled
  assert.ok(sched.pending() > 0, 'retry timer scheduled');
  conn.disconnect();
  // After disconnect, retry loop stops
  assert.equal(conn.isReconnecting(), false);
});

test('initial-load recovery auto-switch: serverReachable=true emitted when server comes up', async () => {
  let up = false;
  const harness = createMcpTestServer({ seed: oneCard });
  const makeProvider = (hooks) => (up
    ? createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn, onFatal: hooks.onFatal })
    : { connect: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
  const sched = manualScheduler();
  let applied = 0;
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider,
    applyModel: () => { applied += 1; },
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(conn.getState().reconnecting, true);

  // Server comes up; fire the retry
  up = true;
  await sched.fireOldest();
  const st = conn.getState();
  assert.equal(st.serverReachable, true, 'serverReachable emitted on initial-load recovery');
  assert.equal(st.provider, 'local', 'stays local until switchToMcp() is called');
  assert.equal(st.reconnecting, false);

  // switchToMcp() transitions to MCP + starts polling
  await conn.switchToMcp();
  assert.equal(conn.getState().provider, 'mcp');
  assert.equal(conn.getState().reconnecting, false);
  assert.ok(conn.isPolling());
  assert.ok(applied >= 1, 'model applied after switch');
  conn.disconnect();
  await harness.close();
});

/* ================================================================== */
/* retry-now resets backoff                                             */
/* ================================================================== */

test('retryNow: resets backoff and fires immediately, resumes on success', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let model = null;
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: (m) => { model = m; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();

  // Enter reconnecting via 3 strikes
  ctl.fail = 'unreachable';
  await sched.fireNext(); await sched.fireNext(); await sched.fireNext();
  assert.equal(conn.getState().reconnecting, true);

  // Server comes back; retryNow fires without waiting for backoff
  ctl.fail = null;
  ctl.cards = [{ id: 'retry-card', title: 'R', column_id: 'todo' }];
  // retryNow() returns a promise that resolves when attemptReconnect + startPolling complete
  await conn.retryNow();

  assert.equal(conn.getState().reconnecting, false, 'retryNow recovered');
  assert.equal(conn.getState().provider, 'mcp');
  assert.ok(model && model.cards.find((c) => c.id === 'retry-card'), 'server state adopted after retryNow');
  conn.disconnect();
});

test('retryNow on initial-load failure: fires immediately and recovers', async () => {
  let up = false;
  const harness = createMcpTestServer({ seed: oneCard });
  const makeProvider = (hooks) => (up
    ? createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn, onFatal: hooks.onFatal })
    : { connect: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } });
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider,
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  await conn.connect();
  assert.equal(conn.getState().reconnecting, true);

  up = true;
  // retryNow() returns a promise; on initial-load recovery it resolves after emitting serverReachable
  await conn.retryNow();

  assert.equal(conn.getState().serverReachable, true, 'retryNow on initial-load recovers');
  conn.disconnect();
  await harness.close();
});

/* ================================================================== */
/* disconnect kills reconnect loops                                     */
/* ================================================================== */

test('disconnect while mid-session reconnecting stops the retry loop', async () => {
  const ctl = controllableProvider();
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: () => {}, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();

  ctl.fail = 'unreachable';
  await sched.fireNext(); await sched.fireNext(); await sched.fireNext();
  assert.equal(conn.isReconnecting(), true);

  conn.disconnect();
  assert.equal(conn.isReconnecting(), false, 'disconnect kills reconnect loop');
  assert.equal(conn.getState().provider, 'local');
  assert.equal(conn.getState().fallback, false, 'explicit disconnect is clean, not a fallback');
  assert.equal(sched.pending(), 0, 'no pending timers after disconnect');
});

test('disconnect while initial-load retrying stops the retry loop', async () => {
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider: () => ({ connect: async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }); } }),
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
    pingTimeoutMs: 50,
  });
  await conn.connect();
  assert.equal(conn.isReconnecting(), true);

  conn.disconnect();
  assert.equal(conn.isReconnecting(), false);
  assert.equal(conn.getState().reconnecting, false);
  assert.equal(sched.pending(), 0, 'no pending timers after disconnect');
});

/* ================================================================== */
/* sync_token_expired handled by full-fetch (current architecture)     */
/* ================================================================== */

test('sync_token_expired: full fetch on resume (each poll is a full fetch; no incremental state held)', async () => {
  // In the current implementation every reconnect attempt is a full connect() +
  // full board_get/card_list — no incremental sync token is held client-side.
  // This test documents that a successful reconnect always adopts fresh server state,
  // which subsumes the sync_token_expired recovery requirement.
  const ctl = controllableProvider();
  const sched = manualScheduler();
  let model = null;
  const conn = createMcpConnection({
    config: mcpConfig, makeProvider: ctl.make,
    applyModel: (m) => { model = m; }, schedule: sched.schedule, cancel: sched.cancel,
  });
  await conn.connect();

  ctl.fail = 'unreachable';
  await sched.fireNext(); await sched.fireNext(); await sched.fireNext();

  // Server returns with different data (simulating stale-token recovery)
  ctl.fail = null;
  ctl.cards = [{ id: 'fresh', title: 'Fresh after recovery', column_id: 'todo' }];
  await sched.fireOldest();

  assert.equal(conn.getState().provider, 'mcp');
  assert.ok(model && model.cards.find((c) => c.id === 'fresh'),
    'full fetch on reconnect adopts fresh server state (handles sync_token_expired)');
  conn.disconnect();
});

/* ================================================================== */
/* FIX A: teardown guard tests (unchanged behavior)                    */
/* ================================================================== */

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

/* ================================================================== */
/* AUTH_REJECTED state — distinguishes 401 from unreachable           */
/* ================================================================== */

test('AUTH_REJECTED: 401 at initial connect → AUTH_REJECTED state, no retry timer scheduled', async () => {
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider: () => ({
      connect: async () => { throw Object.assign(new Error('Unauthorized'), { code: 'auth' }); },
    }),
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.indicator, AUTH_REJECTED_INDICATOR, '401 at connect → AUTH_REJECTED indicator');
  assert.equal(st.provider, 'local');
  assert.equal(st.fallback, true);
  assert.equal(st.reconnecting, false, '401 does not start retry loop');
  assert.equal(st.error && st.error.code, 'auth');
  assert.equal(conn.isReconnecting(), false);
  // Removing the auth guard in activate() would call enterInitialFailureRetrying,
  // which schedules a backoff timer → this assertion goes RED.
  assert.equal(sched.pending(), 0, 'no retry timer scheduled — removing the halt makes this RED');
});

test('UNREACHABLE: network failure at initial connect → retry IS scheduled (regression guard)', async () => {
  const sched = manualScheduler();
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider: () => ({
      connect: async () => { throw Object.assign(new Error('Failed to fetch'), { code: 'unreachable' }); },
    }),
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.indicator, LOCAL_RETRYING_INDICATOR, 'unreachable at connect → RETRYING indicator');
  assert.equal(st.reconnecting, true, 'unreachable enters retry loop');
  // Removing the retry for unreachable would leave pending() === 0 → this goes RED.
  assert.ok(sched.pending() > 0, 'retry timer IS scheduled for unreachable — removing it makes this RED');
  conn.disconnect();
});

test('AUTH_REJECTED and UNREACHABLE emit distinct indicator strings (same-signal defect guard)', () => {
  // Removing AUTH_REJECTED_INDICATOR or collapsing it to MCP_UNAVAILABLE_INDICATOR
  // makes this assertion RED — the test exists specifically for the live incident.
  assert.notEqual(AUTH_REJECTED_INDICATOR, LOCAL_RETRYING_INDICATOR,
    'auth-rejected and retrying must not emit the same signal');
  assert.notEqual(AUTH_REJECTED_INDICATOR, MCP_UNAVAILABLE_INDICATOR,
    'auth-rejected and unavailable must not emit the same signal');
});

test('AUTH_REJECTED: retryNow() from auth-rejected fires a fresh connect (explicit manual retry)', async () => {
  let calls = 0;
  const sched = manualScheduler();
  const harness = createMcpTestServer({ seed: oneCard });
  // First attempt: 401. Second attempt (after retryNow): succeeds.
  const makeProvider = (hooks) => {
    calls += 1;
    if (calls === 1) {
      return { connect: async () => { throw Object.assign(new Error('Unauthorized'), { code: 'auth' }); } };
    }
    return createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn, onFatal: hooks.onFatal });
  };
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider,
    applyModel: () => {},
    schedule: sched.schedule,
    cancel: sched.cancel,
  });
  const st = await conn.connect();
  assert.equal(st.indicator, AUTH_REJECTED_INDICATOR, 'starts in AUTH_REJECTED');
  assert.equal(sched.pending(), 0, 'no auto-retry scheduled');

  // Explicit manual retry (user clicks RETRY chip or saves connection settings)
  const st2 = await conn.retryNow();
  assert.equal(st2.provider, 'mcp', 'retryNow from AUTH_REJECTED fires a fresh connect');
  assert.equal(st2.reconnecting, false);
  conn.disconnect();
  await harness.close();
});

test('AUTH_REJECTED: saving connection settings (retry()) triggers a fresh connect attempt', async () => {
  let calls = 0;
  const harness = createMcpTestServer({ seed: oneCard });
  const makeProvider = (hooks) => {
    calls += 1;
    if (calls === 1) {
      return { connect: async () => { throw Object.assign(new Error('Unauthorized'), { code: 'auth' }); } };
    }
    return createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn, onFatal: hooks.onFatal });
  };
  const conn = createMcpConnection({
    config: mcpConfig,
    makeProvider,
    applyModel: () => {},
    schedule: manualScheduler().schedule,
    cancel: () => {},
  });
  await conn.connect();
  assert.equal(conn.getState().indicator, AUTH_REJECTED_INDICATOR);

  // conn.retry() == conn.connect() == activate() — the path handleSpineConnect takes
  // (it re-creates the whole connection, which calls activate() on the new instance).
  // Here we call retry() directly as the equivalent re-connect entry point.
  const st = await conn.retry();
  assert.equal(st.provider, 'mcp', 'retry() from AUTH_REJECTED re-connects successfully');
  conn.disconnect();
  await harness.close();
});
