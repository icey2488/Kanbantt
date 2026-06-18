/**
 * MCPProvider — Kanbantt's data provider backed by a real MCP server (the
 * Claunker spine, or any server conforming to kanbantt-mcp-spec.md v0.2.4).
 *
 * REWRITE NOTE (supersedes the v0.1.0 REST provider): the old implementation
 * spoke a bespoke REST contract — `GET /mcp/capabilities`, REST resources, a
 * `Task` entity, `If-Match` headers — which the spec retired. This version is
 * real MCP: JSON-RPC 2.0 over Streamable HTTP via @modelcontextprotocol/sdk,
 * `initialize` + `tools/list` for discovery, MCP tools for every operation, and
 * the Card entity end to end. There is NO `/mcp/capabilities` endpoint anymore.
 *
 * PARITY (the whole point): the method surface mirrors the LocalProvider
 * (card-store.js) exactly — list/get/create/update/move/delete, plus column and
 * tag ops — and conflicts throw the SAME shape (code 'conflict', current card under
 * `meta.current`). The board consumes this provider through the identical calls
 * it makes against the local store; per spec §Provider Parity it must never
 * branch on which backs it. `connect()`/`disconnect()` and the capability
 * accessors are the only additions (the local store is always "connected").
 *
 * TRANSPORT: real fetch by default; `fetchFn` is injectable so the provider can
 * be driven in Node against a conforming in-process MCP server with zero live
 * network (the test seam that replaces the old makeInProcessTransport).
 *
 * FLAGGED DIVERGENCES / BOUNDARY ADAPTATIONS (declared, not silent):
 *  - Spec domain-error payload uses `meta.card`; the board's conflict contract
 *    (card-store StoreError) uses `meta.current`. We remap at this boundary so
 *    the board sees one shape. `meta.retry_after` is preserved on every code.
 *  - LocalProvider's `list({ since, includeDeleted })` param names are kept at
 *    THIS interface; they map to the wire arg names `updated_since` /
 *    `include_deleted` inside card_list. Callers stay provider-agnostic.
 *  - `get(id)` returns null for a missing card (LocalProvider parity), by
 *    catching the spec's `not_found` domain error. Every other domain error
 *    propagates.
 *  - Column/tag tools return the spec's `{ board }`; we surface `board` (the
 *    local store returns the bare columns/tags array). The board-config wiring
 *    adapts at one site — see the controller rework. Flagged so it isn't a
 *    silent shape mismatch.
 *  - `delete` takes no `force` (spec: deletion always requires the current
 *    version). `force` is honored only on update/move, and never defaulted on.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/* global __APP_VERSION__ */

/** The data schema version this client understands (board_get reports the
 *  server's; a major mismatch is refused, mirroring card-store.validateBlob). */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Required tool set (spec §Tool Contract → Required Tools). A server missing
 *  any of these cannot back Kanbantt and fails connect() as incompatible. */
const REQUIRED_TOOLS = ['board_get', 'card_list', 'card_create', 'card_update', 'card_move', 'card_delete'];

/**
 * Provider-level error. `code` mirrors the board's contract: a stale write
 * throws code 'conflict' carrying the current card under `meta.current` (parity
 * with card-store's StoreError('conflict', …, { current })).
 */
export class MCPProviderError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'MCPProviderError';
    this.code = code;
    this.meta = meta;
  }
}

/* ------------------------------------------------------------------------ */
/* Result + error plumbing                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Pull the structured object out of a successful tool result. Spec: "All tool
 * results use `structuredContent` with a top-level object wrapper." We trust
 * structuredContent; as a defensive fallback (a server that only sent a JSON
 * text block) we parse the first text content item. A result with neither is a
 * server bug, surfaced — never a silent empty.
 */
