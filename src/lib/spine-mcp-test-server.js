/**
 * In-process MCP server test harness — a conforming spine the real MCPProvider
 * can be driven against with ZERO live network. This is the instrument the
 * provider rewrite needs: it closes the gaps a pure-mock can't, by exercising
 * the actual @modelcontextprotocol/sdk round trip — `initialize` → `tools/list`
 * → `tools/call` — and letting a test assert which payload SHAPE the server
 * emits (structuredContent vs a JSON text block; the provider reads both, but
 * only a real server tells you which).
 *
 * Wiring: a real SDK `Server` (low-level: raw tools/list + tools/call handlers,
 * no per-tool Zod) speaks over `WebStandardStreamableHTTPServerTransport`, whose
 * handleRequest(Request) → Promise<Response> bridges directly onto the provider's
 * injectable `fetchFn`. No socket, no port — the client's StreamableHTTP transport
 * talks to the server entirely in memory.
 *
 * BACKEND: card-store.js — the LocalProvider's own store, so the harness server
 * behaves with exact LocalProvider parity (version conflicts carrying the current
 * card, fractional ordering, column/tag integrity). The spec's Provider Parity
 * contract made real: the same store backs both providers under test.
 *
 * It does NOT use spine-server.js (the old Task-model REST domain) — that module
 * is preserved untouched pending capture in the Claunker reference server.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStore } from './card-store.js';

/** The full conforming tool set (required + optional capability sets). A harness
 *  can omit any of these to simulate an incompatible / capability-limited server. */
const ALL_TOOLS = [
  'board_get', 'card_list', 'card_get', 'card_create', 'card_update', 'card_move', 'card_delete',
  'column_create', 'column_update', 'column_delete',
  'tag_create', 'tag_update', 'tag_delete',
  'escalation_list', 'escalation_resolve', 'artifact_list',
];

/** Minimal in-memory localStorage shim for createStore (Node has no localStorage). */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Local column { id, label, accentKey, rank } → spec Board column { id, name, color, order }. */
const toWireColumn = (c) => ({ id: c.id, name: c.label, color: c.accentKey, order: c.rank });

/**
 * @param {object}  [opts]
 * @param {(store)=>void} [opts.seed]   populate the backing store after load
 * @param {string}  [opts.name]         advertised server name (→ "MCP: <name>")
 * @param {string[]} [opts.omitTools]   tool names to hide from tools/list
 * @param {'structured'|'text'} [opts.payloadStyle]  how tool results carry their
 *        object: structuredContent (default) or a JSON text block only. The
 *        provider must read BOTH; this flips the server so a test can prove it.
 * @param {number} [opts.schemaVersion]  the board_get kanbantt_schema_version
 *        (set >1 to exercise the provider's schema_unsupported refusal).
 * @param {Object<string,{code,message,meta}>} [opts.errorOn]  force a tool to
 *        always return the given domain error (e.g. rate_limited with retry_after).
 * @returns {{ url, fetchFn, store, server, close }}
 */
