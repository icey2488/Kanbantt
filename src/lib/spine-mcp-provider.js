/**
 * MCPProvider — Kanbantt's data provider backed by an MCP-compatible server
 * (the Claunker spine). Implements the Foundation 02 KanbanttProvider interface as
 * HTTP calls over the /mcp wire contract; it is a SECOND provider behind the same
 * interface as the LocalProvider, so the board never knows which backs it.
 *
 * This is a pure TRANSPORT seam — each interface method → its /mcp endpoint → a
 * spine-server method. It holds NO domain logic and, critically, NEVER recomputes
 * a Task's column: the server's read already carries the effective column
 * (renderColumn through MI-3). One source of truth — the server's effective state.
 *
 * Transport is injected: `transport(req) -> Promise<{status, body}>` where
 * req = { method, path, query?, headers?, body? }. Production uses
 * makeHttpTransport (real fetch + Bearer auth); tests use makeInProcessTransport
 * to drive the REAL spine server in-process.
 *
 * DIVERGENCES from Foundation 02 (flagged, not silent):
 *  - The version token rides the `If-Match` header on PATCH/DELETE (idiomatic HTTP
 *    optimistic concurrency); the v0.1.0 wire spec didn't specify a token transport.
 *  - updateProject → the spine reports Project inert at v1 (405); surfaced as an
 *    unsupported_operation error, not silently swallowed.
 *  - resolveEscalation also carries a `nextState` (the spine needs the lifecycle
 *    state to return the Task to); the wire signature is resolveEscalation(id,
 *    resolution).
 *  - subscribe is unsupported because the spine reports realtime:false — the board
 *    polls. No WebSocket is faked.
 */

/** Provider-level error. `code` mirrors the board's contract: a stale write throws
 *  code 'conflict' carrying the current entity under `meta.current` (parity with
 *  card-store's StoreError('conflict', …, { current })). */
export class MCPProviderError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'MCPProviderError';
    this.code = code;
    this.meta = meta;
  }
}

/** Bridge an in-process spine wire handler (spine-http.js) to a provider transport. */
export function makeInProcessTransport(handler) {
  return async (req) => {
    const res = await handler.handle(req);
    return { status: res.status, body: res.body };
  };
}

