/**
 * MCP connection controller — auto-detect provider selection + the polling loop
 * that renders live spine state on the board. PURE and injectable, the same
 * shape as drive-sync.js: every ambient (provider factory, timers, the board
 * refresh path) is injected, so it runs in Node against a conforming in-process
 * MCP server with zero live network.
 *
 * It is the SELECTION SEAM, not a board rewrite. The board consumes the active
 * provider's data unchanged: the controller polls board_get + card_list and
 * pushes the result through the injected `applyModel` ({ columns, cards, flags })
 * — the same role drive-sync's `applyBlob` plays.
 *
 * Connection flow:
 *   - no MCP URL                             → LocalProvider, "Local" indicator
 *   - URL + reachable + required tools       → MCPProvider, "MCP: <name>", flags
 *   - URL + unreachable/incompatible/timeout → retries with exponential backoff;
 *                                              shows "Local (MCP unavailable ·
 *                                              retrying…)" meanwhile; auto-switches
 *                                              to MCP on success if no local edits
 *                                              (otherwise surfaces a switch affordance)
 *   - mid-session poll strikes ≥ limit       → RECONNECTING state: keeps rendering
 *                                              last-known MCP cards with stale banner;
 *                                              retries with backoff; resumes polling on
 *                                              success. NEVER collapses to the empty
 *                                              local dataset while reconnecting.
 *
 * realtime:false (v1 is tools-only) → NO subscription. The board POLLS
 * board_get/card_list at a configurable interval; the server's `column_id` rides
 * through untouched (the provider never recomputes it).
 */

import { createMCPProvider } from './spine-mcp-provider.js';

export const LOCAL_INDICATOR = 'Local';
export const MCP_UNAVAILABLE_INDICATOR = 'Local (MCP unavailable)';
export const LOCAL_RETRYING_INDICATOR = 'Local (MCP unavailable · retrying…)';
export const LOCAL_SERVER_REACHABLE_INDICATOR = 'Local (MCP unavailable · server reachable)';
export const AUTH_REJECTED_INDICATOR = 'Local (MCP auth rejected)';
export const mcpIndicator = (name) => `MCP: ${name}`;
export const mcpReconnectingIndicator = (name) => `MCP: ${name} (reconnecting…)`;

const DEFAULT_POLL_MS = 5000;
const DEFAULT_PING_TIMEOUT_MS = 3000;

/** Background-poll tolerance for a fatal 'unreachable' (FIX C): ride out the first
 *  STRIKE_LIMIT-1 consecutive poll failures (board stays live, possibly stale), enter
 *  RECONNECTING on the STRIKE_LIMIT-th consecutive. A clean poll resets the count.
 *  'auth' and user-initiated ops never wait — they degrade on the first fatal. */
const POLL_UNREACHABLE_STRIKE_LIMIT = 3;

/** Reconnect backoff schedule (ms). Capped at the last value; small jitter applied. */
const BACKOFF_STEPS = [5000, 10000, 30000, 60000];
const BACKOFF_JITTER_MS = 2000; // ±1 s around each step

function backoffMs(attempt) {
  const base = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)];
  return base + (Math.random() * BACKOFF_JITTER_MS - BACKOFF_JITTER_MS / 2);
}

/** Defensive fallback if a server returns a board with no columns (a real board
 *  always carries its own). Reserved semantic-state ids per spec §Reserved IDs. */
export const SPINE_BOARD_COLUMNS = [
  { id: 'todo', label: 'To Do', accentKey: 'textDim' },
  { id: 'in_progress', label: 'In Progress', accentKey: 'ice' },
  { id: 'blocked', label: 'Blocked', accentKey: 'coral' },
  { id: 'done', label: 'Done', accentKey: 'mint' },
];

/** LocalProvider feature flags — the optional MCP features don't apply. */
const LOCAL_FLAGS = Object.freeze({ escalations: false, artifacts: false, columns: false, tags: false, realtime: false });

/** Theme accent keys the board understands; a server column `color` naming one
 *  is used directly, otherwise a sensible accent is derived from the column id. */
const ACCENT_KEYS = ['textDim', 'frost', 'ice', 'amber', 'mint', 'coral'];
const RESERVED_ACCENT = { backlog: 'textDim', todo: 'textDim', in_progress: 'ice', blocked: 'coral', done: 'mint' };