export function createMcpTestServer({ seed, name = 'Claunker', omitTools = [], payloadStyle = 'structured', schemaVersion = 1, errorOn = {} } = {}) {
  const store = createStore({ storage: memStorage(), actor: { type: 'agent', id: 'spine' } });
  store.load();
  if (typeof seed === 'function') seed(store);

  const tools = ALL_TOOLS.filter((t) => !omitTools.includes(t));
  const has = (t) => tools.includes(t);

  /* ---- result builders (the payload-shape switch lives here) ---- */
  const wrap = (obj) => (payloadStyle === 'text'
    ? { content: [{ type: 'text', text: JSON.stringify(obj) }] }
    : { structuredContent: obj, content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const ok = (obj) => wrap(obj);
  const domainError = (code, message, meta = {}) => ({ isError: true, ...wrap({ code, message, meta }) });

  /** Map a card-store StoreError onto a spec domain-error payload (conflict carries
   *  the current card under meta.card — the provider remaps it to meta.current). */
  function fromStoreError(e) {
    if (e && e.code === 'conflict') return domainError('conflict', e.message, { card: e.meta && e.meta.current });
    if (e && e.code) return domainError(e.code, e.message, e.meta || {});
    return domainError('request_failed', (e && e.message) || 'error');
  }

  const board = () => {
    const snap = store.getSnapshot();
    return { board: { schema_version: 1, columns: snap.columns.map(toWireColumn), tags: snap.tags }, kanbantt_schema_version: schemaVersion };
  };

  /* ---- tool dispatch ---- */
  function dispatch(toolName, a = {}) {
    if (errorOn[toolName]) {
      const e = errorOn[toolName];
      return domainError(e.code || 'request_failed', e.message, e.meta || {});
    }
    try {
      switch (toolName) {
        case 'board_get': return ok(board());
        case 'card_list': {
          const out = store.list({ since: a.updated_since ?? null, includeDeleted: !!a.include_deleted });
          let cards = out.cards;
          if (a.column_id != null) cards = cards.filter((c) => c.column_id === a.column_id);
          if (a.tag != null) cards = cards.filter((c) => (c.tags || []).includes(a.tag));
          return ok({ cards, sync_token: out.sync_token });
        }
        case 'card_get': {
          const card = store.get(a.id);
          return card ? ok({ card }) : domainError('not_found', `no card ${a.id}`, { id: a.id });
        }
        case 'card_create': return ok({ card: store.create(a.card || {}) });
        case 'card_update': return ok({ card: store.update(a.id, a.patch || {}, { expected_version: a.expected_version, force: a.force }) });
        case 'card_move': return ok({ card: store.move(a.id, { column_id: a.column_id, order: a.order }, { expected_version: a.expected_version, force: a.force }) });
        case 'card_delete': return ok({ card: store.delete(a.id, { expected_version: a.expected_version }) });
        case 'column_create': store.columnCreate(a); return ok(board());
        case 'column_update': store.columnUpdate(a.id, a.patch || {}); return ok(board());
        case 'column_delete': store.columnDelete(a.id, a.orphan_destination_column_id); return ok(board());
        case 'tag_create': store.tagCreate(a); return ok(board());
        case 'tag_update': store.tagUpdate(a.id, a.patch || {}); return ok(board());
        case 'tag_delete': store.tagDelete(a.id); return ok(board());
        case 'escalation_list': return ok({ escalations: [] });
        case 'escalation_resolve': return ok({ escalation: { id: a.id, status: 'resolved', resolution: a.resolution, resolution_rationale: a.resolution_rationale } });
        case 'artifact_list': return ok({ artifacts: [] });
        default: return domainError('not_found', `no tool ${toolName}`);
      }
    } catch (e) {
      return fromStoreError(e);
    }
  }

  /* ---- the SDK server + in-memory transport ---- */
  const server = new Server({ name, version: '0.2.4' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((n) => ({ name: n, description: n, inputSchema: { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => dispatch(req.params.name, req.params.arguments || {}));

  // Stateful single-session transport: one instance handles the whole client
  // session (initialize mints the session id; the client echoes it back). JSON
  // responses (no SSE) keep the in-memory fetch bridge a plain request/response.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => globalThis.crypto.randomUUID(),
    enableJsonResponse: true,
  });
  const ready = server.connect(transport);

  const fetchFn = async (url, init) => {
    await ready; // ensure the server is wired before the first request lands
    return transport.handleRequest(new Request(url, init));
  };

  return {
    url: 'http://mcp.test/mcp',
    fetchFn,
    store,            // server-side handle: tests mutate it to simulate Hermes feeds
    server,           // the SDK Server (advertised name lives here)
    hasTool: has,
    async close() {
      try { await transport.close(); } catch { /* best effort */ }
      try { await server.close(); } catch { /* best effort */ }
    },
  };
}
