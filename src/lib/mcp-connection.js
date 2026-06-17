/**
 * MCP connection controller (Phase 3b) — auto-detect provider selection + the
 * polling loop that renders live spine state on the board. PURE and injectable,
 * the same shape as drive-sync.js: every ambient (provider factory, timers, the
 * board refresh path) is injected, so it runs in node against the REAL spine
 * server with zero live network.
 *
 * It is the SELECTION SEAM, not a board rewrite. Board components keep consuming
 * the active provider's data unchanged: the controller maps polled spine Tasks
 * into the board's card model and pushes them through the injected `applyModel`
 * (the existing provider-refresh path — same role drive-sync's `applyBlob` plays).
 *
 * Connection flow (Foundation 02, authoritative):
 *   - no MCP URL                       → LocalProvider, "Local" indicator
 *   - URL + reachable + valid caps     → MCPProvider, "MCP: <name>", capability flags
 *   - URL + unreachable/invalid/timeout→ LocalProvider, "Local (MCP unavailable)"
 *                                        + retry; never a blank board
 *
 * realtime:false (the spine) → NO WebSocket. The board POLLS getProjects/getTasks
 * at a configurable interval; the server's effective column rides through
 * untouched (the provider never recomputes it — 3a guarantee).
 */

import { createMCPProvider, makeHttpTransport } from './spine-mcp-provider.js';

export const LOCAL_INDICATOR = 'Local';
export const MCP_UNAVAILABLE_INDICATOR = 'Local (MCP unavailable)';
export const mcpIndicator = (name) => `MCP: ${name}`;

const DEFAULT_POLL_MS = 5000;
const DEFAULT_PING_TIMEOUT_MS = 3000;

/** The board columns the spine render projection targets (todo/in_progress/blocked
 *  /done). The poll maps each Task's server-computed `column` onto these. */
export const SPINE_BOARD_COLUMNS = [
  { id: 'todo', label: 'To Do', accentKey: 'textDim' },
  { id: 'in_progress', label: 'In Progress', accentKey: 'ice' },
  { id: 'blocked', label: 'Blocked', accentKey: 'coral' },
  { id: 'done', label: 'Done', accentKey: 'mint' },
];

/** LocalProvider feature flags — the optional MCP features don't apply; the board
 *  still works on the required projects/tasks. */
const LOCAL_FLAGS = Object.freeze({ escalations: false, artifacts: false, corpus: false, realtime: false });

/**
 * Map a spine/MCP Task (carrying the server's effective `column`) to the board's
 * card shape. column_id is the SERVER's column — never recomputed here (the board
 * aliases column_id→status at its boundary, so cards land in the right column).
 */
export function taskToCard(task) {
  return {
    id: task.id,
    title: task.title,
    column_id: task.column,
    priority: 'med', // orchestration carries `tier`, not board priority — neutral default
    tags: [],
    state: task.state,
    tier: task.tier,
    version: task.version,
    deleted_at: null,
  };
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
  function buildModel(tasks) {
    return {
      columns: SPINE_BOARD_COLUMNS,
      cards: tasks.filter((t) => t && t.column != null).map(taskToCard),
      flags: state.featureFlags,
    };
  }
  async function pollOnce() {
    if (state.provider !== 'mcp' || !provider) return;
    const projects = await provider.getProjects();
    let tasks = [];
    for (const p of projects) tasks = tasks.concat(await provider.getTasks(p.id));
    applyModel(buildModel(tasks));
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
      const res = await withTimeout(p.connect(), pingTimeoutMs, schedule, cancel);
      // connect() already rejected projects/tasks-missing servers (incompatible_server).
      const caps = res.capabilities;
      provider = p;
      state = {
        provider: 'mcp',
        indicator: mcpIndicator(res.server.name),
        fallback: false,
        server: res.server,
        capabilities: caps,
        featureFlags: {
          escalations: !!caps.escalations,
          artifacts: !!caps.artifacts,
          corpus: !!caps.corpus,
          realtime: !!caps.realtime,
        },
        error: null,
      };
      emit();
      await startPolling();
      return getState();
    } catch (e) {
      // unreachable / invalid schema / timeout → graceful degrade, never blank.
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
    /** The active MCP provider (board writes go through it; a stale-token write
     *  surfaces the SAME code:'conflict' shape as a local conflict — 3a parity). */
    getProvider: () => provider,
    supportsRealtime: () => !!(state.capabilities && state.capabilities.realtime),
    /** Manual sync affordance (board "refresh" button) — one poll cycle, no timer. */
    pollNow: pollOnce,
    isPolling: () => pollHandle != null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/**
 * Production entry: build the controller from kanbantt_config, with a real
 * fetch-based MCPProvider transport (Bearer auth from config). The board's boot
 * wiring calls this and passes its refresh path as `applyModel` — the one-line
 * victory-lap consumption; no board component changes.
 */
export function createMcpConnectionFromConfig({ config, applyModel, fetchFn, schedule, cancel, pollIntervalMs } = {}) {
  const makeProvider = () => createMCPProvider({
    transport: makeHttpTransport({
      baseUrl: config.mcp.url,
      authToken: config.mcp && config.mcp.auth_token,
      fetchFn,
    }),
  });
  return createMcpConnection({ config, makeProvider, applyModel, schedule, cancel, pollIntervalMs });
}