/**
 * Map a server Board's columns ({ id, name, color, order }) onto the board's
 * render shape ({ id, label, accentKey }), sorted by the LexoRank `order`. The
 * `id` is preserved verbatim so polled cards (carrying `column_id`) land in the
 * right column. This is the one site that adapts the spec board shape — flagged
 * in the provider's divergence notes.
 */
export function toBoardColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return SPINE_BOARD_COLUMNS;
  return columns
    .slice()
    .sort((a, b) => (a.order > b.order ? 1 : a.order < b.order ? -1 : 0))
    .map((c, i) => ({
      id: c.id,
      label: c.name ?? c.label ?? c.id,
      accentKey: ACCENT_KEYS.includes(c.color) ? c.color : (RESERVED_ACCENT[c.id] || ACCENT_KEYS[i % ACCENT_KEYS.length]),
    }));
}

function withTimeout(promise, ms, schedule, cancel) {
  return new Promise((resolve, reject) => {
    const h = schedule(() => reject(Object.assign(new Error('mcp ping timeout'), { code: 'timeout' })), ms);
    promise.then(
      (v) => { cancel(h); resolve(v); },
      (e) => { cancel(h); reject(e); },
    );
  });
}

/**
 * @param {object}   opts
 * @param {object}   opts.config        kanbantt_config: { data_source, mcp:{url,auth_token}, poll_interval_ms }
 * @param {()=>object} opts.makeProvider factory → an UNCONNECTED MCPProvider (controller owns connect()/timeout)
 * @param {(model)=>void} [opts.applyModel] the board refresh path (gets { columns, cards, flags })
 * @param {(fn,ms)=>any}  [opts.schedule] / [opts.cancel]   timer injection
 * @param {number}   [opts.pollIntervalMs] / [opts.pingTimeoutMs]
 * @param {boolean|()=>boolean} [opts.includeArchived]  whether the poll's card_list
 *        asks for archived cards (spec v0.4.0 include_archived). A FUNCTION is
 *        re-read every tick, so a UI "Show archived" toggle changes the very next
 *        poll without reconnecting. The built model carries which mode produced it
 *        (`includedArchived`) — the consumer's PURGE GUARD keys off that flag (see
 *        reconcileSpineModel).
 */
