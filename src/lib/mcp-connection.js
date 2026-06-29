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
 */
export function createMcpConnection({
  config = {},
  makeProvider,
  applyModel = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  pollIntervalMs,
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
} = {}) {
  const interval = pollIntervalMs || config.poll_interval_ms || DEFAULT_POLL_MS;
  const mcpUrl = config.mcp && config.mcp.url;
  const wantsMcp = !!mcpUrl && config.data_source !== 'local';

  let state = localState(false, null);
  let provider = null; // active MCPProvider while state.provider === 'mcp'
  let pollHandle = null;
  const listeners = new Set();

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
  const emit = () => { for (const fn of listeners) fn(getState()); };

  function setLocal(fallback, error) {
    stopPolling();
    provider = null;
    state = localState(fallback, error);
    emit();
  }

  /* ---- polling (only while MCP is active; realtime:false ⇒ poll) ---- */
  function buildModel(board, cards) {
    return {
      columns: toBoardColumns(board && board.columns),
      cards: (cards || []).filter((c) => c && c.column_id != null),
      flags: state.featureFlags,
    };
  }
  async function pollOnce() {
    if (state.provider !== 'mcp' || !provider) return;
    // Full snapshot each tick (sync_token incremental sync is a later
    // optimization): board_get for columns, card_list for the live cards. The
    // server's `column_id` is authoritative — never recomputed here.
    const { board } = await provider.getBoard();
    const { cards } = await provider.list({ includeDeleted: false });
    applyModel(buildModel(board, cards));
  }
  function scheduleNext() {
    if (state.provider !== 'mcp') return;
    pollHandle = schedule(async () => {
      pollHandle = null;
      await pollOnce();
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
      p = makeProvider();
      // connect() runs the MCP initialize handshake + tools/list and rejects a
      // server missing any REQUIRED_TOOLS (incompatible_server) before we go live.
      const res = await withTimeout(p.connect(), pingTimeoutMs, schedule, cancel);
      const caps = res.capabilities;
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
      if (provider && typeof provider.disconnect === 'function') provider.disconnect();
      setLocal(false, null);
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
 * Production entry: build the controller from kanbantt_config with a real MCP
 * provider (Streamable HTTP + Bearer auth from config). The board's boot wiring
 * passes its refresh path as `applyModel` — no board component changes.
 */
export function createMcpConnectionFromConfig({ config, applyModel, fetchFn, schedule, cancel, pollIntervalMs } = {}) {
  const makeProvider = () => createMCPProvider({
    baseUrl: config.mcp.url,
    authToken: config.mcp && config.mcp.auth_token,
    fetchFn,
  });
  return createMcpConnection({ config, makeProvider, applyModel, schedule, cancel, pollIntervalMs });
}