/** Production transport: real fetch over a base URL, with optional Bearer auth. */
export function makeHttpTransport({ baseUrl, fetchFn = (...a) => fetch(...a), authToken } = {}) {
  return async ({ method, path, query, headers, body }) => {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const h = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(headers || {}),
    };
    const r = await fetchFn(url.toString(), {
      method,
      headers: h,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let parsed = null;
    try { parsed = await r.json(); } catch { /* empty/204 body */ }
    return { status: r.status, body: parsed };
  };
}

export function createMCPProvider({ transport, name = 'MCP' } = {}) {
  if (typeof transport !== 'function') throw new MCPProviderError('config', 'createMCPProvider requires a transport(req) fn');

  let capabilities = null;
  let server = null;
  let connected = false;

  /* ---- the request seam: maps HTTP failures to the provider error surface ---- */
  async function req(method, path, { query, headers, body } = {}) {
    const res = await transport({ method, path, query, headers, body });
    if (res.status >= 400) {
      const err = (res.body && res.body.error) || {};
      if (res.status === 409 && err.code === 'version_conflict') {
        // board-parity conflict: code 'conflict', current entity under meta.current
        throw new MCPProviderError('conflict', err.message || 'version conflict', {
          current: err.current,
          serverCode: err.code,
        });
      }
      if (res.status === 404) throw new MCPProviderError('not_found', err.message || `not found: ${path}`, { serverCode: err.code });
      if (res.status === 405) throw new MCPProviderError('unsupported_operation', err.message || `unsupported: ${method} ${path}`, { serverCode: err.code });
      throw new MCPProviderError(err.code || 'request_failed', err.message || `HTTP ${res.status}`, { status: res.status, serverCode: err.code, detail: err.detail });
    }
    return res.body;
  }

  function requireConnected() {
    if (!connected) throw new MCPProviderError('not_connected', 'call connect() first');
  }
  function requireCapability(cap) {
    requireConnected();
    if (!capabilities || !capabilities[cap]) {
      throw new MCPProviderError('unsupported_capability', `server does not advertise capability '${cap}'`, { capability: cap });
    }
  }

  return {
    /* ---- connection ---- */
    async connect() {
      const map = await req('GET', '/mcp/capabilities');
      const caps = map && map.capabilities;
      const srv = map && map.server;
      if (!srv || !(srv.schema_version >= 1)) {
        throw new MCPProviderError('incompatible_server', 'capabilities response missing a valid server/schema_version');
      }
      // projects AND tasks are REQUIRED — a server missing either cannot back Kanbantt.
      if (!caps || caps.projects !== true || caps.tasks !== true) {
        throw new MCPProviderError('incompatible_server', 'server must advertise both projects and tasks capabilities', { capabilities: caps });
      }
      capabilities = caps;
      server = srv;
      connected = true;
      return { ok: true, server: srv, capabilities: caps };
    },
    async disconnect() {
      connected = false;
      capabilities = null;
      server = null;
      return { ok: true };
    },
    getCapabilities() {
      requireConnected();
      return { server, capabilities };
    },
    /** Whether live subscription is available. The spine reports realtime:false →
     *  false → the board must poll. */
    supportsRealtime() {
      return !!(capabilities && capabilities.realtime);
    },

    /* ---- projects ---- */
    async getProjects() {
      requireConnected();
      return req('GET', '/mcp/projects');
    },
    async getProject(id) {
      requireConnected();
      return req('GET', `/mcp/projects/${encodeURIComponent(id)}`);
    },
    async createProject(input) {
      requireConnected();
      return req('POST', '/mcp/projects', { body: input });
    },
    async updateProject(id, patch) {
      requireConnected();
      // DIVERGENCE: spine Project is inert at v1 → server replies 405 → surfaced.
      return req('PATCH', `/mcp/projects/${encodeURIComponent(id)}`, { body: patch });
    },

    /* ---- tasks (column passes through from the server; NEVER recomputed here) ---- */
    async getTasks(projectId, filters = {}) {
      requireConnected();
      return req('GET', '/mcp/tasks', { query: { project_id: projectId, status: filters.status, agent: filters.agent } });
    },
    async getTask(id) {
      requireConnected();
      return req('GET', `/mcp/tasks/${encodeURIComponent(id)}`);
    },
    async createTask(input) {
      requireConnected();
      return req('POST', '/mcp/tasks', { body: input });
    },
    async updateTask(id, patch, expectedVersion) {
      requireConnected();
      const headers = expectedVersion != null ? { 'If-Match': expectedVersion } : undefined;
      return req('PATCH', `/mcp/tasks/${encodeURIComponent(id)}`, { headers, body: patch });
    },
    async cancelTask(id, expectedVersion) {
      requireConnected();
      const headers = expectedVersion != null ? { 'If-Match': expectedVersion } : undefined;
      await req('DELETE', `/mcp/tasks/${encodeURIComponent(id)}`, { headers });
    },

    /* ---- artifacts ---- */
    async getArtifacts(taskId) {
      requireConnected();
      return req('GET', '/mcp/artifacts', { query: { task_id: taskId } });
    },

    /* ---- escalations (optional capability — gated per spec) ---- */
    async getEscalations(filters = {}) {
      requireCapability('escalations');
      return req('GET', '/mcp/escalations', { query: { status: filters.status } });
    },
    async resolveEscalation(id, resolution, { nextState, expectedVersion } = {}) {
      requireCapability('escalations');
      const headers = expectedVersion != null ? { 'If-Match': expectedVersion } : undefined;
      return req('PATCH', `/mcp/escalations/${encodeURIComponent(id)}`, { headers, body: { resolution, next_state: nextState } });
    },

    /* ---- real-time ---- */
    subscribe() {
      // The spine reports realtime:false. Report unsupported so the board polls;
      // do NOT fake a WebSocket.
      throw new MCPProviderError('unsupported_capability', 'server does not support realtime subscription; board must poll', { capability: 'realtime' });
    },
  };
}