export function createMcpConnection({
  config = {},
  makeProvider,
  applyModel = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  pollIntervalMs,
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
  includeArchived = false,
} = {}) {
  const interval = pollIntervalMs || config.poll_interval_ms || DEFAULT_POLL_MS;
  const mcpUrl = config.mcp && config.mcp.url;
  const wantsMcp = !!mcpUrl && config.data_source !== 'local';

  let state = localState(false, null);
  let provider = null; // active MCPProvider while state.provider === 'mcp' AND !state.reconnecting
  let pollHandle = null;
  const listeners = new Set();
  // Teardown guard (FIX A): once disposed, EVERY async continuation — a late-resolving
  // connect, an in-flight poll, a subscriber notify, applyModel, degradeOnFatal — early-
  // returns, so a connection torn down (config switch / StrictMode double-unmount) can
  // neither resurrect itself nor clobber the successor session's React state. Idempotent.
  let disposed = false;
  // Contextual degrade accounting (FIX C): a background-poll 'unreachable' rides out
  // POLL_UNREACHABLE_STRIKE_LIMIT-1 consecutive failures. pollInFlight is true precisely
  // while a poll's provider call is on the stack, so degradeOnFatal can tell a poll-
  // originated fatal (count a strike) from a user-op fatal (degrade instantly).
  let pollInFlight = false;
  let unreachableStrikes = 0;

  // Reconnect state: the controller cycles through a backoff retry loop on both
  // mid-session poll failures and initial-load failures. wasConnected distinguishes
  // which recovery path applies (resume polling vs surface "switch?" affordance).
  let reconnecting = false;       // are we in a backoff retry loop?
  let reconnectAttempt = 0;       // how many backoff steps have elapsed
  let reconnectHandle = null;     // the pending backoff timer handle
  let savedServer = null;         // last successfully negotiated server info
  let savedCaps = null;           // last capabilities (kept for reads during reconnecting)
  let savedFlags = null;          // last featureFlags
  let wasConnected = false;       // did we ever reach a live MCP state?
  let authRejected = false;       // true while in AUTH_REJECTED state (no auto-retry; explicit only)
  // Initial-load recovery: when the background retry succeeds but local edits were
  // made, we park the new provider here and surface a "switch?" affordance instead of
  // auto-switching. App.jsx checks its own localEdited tracking and may call switchToMcp().
  let pendingMcpProvider = null;
  let pendingMcpResult = null;    // { server, caps } for pendingMcpProvider

  function localState(fallback, error) {
    return {
      provider: 'local',
      reconnecting: false,
      serverReachable: false,
      indicator: fallback ? MCP_UNAVAILABLE_INDICATOR : LOCAL_INDICATOR,
      fallback: !!fallback,
      server: null,
      capabilities: null,
      featureFlags: LOCAL_FLAGS,
      error: error || null,
    };
  }

  function authRejectedState(error) {
    return {
      provider: 'local',
      reconnecting: false,
      authRejected: true,
      serverReachable: false,
      indicator: AUTH_REJECTED_INDICATOR,
      fallback: true,
      server: null,
      capabilities: null,
      featureFlags: LOCAL_FLAGS,
      error: error || null,
    };
  }
  const getState = () => ({ ...state });
  const emit = () => { if (disposed) return; for (const fn of listeners) fn(getState()); };

  function setLocal(fallback, error) {
    stopPolling();
    provider = null;
    state = localState(fallback, error);
    emit();
  }

  function stopReconnect() {
    if (reconnectHandle != null) { cancel(reconnectHandle); reconnectHandle = null; }
    reconnecting = false;
    reconnectAttempt = 0;
  }

  function reconnectingMcpState() {
    return {
      provider: 'mcp',
      reconnecting: true,
      serverReachable: false,
      indicator: savedServer ? mcpReconnectingIndicator(savedServer.name) : 'MCP: (reconnecting…)',
      fallback: false,
      server: savedServer,
      capabilities: savedCaps,
      featureFlags: savedFlags || LOCAL_FLAGS,
      error: null,
    };
  }

  // Enter reconnect loop after mid-session poll strike limit.
  // Keeps provider === 'mcp' (so mcpActive stays true, board keeps last-known data).
  function enterReconnecting() {
    if (disposed || reconnecting) return;
    reconnecting = true;
    reconnectAttempt = 0;
    stopPolling();
    if (provider && typeof provider.disconnect === 'function') {
      try { provider.disconnect(); } catch { /* best effort */ }
    }
    provider = null;
    state = reconnectingMcpState();
    emit();
    scheduleReconnect();
  }

  // Enter retry loop after a failed initial connect.
  // Stays provider === 'local' (no MCP data to preserve); the board renders local store.
  function enterInitialFailureRetrying(error) {
    if (disposed) return;
    reconnecting = true;
    reconnectAttempt = 0;
    state = {
      provider: 'local',
      reconnecting: true,
      serverReachable: false,
      indicator: LOCAL_RETRYING_INDICATOR,
      fallback: true,
      server: null,
      capabilities: null,
      featureFlags: LOCAL_FLAGS,
      error: error || null,
    };
    emit();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || !reconnecting) return;
    const delay = backoffMs(reconnectAttempt);
    reconnectHandle = schedule(async () => {
      reconnectHandle = null;
      if (disposed || !reconnecting) return;
      try {
        await attemptReconnect();
      } catch {
        if (disposed) return;
        reconnectAttempt += 1;
        scheduleReconnect();
      }
    }, delay);
  }

  // Single reconnect attempt. Throws on failure (caller schedules next backoff).
  async function attemptReconnect() {
    if (disposed || !reconnecting) return;
    let p;
    try {
      p = makeProvider({ onFatal: degradeOnFatal });
      const res = await withTimeout(p.connect(), pingTimeoutMs, schedule, cancel);
      if (disposed) { try { p.disconnect(); } catch { /* best effort */ } return; }

      const caps = res.capabilities;
      reconnecting = false;
      reconnectAttempt = 0;
      reconnectHandle = null;

      if (wasConnected) {
        // Mid-session recovery: resume MCP with fresh provider.
        savedServer = res.server;
        savedCaps = caps;
        savedFlags = { escalations: !!caps.escalations, artifacts: !!caps.artifacts, columns: !!caps.columns, tags: !!caps.tags, realtime: !!caps.realtime };
        provider = p;
        const indicator = caps.canWrite
          ? mcpIndicator(res.server.name)
          : `${mcpIndicator(res.server.name)} (read-only)`;
        state = {
          provider: 'mcp',
          reconnecting: false,
          serverReachable: false,
          indicator,
          fallback: false,
          server: res.server,
          capabilities: caps,
          featureFlags: savedFlags,
          error: null,
        };
        emit();
        await startPolling();
      } else {
        // Initial-load recovery: emit serverReachable so App.jsx decides whether to
        // auto-switch (no local edits) or surface the "switch?" affordance (local edits made).
        pendingMcpProvider = p;
        pendingMcpResult = { server: res.server, caps };
        state = {
          provider: 'local',
          reconnecting: false,
          serverReachable: true,
          indicator: LOCAL_SERVER_REACHABLE_INDICATOR,
          fallback: true,
          server: null,
          capabilities: null,
          featureFlags: LOCAL_FLAGS,
          error: null,
        };
        emit();
      }
    } catch (e) {
      if (p) { try { p.disconnect(); } catch { /* best effort */ } }
      throw e; // let scheduleReconnect's catch increment the attempt counter
    }
  }

  /**
   * Mid-session degrade sink. A FATAL auth/connection failure on ANY provider op —
   * poll, card write, re-tier, escalation resolve; every op funnels through the
   * provider's call() choke point — can tear the WHOLE connection down. Wired into
   * the provider as `onFatal` (see activate). setLocal emits, so the
   * subscribe→setSpineModel(null) cascade fires and the board UI snaps to
   * disconnected. Idempotent: once we've fallen back (state.provider !== 'mcp'),
   * a burst of in-flight failing ops is ignored (no thrash). ONLY the provider's
   * fatal classes ('auth' → 401, 'unreachable' → network/CORS) reach here;
   * validation_failed/conflict are op-level (isError results) and stay with the
   * caller's loud-revert.
   *
   * CONTEXTUAL DEGRADE (FIX C + reconnect):
   *   'auth' → deterministic, stop any retry loop, degrade to Local permanently.
   *   'unreachable' from USER-INITIATED op → degrade to Local instantly (no retry).
   *   'unreachable' from BACKGROUND POLL → tolerate STRIKE_LIMIT-1 consecutive
   *     failures, then enter RECONNECTING (NOT Local) on the STRIKE_LIMIT-th.
   *   already reconnecting → ignore (the backoff loop manages retries).
   */
  function degradeOnFatal(err) {
    if (disposed) return;
    const kind = (err && err.fatalKind) || (err && err.code) || 'unreachable';

    if (kind === 'auth') {
      // Deterministic: a rejected token never heals. Stop any retry loop and
      // fall back to AUTH_REJECTED permanently regardless of current state.
      stopReconnect();
      unreachableStrikes = 0;
      stopPolling();
      if (pendingMcpProvider) { try { pendingMcpProvider.disconnect(); } catch { /* best effort */ } pendingMcpProvider = null; pendingMcpResult = null; }
      if (provider && typeof provider.disconnect === 'function') {
        try { provider.disconnect(); } catch { /* best effort */ }
      }
      provider = null;
      authRejected = true;
      state = authRejectedState({ code: 'auth', message: (err && err.message) || 'authentication failed' });
      emit();
      return;
    }

    // If the backoff loop is already running, ignore — it manages retries.
    if (reconnecting) return;

    if (state.provider !== 'mcp') return; // already local (user-op post-degrade burst)

    // 'unreachable' from the poll path (pollInFlight): count a strike, ride it out
    // until the limit, then enter reconnecting (NOT Local — the board keeps last data).
    if (pollInFlight) {
      unreachableStrikes += 1;
      if (unreachableStrikes < POLL_UNREACHABLE_STRIKE_LIMIT) return;
      unreachableStrikes = 0;
      enterReconnecting();
      return;
    }

    // 'unreachable' from a user-initiated op: instant degrade to Local.
    // (Strike tolerance is poll-only per spec; user-op failures are synchronous
    // evidence the spine is gone, not a transient network blip.)
    unreachableStrikes = 0;
    setLocal(true, { code: 'unreachable', message: (err && err.message) || 'connection lost' });
  }

  /* ---- polling (only while MCP is active and not reconnecting; realtime:false ⇒ poll) ---- */
  function buildModel(board, cards, includedArchived) {
    return {
      columns: toBoardColumns(board && board.columns),
      cards: (cards || []).filter((c) => c && c.column_id != null),
      flags: state.featureFlags,
      // Which fetch mode produced this model (spec v0.4.0): only a model built from
      // an include_archived:true fetch carries PURGE AUTHORITY over archived cards —
      // the consumer's reconcile (reconcileSpineModel) keys off this flag.
      includedArchived: !!includedArchived,
    };
  }
  async function pollOnce() {
    if (disposed || state.provider !== 'mcp' || state.reconnecting || !provider) return;
    // Capture the active provider: a mid-poll teardown/degrade nulls the closure `provider`,
    // and the captured `active` keeps the in-flight calls from crashing on it.
    const active = provider;
    // Full snapshot each tick (sync_token incremental sync is a later
    // optimization): board_get for columns, card_list for the live cards. The
    // server's `column_id` is authoritative — never recomputed here.
    pollInFlight = true; // marks the poll path for degradeOnFatal's strike accounting (FIX C)
    try {
      // Re-read per tick so a "Show archived" toggle flips the NEXT poll's fetch.
      const incArch = typeof includeArchived === 'function' ? !!includeArchived() : !!includeArchived;
      const { board } = await active.getBoard();
      const { cards } = await active.list({ includeDeleted: false, includeArchived: incArch });
      // Re-check AFTER the awaits (FIX A): a teardown (disconnect) or a mid-poll degrade can
      // land while these were in flight. Without this gate the continuation would call
      // applyModel (setSpineModel) after the owning effect was cleaned up — the exact
      // successor-clobber the disposed guard closes.
      if (disposed || state.provider !== 'mcp' || state.reconnecting) return;
      unreachableStrikes = 0; // a clean poll cycle heals the background-strike counter (FIX C)
      applyModel(buildModel(board, cards, incArch));
    } finally {
      pollInFlight = false;
    }
  }
  function scheduleNext() {
    // Guard: do not re-arm during reconnect (state.reconnecting true) or after teardown.
    if (disposed || state.provider !== 'mcp' || state.reconnecting) return;
    pollHandle = schedule(async () => {
      pollHandle = null;
      if (disposed) return; // a timer that fired after teardown does nothing (FIX A)
      try {
        await pollOnce();
      } catch (e) {
        // The poll threw. Three cases: (1) a fatal that ENTERED RECONNECTING — the
        // STRIKE_LIMIT-th consecutive 'unreachable' — already ran onFatal →
        // degradeOnFatal → enterReconnecting, so state.reconnecting is now true and
        // the guard below stops the loop cleanly; (2) a TOLERATED unreachable strike
        // (below the limit) left state 'mcp', !reconnecting — keep polling so a
        // recovery heals it; (3) a non-fatal poll error must NOT silently kill the loop.
        // (2) and (3) re-arm below; teardown is caught by the disposed/reconnecting guard.
        if (disposed || state.provider !== 'mcp' || state.reconnecting) return;
        console.warn('MCP poll error (non-fatal or tolerated strike); continuing to poll:', (e && e.message) || e);
      }
      scheduleNext();
    }, interval);
  }
  async function startPolling() {
    stopPolling();
    await pollOnce();   // immediate first paint
    scheduleNext();     // then the recurring poll (single timer, never stacked)
  }
  function stopPolling() {
    if (pollHandle != null) { cancel(pollHandle); pollHandle = null; }
  }

  /* ---- the auto-detect activation (connect / retry) ---- */
  async function activate() {
    // Reset any in-progress reconnect loop (manual retry or fresh connect).
    stopReconnect();
    authRejected = false;
    // Discard any pending initial-load provider that the user hasn't accepted yet.
    if (pendingMcpProvider) {
      try { pendingMcpProvider.disconnect(); } catch { /* best effort */ }
      pendingMcpProvider = null;
      pendingMcpResult = null;
    }
    if (!wantsMcp) { setLocal(false, null); return getState(); }
    let p;
    try {
      // Pass the mid-session degrade sink to the provider: a fatal auth/connection
      // failure on any subsequent op routes back here to degrade or enterReconnecting.
      p = makeProvider({ onFatal: degradeOnFatal });
      // connect() runs the MCP initialize handshake + tools/list and rejects a
      // server missing any REQUIRED_TOOLS (incompatible_server) before we go live.
      const res = await withTimeout(p.connect(), pingTimeoutMs, schedule, cancel);
      // Teardown can land while connect was in flight (config switch / StrictMode
      // unmount). Do NOT resurrect (FIX A — the connect-race half): close the just-opened
      // provider and bail without touching state, subscribers, or the poll loop.
      if (disposed) {
        try { if (typeof p.disconnect === 'function') p.disconnect(); } catch { /* best effort */ }
        return getState();
      }
      const caps = res.capabilities;
      wasConnected = true;
      savedServer = res.server;
      savedCaps = caps;
      savedFlags = { escalations: !!caps.escalations, artifacts: !!caps.artifacts, columns: !!caps.columns, tags: !!caps.tags, realtime: !!caps.realtime };
      provider = p;
      // A server advertising the read pair but not all four card_* write tools is
      // a valid read-only backend (caps.canWrite === false). Signal it in the
      // indicator so the board chip reads "MCP: <name> (read-only)"; the board
      // reads caps.canWrite (threaded via state.capabilities) to gate writes.
      const indicator = caps.canWrite
        ? mcpIndicator(res.server.name)
        : `${mcpIndicator(res.server.name)} (read-only)`;
      state = {
        provider: 'mcp',
        reconnecting: false,
        serverReachable: false,
        indicator,
        fallback: false,
        server: res.server,
        capabilities: caps,
        featureFlags: savedFlags,
        error: null,
      };
      emit();
      await startPolling();
      return getState();
    } catch (e) {
      if (!disposed) {
        if (e.code === 'auth') {
          // A 401 at connect time is a deterministic verdict: retrying with the same
          // credential cannot succeed. Enter AUTH_REJECTED immediately — no backoff loop.
          authRejected = true;
          state = authRejectedState({ code: 'auth', message: e.message });
          emit();
        } else {
          // Network / unreachable / incompatible — enter a background retry loop so the
          // user can keep using Local mode while the spine recovers.
          console.warn('MCP connect failed; entering retry loop:', (e && e.message) || e, e);
          enterInitialFailureRetrying({ code: e.code || 'unreachable', message: e.message });
        }
      }
      return getState();
    }
  }

  return {
    connect: activate,
    retry: activate,
    disconnect() {
      // Idempotent teardown (FIX A): flip disposed FIRST so every in-flight continuation
      // (connect completion, poll, subscriber notify, applyModel, degradeOnFatal) early-
      // returns, then release the provider and snap state to Local. Safe under StrictMode's
      // double unmount/remount — a second call is a no-op.
      if (disposed) return;
      disposed = true;
      authRejected = false;
      // Kill the reconnect backoff loop before anything else.
      stopReconnect();
      if (pendingMcpProvider) {
        try { pendingMcpProvider.disconnect(); } catch { /* best effort */ }
        pendingMcpProvider = null;
        pendingMcpResult = null;
      }
      if (provider && typeof provider.disconnect === 'function') {
        try { provider.disconnect(); } catch { /* best effort */ }
      }
      setLocal(false, null); // stopPolling + provider=null + state→Local(clean); emit is disposed-gated (no notify)
    },
    getState,
    /** The active MCP provider (board writes go through it; a stale-version write
     *  surfaces the SAME code:'conflict' shape as a local conflict — parity). */
    getProvider: () => provider,
    supportsRealtime: () => !!(state.capabilities && state.capabilities.realtime),
    /** Manual sync affordance (board "refresh" button) — one poll cycle, no timer. */
    pollNow: pollOnce,
    isPolling: () => pollHandle != null,
    isReconnecting: () => reconnecting,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Manual "retry now" affordance on the reconnect indicator. Cancels any pending
     *  backoff timer and fires an immediate reconnect attempt, resetting the step count.
     *  Also serves as the explicit manual retry from AUTH_REJECTED state: the token may
     *  have been updated in memory (e.g. the user pasted a new token elsewhere), so an
     *  explicit retry is always honoured — it calls activate() fresh. */
    retryNow() {
      if (authRejected) return activate(); // explicit retry from AUTH_REJECTED: fresh connect
      if (!reconnecting || disposed) return Promise.resolve();
      if (reconnectHandle != null) { cancel(reconnectHandle); reconnectHandle = null; }
      reconnectAttempt = 0;
      return attemptReconnect().catch(() => {
        if (!disposed) { reconnectAttempt = 1; scheduleReconnect(); }
      });
    },

    /** Called by App.jsx when the user makes a local card mutation while the initial-load
     *  retry is active. The connection itself is stateless on this — App.jsx tracks
     *  localEditedRef and decides whether to auto-switch or show a "switch?" affordance
     *  when serverReachable becomes true. This method is a no-op hook for parity. */
    notifyLocalEdited() { /* App.jsx owns local-edit tracking */ },

    /** Accept the pending initial-load provider and switch to MCP mode.
     *  Called by App.jsx either automatically (no local edits) or after user consent
     *  (local edits made → "switch?" affordance). Resolves once the first poll paints. */
    async switchToMcp() {
      if (disposed || !pendingMcpProvider) return;
      const p = pendingMcpProvider;
      const result = pendingMcpResult;
      pendingMcpProvider = null;
      pendingMcpResult = null;
      wasConnected = true;
      savedServer = result.server;
      savedCaps = result.caps;
      savedFlags = { escalations: !!result.caps.escalations, artifacts: !!result.caps.artifacts, columns: !!result.caps.columns, tags: !!result.caps.tags, realtime: !!result.caps.realtime };
      provider = p;
      const indicator = result.caps.canWrite
        ? mcpIndicator(result.server.name)
        : `${mcpIndicator(result.server.name)} (read-only)`;
      state = {
        provider: 'mcp',
        reconnecting: false,
        serverReachable: false,
        indicator,
        fallback: false,
        server: result.server,
        capabilities: result.caps,
        featureFlags: savedFlags,
        error: null,
      };
      emit();
      await startPolling();
    },
  };
}