function structured(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = Array.isArray(result?.content)
    ? result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
    : null;
  if (text) {
    try {
      const parsed = JSON.parse(text.text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to the structured-result bug below */ }
  }
  throw new MCPProviderError('protocol', 'tool result carried no structured object', { result });
}

/**
 * Map a spec domain-error payload ({ code, message, meta }) onto the provider
 * surface, preserving board parity. Conflict → meta.current; retry_after is
 * carried through on any code (spec: clients MUST honor it whenever present).
 * Unknown codes are surfaced as non-retryable, never swallowed.
 */
function mapDomainError(payload) {
  const code = (payload && payload.code) || 'request_failed';
  const message = (payload && payload.message) || code;
  const meta = (payload && payload.meta) || {};
  const out = { retry_after: meta.retry_after };
  if (code === 'conflict') {
    // spec meta.card → board-parity meta.current
    return new MCPProviderError('conflict', message, { ...out, current: meta.card });
  }
  return new MCPProviderError(code, message, { ...out, ...meta });
}

/** Read a domain-error payload out of an isError tool result. */
function errorPayload(result) {
  if (result && result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = Array.isArray(result?.content)
    ? result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
    : null;
  if (text) {
    try { return JSON.parse(text.text); } catch { return { code: 'request_failed', message: text.text }; }
  }
  return { code: 'request_failed', message: 'tool reported isError with no payload' };
}

export function createMCPProvider({
  baseUrl,
  authToken,
  fetchFn,
  name = 'MCP',
  clientName = 'kanbantt',
  clientVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
} = {}) {
  if (!baseUrl) throw new MCPProviderError('config', 'createMCPProvider requires a baseUrl');

  let client = null;
  let transport = null;
  let server = null;        // { name, version, schema_version }
  let capabilities = null;  // { projects, tasks, escalations, artifacts, columns, tags, realtime }
  let toolNames = new Set();
  let connected = false;

  function requireConnected() {
    if (!connected) throw new MCPProviderError('not_connected', 'call connect() first');
  }
  function requireCapability(cap) {
    requireConnected();
    if (!capabilities || !capabilities[cap]) {
      throw new MCPProviderError('unsupported_capability', `server does not advertise capability '${cap}'`, { capability: cap });
    }
  }

  /**
   * The single call seam. Splits the spec's two error layers:
   *  - JSON-RPC / transport failures are thrown by the SDK (connection,
   *    protocol, auth-transport, gateway) → re-surfaced as code 'transport'.
   *  - Domain errors arrive in-band as `isError: true` with a structured
   *    payload → mapped to the provider error surface.
   */
  async function call(toolName, args) {
    let result;
    try {
      result = await client.callTool({ name: toolName, arguments: args || {} });
    } catch (e) {
      throw new MCPProviderError('transport', e?.message || `MCP transport error calling ${toolName}`, { cause: e });
    }
    if (result && result.isError) throw mapDomainError(errorPayload(result));
    return structured(result);
  }

  return {
    /* ---- connection ---- */
    async connect() {
      // Bearer token on the HTTP transport (spec §Transport): Authorization
      // header rides requestInit. fetchFn is injectable for the Node test seam.
      transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
        ...(authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : {}),
        ...(fetchFn ? { fetch: fetchFn } : {}),
      });
      client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });

      // connect() performs the initialize handshake; transport-layer failures
      // (unreachable, CORS, protocol) throw here and the controller degrades to
      // Local (MCP unavailable) — never a blank board.
      try {
        await client.connect(transport);
      } catch (e) {
        throw new MCPProviderError('unreachable', e?.message || 'MCP connect failed', { cause: e });
      }

      const info = client.getServerVersion(); // serverInfo { name, version }
      let tools;
      try {
        ({ tools } = await client.listTools());
      } catch (e) {
        throw new MCPProviderError('transport', e?.message || 'tools/list failed', { cause: e });
      }
      toolNames = new Set((tools || []).map((t) => t.name));

      const missing = REQUIRED_TOOLS.filter((t) => !toolNames.has(t));
      if (missing.length) {
        await safeClose();
        throw new MCPProviderError('incompatible_server', `server missing required tool(s): ${missing.join(', ')}`, { missing });
      }

      // Feature gating keys off advertised tool NAMES (spec §Discovery). Column
      // and tag tools gate as a set; absent ⇒ those edits stay local.
      capabilities = {
        // projects/tasks retained as `true` for the board's required-features
        // check parity with the old indicator contract; cards+board are the
        // real required surface and are guaranteed by REQUIRED_TOOLS above.
        projects: true,
        tasks: true,
        escalations: toolNames.has('escalation_list') && toolNames.has('escalation_resolve'),
        artifacts: toolNames.has('artifact_list'),
        columns: toolNames.has('column_create') && toolNames.has('column_update') && toolNames.has('column_delete'),
        tags: toolNames.has('tag_create') && toolNames.has('tag_update') && toolNames.has('tag_delete'),
        realtime: false, // v1 is tools-only; the board polls (resources/subscribe is v2)
      };
      server = { name: (info && info.name) || name, version: info && info.version, schema_version: SUPPORTED_SCHEMA_VERSION };
      connected = true;
      return { ok: true, server, capabilities, tools: [...toolNames] };
    },

    async disconnect() {
      await safeClose();
      connected = false;
      capabilities = null;
      server = null;
      toolNames = new Set();
      return { ok: true };
    },

    getCapabilities() {
      requireConnected();
      return { server, capabilities };
    },
    supportsRealtime() {
      return !!(capabilities && capabilities.realtime);
    },
    /** Advertised tool names — lets the board gate optional UI (e.g. escalations
     *  column) exactly the way the spec intends. */
    hasTool(toolName) {
      return toolNames.has(toolName);
    },

    /* ---- board config read ---- */
    /**
     * board_get → { board, kanbantt_schema_version }. Validates the data schema
     * version (refuse a major-newer schema, mirroring card-store.validateBlob —
     * never partially adopt a board shape we don't understand).
     */
    async getBoard() {
      requireConnected();
      const out = await call('board_get');
      const sv = out.kanbantt_schema_version;
      if (sv != null && sv > SUPPORTED_SCHEMA_VERSION) {
        throw new MCPProviderError('schema_unsupported', `server board schema_version ${sv} newer than supported ${SUPPORTED_SCHEMA_VERSION}`, { found: sv, expected: SUPPORTED_SCHEMA_VERSION });
      }
      return out; // { board, kanbantt_schema_version }
    },

    /* ---- cards (column passes through from the server; NEVER recomputed) ---- */
    /**
     * list({ since, includeDeleted, columnId, tag }) → { cards, sync_token }.
     * Param names mirror LocalProvider.list; mapped to wire args here. A
     * `sync_token_expired` / `invalid_sync_token` domain error propagates with
     * its code so the controller can discard the token and full-fetch (spec).
     */
    async list({ since = null, includeDeleted = false, columnId, tag } = {}) {
      requireConnected();
      return call('card_list', {
        updated_since: since,
        include_deleted: includeDeleted,
        column_id: columnId,
        tag,
      }).then((out) => ({ cards: out.cards || [], sync_token: out.sync_token }));
    },

    async get(id) {
      requireConnected();
      try {
        const out = await call('card_get', { id });
        return out.card || null;
      } catch (e) {
        if (e instanceof MCPProviderError && e.code === 'not_found') return null; // LocalProvider parity
        throw e;
      }
    },

    /** card_create — the returned card is canonical; the caller adopts it
     *  wholesale (including server-minted version), replacing local state. */
    async create(input = {}) {
      requireConnected();
      const out = await call('card_create', { card: input });
      return out.card;
    },

    async update(id, patch = {}, { expected_version, force } = {}) {
      requireConnected();
      const out = await call('card_update', {
        id,
        patch,
        expected_version,
        ...(force ? { force: true } : {}),
      });
      return out.card;
    },

    async move(id, target = {}, { expected_version, force } = {}) {
      requireConnected();
      const out = await call('card_move', {
        id,
        column_id: target.column_id,
        order: target.order,
        expected_version,
        ...(force ? { force: true } : {}),
      });
      return out.card;
    },

    /** card_delete — soft delete, returns the tombstone. No `force` by spec. */
    async delete(id, { expected_version } = {}) {
      requireConnected();
      const out = await call('card_delete', { id, expected_version });
      return out.card; // the tombstone
    },

    /* ---- board config writes (optional capability sets) ---- */
    async columnCreate(column) {
      requireCapability('columns');
      return (await call('column_create', column)).board;
    },
    async columnUpdate(id, patch = {}) {
      requireCapability('columns');
      return (await call('column_update', { id, patch })).board;
    },
    async columnDelete(id, orphanDestinationColumnId) {
      requireCapability('columns');
      return (await call('column_delete', { id, orphan_destination_column_id: orphanDestinationColumnId })).board;
    },
    async tagCreate(tag) {
      requireCapability('tags');
      return (await call('tag_create', tag)).board;
    },
    async tagUpdate(id, patch = {}) {
      requireCapability('tags');
      return (await call('tag_update', { id, patch })).board;
    },
    async tagDelete(id) {
      requireCapability('tags');
      return (await call('tag_delete', { id })).board;
    },

    /* ---- escalations (optional capability — gated per spec) ---- */
    async escalationList({ status } = {}) {
      requireCapability('escalations');
      return (await call('escalation_list', { status })).escalations || [];
    },
    async escalationResolve(id, resolution) {
      requireCapability('escalations');
      return (await call('escalation_resolve', { id, resolution })).escalation;
    },

    /* ---- artifacts (optional capability) ---- */
    async artifactList(cardId) {
      requireCapability('artifacts');
      return (await call('artifact_list', { card_id: cardId })).artifacts || [];
    },

    /* ---- real-time ---- */
    subscribe() {
      // v1 advertises realtime:false. Report unsupported so the board polls; do
      // NOT fake a WebSocket. (resources/subscribe is the v2 realtime path.)
      throw new MCPProviderError('unsupported_capability', 'server does not support realtime subscription; board must poll', { capability: 'realtime' });
    },
  };

  async function safeClose() {
    try { if (transport && typeof transport.close === 'function') await transport.close(); } catch { /* best effort */ }
    try { if (client && typeof client.close === 'function') await client.close(); } catch { /* best effort */ }
  }
}
