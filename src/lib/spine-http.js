/**
 * Spine server WIRE FACE — the /mcp REST router over spine-server.js's methods.
 *
 * This is the server-side half of the Foundation 02 wire contract: it maps each
 * `METHOD /mcp/...` request onto the proven spine-server method and serializes the
 * result (and the SpineError taxonomy) into HTTP status + body. It adds NO domain
 * logic — every write still routes through the entity layer (via the server) and
 * every read through the projections (the server returns the effective column).
 *
 * It exists so the MCPProvider (the Kanbantt client) can be driven against the
 * REAL spine server over the wire contract in-process — the two real Phase-3 seams
 * meeting without a network or a mock.
 *
 * NOTE — the spine's `ingestTaskState` (Hermes→spine) is deliberately NOT routed
 * here: it is a spine EXTENSION with no Foundation 02 board endpoint. Hermes feeds
 * orchestration state through the server method directly; the Kanbantt wire face
 * exposes only board operations.
 */

import { SpineError } from './spine-entities.js';

/** SpineError.code → HTTP status. Conflict-class (state/version) → 409;
 *  validation-class → 422; missing record → 404; inert op → 405. */
const STATUS_FOR = {
  not_found: 404,
  unsupported_update: 405,
  // conflict class (optimistic-concurrency / write-once / terminal-state)
  version_conflict: 409,
  tier_write_once: 409,
  already_resolved: 409,
  zombie_append: 409,
  closed_task: 409,
  // validation class
  missing_field: 422,
  invalid_state: 422,
  invalid_kind: 422,
  invalid_control_diff: 422,
  non_durable_ref: 422,
  invalid_tier: 422,
  invalid_resolution_state: 422,
  unknown_hermes_state: 422,
};

const ok = (data, status = 200) => ({ status, body: data });

/** Extract the `:id` tail of a route prefix, or null if `path` isn't under it. */
const idUnder = (path, prefix) => (path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : null);

export function createSpineHttpHandler(server) {
  function fail(e) {
    if (e instanceof SpineError) {
      const status = STATUS_FOR[e.code] || 400;
      const body = { error: { code: e.code, message: e.message, detail: e.detail } };
      // Enrich a version conflict with the CURRENT row so the client can surface
      // it the way card-store's conflict does (meta.current) — board parity.
      if (e.code === 'version_conflict' && e.detail && e.detail.id != null) {
        try { body.error.current = server.getTask(e.detail.id); } catch { /* gone — leave absent */ }
      }
      return { status, body };
    }
    return { status: 500, body: { error: { code: 'server_error', message: String((e && e.message) || e) } } };
  }

  async function handle(req) {
    const method = req.method;
    const path = req.path;
    const query = req.query || {};
    const headers = req.headers || {};
    const body = req.body;
    const ifMatch = headers['If-Match'] != null ? headers['If-Match'] : headers['if-match'];

    try {
      // ---- capabilities ----
      if (method === 'GET' && path === '/mcp/capabilities') return ok(server.getCapabilities());

      // ---- projects ----
      if (path === '/mcp/projects') {
        if (method === 'GET') return ok(server.getProjects());
        if (method === 'POST') return ok(server.createProject(body), 201);
      }
      let id;
      if ((id = idUnder(path, '/mcp/projects/')) != null) {
        if (method === 'GET') return ok(server.getProject(id));
        if (method === 'PATCH') return ok(server.updateProject(id, body)); // throws unsupported_update → 405
      }

      // ---- tasks ----
      if (path === '/mcp/tasks') {
        if (method === 'GET') return ok(server.getTasks(query.project_id, { status: query.status, agent: query.agent }));
        if (method === 'POST') return ok(server.createTask(body), 201);
      }
      if ((id = idUnder(path, '/mcp/tasks/')) != null) {
        if (method === 'GET') return ok(server.getTask(id));
        if (method === 'PATCH') return ok(server.updateTask(id, body || {}, { expectedVersion: ifMatch }));
        if (method === 'DELETE') {
          server.cancelTask(id, { expectedVersion: ifMatch });
          return { status: 204, body: null };
        }
      }

      // ---- artifacts ----
      if (method === 'GET' && path === '/mcp/artifacts') return ok(server.getArtifacts(query.task_id));

      // ---- escalations ----
      if (path === '/mcp/escalations' && method === 'GET') return ok(server.getEscalations({ status: query.status }));
      if ((id = idUnder(path, '/mcp/escalations/')) != null && method === 'PATCH') {
        return ok(server.resolveEscalation(id, {
          resolution: body && body.resolution,
          nextState: body && body.next_state,
          expectedVersion: ifMatch,
        }));
      }

      return { status: 404, body: { error: { code: 'no_route', message: `no route for ${method} ${path}` } } };
    } catch (e) {
      return fail(e);
    }
  }

  return { handle };
}