/**
 * PURGE-RULE GUARD (spec v0.4.0 §Archive, "Full-fetch purge interaction"): reconcile
 * a freshly polled model onto the previously held one WITHOUT letting a default
 * fetch purge archived cards. Archived cards are absent from a default full fetch
 * BY DESIGN — absence there is NOT deletion — so a locally-held card with non-null
 * `archived_at` that the new model omits is RETAINED (carried over verbatim). Purge
 * authority over archived cards requires an include_archived:true fetch: a model
 * built from one (`includedArchived`) replaces outright, and absence THERE is
 * authoritative. A card the new model DOES carry always takes the server copy
 * (fresh version/flags win — retention only fills absence, never overrides).
 * Non-archived cards keep the existing semantics: absent from any full fetch ⇒ gone.
 *
 * Pure and side-effect free — the board wires it as
 * `applyModel: (next) => setSpineModel(prev => reconcileSpineModel(prev, next))`.
 */
export function reconcileSpineModel(prev, next) {
  if (!prev || !next || next.includedArchived) return next;
  const seen = new Set((next.cards || []).map((c) => c.id));
  const retained = (prev.cards || []).filter((c) => c && c.archived_at != null && !seen.has(c.id));
  return retained.length ? { ...next, cards: [...(next.cards || []), ...retained] } : next;
}

/**
 * Production entry: build the controller from kanbantt_config with a real MCP
 * provider (Streamable HTTP + Bearer auth from config). The board's boot wiring
 * passes its refresh path as `applyModel` — no board component changes.
 */
export function createMcpConnectionFromConfig({ config, applyModel, authToken, fetchFn, schedule, cancel, pollIntervalMs, includeArchived } = {}) {
  // The controller passes its degrade sink as `hooks.onFatal` when it builds the
  // provider (see activate); thread it through so a mid-session fatal error on any op
  // routes back to degradeOnFatal.
  const makeProvider = (hooks = {}) => createMCPProvider({
    baseUrl: config.mcp.url,
    // Auth v1: an explicit in-memory token (remember_token: false) takes precedence;
    // falls back to the stored config token (remember_token: true path).
    authToken: authToken != null ? authToken : (config.mcp && config.mcp.auth_token),
    fetchFn,
    onFatal: hooks.onFatal,
  });
  return createMcpConnection({ config, makeProvider, applyModel, schedule, cancel, pollIntervalMs, includeArchived });
}
