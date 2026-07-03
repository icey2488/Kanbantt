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
 *   - URL + unreachable/incompatible/timeout → LocalProvider, "Local (MCP
 *                                              unavailable)" + retry; never blank
 *
 * realtime:false (v1 is tools-only) → NO subscription. The board POLLS
 * board_get/card_list at a configurable interval; the server's `column_id` rides
 * through untouched (the provider never recomputes it).
 */

import { createMCPProvider } from './spine-mcp-provider.js';

export const LOCAL_INDICATOR = 'Local';
export const MCP_UNAVAILABLE_INDICATOR = 'Local (MCP unavailable)';
export const mcpIndicator = (name) => `MCP: ${name}`;

const DEFAULT_POLL_MS = 5000;
const DEFAULT_PING_TIMEOUT_MS = 3000;

/** Background-poll tolerance for a fatal 'unreachable' (FIX C): ride out the first
 *  STRIKE_LIMIT-1 consecutive poll failures (board stays live, possibly stale), degrade
 *  to Local on the STRIKE_LIMIT-th consecutive. A clean poll resets the count. 'auth' and
 *  user-initiated ops never wait — they degrade on the first fatal. */
const POLL_UNREACHABLE_STRIKE_LIMIT = 3;

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
  let provider = null; // active MCPProvider while state.provider === 'mcp'
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

  function localState(fallback, error) {
    return {
      provider: 'local',
      indicator: fallback ? MCP_UNAVAILABLE_INDICATOR : LOCAL_INDICATOR,
      fallback: !!fallback,
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

  /**
   * Mid-session degrade sink. A FATAL auth/connection failure on ANY provider op —
   * poll, card write, re-tier, escalation resolve; every op funnels through the
   * provider's call() choke point — can tear the WHOLE connection down to Local, not just
   * the per-op revert. Wired into the provider as `onFatal` (see activate). setLocal
   * emits, so the subscribe→setSpineModel(null) cascade fires and the board UI snaps to
   * disconnected. Idempotent: once we've fallen back (state.provider !== 'mcp'), a burst
   * of in-flight failing ops is ignored (no thrash). ONLY the provider's fatal classes
   * ('auth' → 401, 'unreachable' → network/CORS) reach here; validation_failed/conflict
   * are op-level (isError results) and stay with the caller's loud-revert.
   *
   * CONTEXTUAL DEGRADE (FIX C): the DECISION is graded by class and source. 'auth' is
   * deterministic (a rejected token never heals) → degrade on the first fatal, any source.
   * 'unreachable' from a USER-INITIATED op → degrade instantly (loud-revert unchanged).
   * 'unreachable' from the BACKGROUND POLL → tolerate the first STRIKE_LIMIT-1 consecutive
   * failures and degrade on the STRIKE_LIMIT-th; a clean poll resets the count (pollOnce).
   */
  function degradeOnFatal(err) {
    if (disposed || state.provider !== 'mcp') return;
    const kind = (err && err.fatalKind) || (err && err.code) || 'unreachable';
    if (kind === 'auth') {
      unreachableStrikes = 0;
      setLocal(true, { code: 'auth', message: (err && err.message) || 'authentication failed' });
      return;
    }
    // 'unreachable' from the poll path (pollInFlight): count a strike, ride it out until
    // the limit. The board stays live (possibly stale) meanwhile; scheduleNext keeps polling
    // (state is still 'mcp'), so a recovery heals it before we ever degrade.
    if (pollInFlight) {
      unreachableStrikes += 1;
      if (unreachableStrikes < POLL_UNREACHABLE_STRIKE_LIMIT) return;
      unreachableStrikes = 0;
      setLocal(true, { code: 'unreachable', message: (err && err.message) || 'connection lost' });
      return;
    }
    // 'unreachable' from a user-initiated op: instant degrade.
    unreachableStrikes = 0;
    setLocal(true, { code: 'unreachable', message: (err && err.message) || 'connection lost' });
  }

  /* ---- polling (only while MCP is active; realtime:false ⇒ poll) ---- */
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
    if (disposed || state.provider !== 'mcp' || !provider) return;
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
      if (disposed || state.provider !== 'mcp') return;
      unreachableStrikes = 0; // a clean poll cycle heals the background-strike counter (FIX C)
      applyModel(buildModel(board, cards, incArch));
    } finally {
      pollInFlight = false;
    }
  }
  function scheduleNext() {
    if (disposed || state.provider !== 'mcp') return;
    pollHandle = schedule(async () => {
      pollHandle = null;
      if (disposed) return; // a timer that fired after teardown does nothing (FIX A)
      try {
        await pollOnce();
      } catch (e) {
        // The poll threw. Three cases: (1) a fatal that DEGRADED — 'auth', or the
        // STRIKE_LIMIT-th consecutive 'unreachable' — already ran onFatal → degradeOnFatal →
        // setLocal, so state.provider is now 'local' and the guard below stops the loop
        // cleanly; (2) a TOLERATED unreachable strike (below the limit) left state 'mcp' —
        // keep polling so a recovery heals it; (3) a non-fatal poll error must NOT silently
        // kill the loop. (2) and (3) re-arm below; teardown is caught by the disposed guard.
        if (disposed || state.provider !== 'mcp') return;
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
    if (!wantsMcp) { setLocal(false, null); return getState(); }
    let p;
    try {
      // Pass the mid-session degrade sink to the provider: a fatal auth/connection
      // failure on any subsequent op routes back here to setLocal(true).
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
      provider = p;
      // A server advertising the read pair but not all four card_* write tools is
      // a valid read-only backend (caps.canWrite === false). Signal it in the
      // indicator so the board chip reads "MCP: <name> (read-only)"; the board
      // reads caps.canWrite (threaded via state.capabilities) to gate writes.
      // caps.canResolve rides through the SAME state.capabilities channel (the whole
      // caps object is threaded below): it gates the one escalation approve/deny
      // control INDEPENDENTLY of read-only mode, so a read-only mirror can still
      // surface that single human-gated mutation.
      const indicator = caps.canWrite
        ? mcpIndicator(res.server.name)
        : `${mcpIndicator(res.server.name)} (read-only)`;
      state = {
        provider: 'mcp',
        indicator,
        fallback: false,
        server: res.server,
        capabilities: caps,
        featureFlags: {
          escalations: !!caps.escalations,
          artifacts: !!caps.artifacts,
          columns: !!caps.columns,
          tags: !!caps.tags,
          realtime: !!caps.realtime,
        },
        error: null,
      };
      emit();
      await startPolling();
      return getState();
    } catch (e) {
      console.warn('MCP connect failed; degrading to Local:', (e && e.message) || e, e);
      // unreachable / incompatible / timeout → graceful degrade, never blank.
      setLocal(true, { code: e.code || 'unreachable', message: e.message });
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
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
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
export function createMcpConnectionFromConfig({ config, applyModel, fetchFn, schedule, cancel, pollIntervalMs, includeArchived } = {}) {
  // The controller passes its degrade sink as `hooks.onFatal` when it builds the
  // provider (see activate); thread it through so a mid-session fatal error on any op
  // routes back to setLocal(true).
  const makeProvider = (hooks = {}) => createMCPProvider({
    baseUrl: config.mcp.url,
    authToken: config.mcp && config.mcp.auth_token,
    fetchFn,
    onFatal: hooks.onFatal,
  });
  return createMcpConnection({ config, makeProvider, applyModel, schedule, cancel, pollIntervalMs, includeArchived });
}
