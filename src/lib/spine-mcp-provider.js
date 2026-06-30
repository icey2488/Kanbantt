/**
 * MCPProvider — Kanbantt's data provider backed by a real MCP server (the
 * Claunker spine, or any server conforming to kanbantt-mcp-spec.md v0.3.0).
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

/** Required tool set — the READ surface a server MUST advertise to back Kanbantt
 *  at all (spec §Discovery → Required Tools). A server missing either is genuinely
 *  unusable (no board to render) and fails connect() as incompatible. The card_*
 *  WRITE tools are NOT required: a server advertising only the read pair is a valid,
 *  first-class read-only backend — the board renders a read-only mirror and write
 *  affordances are feature-gated on `capabilities.canWrite` (see WRITE_TOOLS). */
const REQUIRED_TOOLS = ['board_get', 'card_list'];

/** The four card-mutation tools. All four advertised ⇒ capabilities.canWrite is
 *  true; any absent ⇒ the board is read-only against this server (writes gated off,
 *  spec §Discovery: gate features on advertised tool NAMES, never assume). */
const WRITE_TOOLS = ['card_create', 'card_update', 'card_move', 'card_delete'];

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
    // spec meta.card → board-parity meta.current. Normalize tier to internal
    // (hyphen) form like every other Card crossing this boundary — the board's
    // conflict snap-back reconciles directly to this card, so it must not carry a
    // colon tier back into the internal model.
    return new MCPProviderError('conflict', message, { ...out, current: toInternalCard(meta.card) });
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

/* ------------------------------------------------------------------------ */
/* Tier wire ⇄ internal mapping (Pass 2b refinement)                        */
/* ------------------------------------------------------------------------ */
/**
 * Kanbantt's native/internal tier tag format is the HYPHEN form "tier-N"; the
 * spec wire contract + the spine require the COLON form "tier:N". This provider
 * is the SINGLE boundary that translates: the wire stays single-valued ("tier:N"
 * only), the board's internal logic stays uniformly hyphen. WRITE maps internal →
 * wire just before the MCP call (the fix for the failing edit, which sent
 * "tier-3" and was rejected validation_failed); READ DERIVES the internal tier
 * from the card's `tags` — the spine has NO native `card.tier`, tier lives ONLY
 * as a "tier:N" tag (projection.py) — setting `card.tier` to "tier-N", or null
 * when untiered, so the modal/tierLock and everything downstream see a real tier.
 *
 * Both directions are conservative and idempotent: WRITE rewrites only a string
 * matching the source form (null/undefined and unrecognized strings pass through
 * untouched); READ scans `tags` for the first "tier:N" and never mutates `tags`
 * itself (the badge renders off the colon tag) — so a re-projected card is
 * unchanged and we never invent, duplicate, or drop a tier.
 */
const TIER_INTERNAL_RE = /^tier-([1-9][0-9]*)$/; // "tier-3"
const TIER_WIRE_RE = /^tier:([1-9][0-9]*)$/;     // "tier:3"

/** internal "tier-N" → wire "tier:N" (write side). */
function tierInternalToWire(tier) {
  if (typeof tier !== 'string') return tier;
  const m = TIER_INTERNAL_RE.exec(tier);
  return m ? `tier:${m[1]}` : tier;
}
/** wire "tier:N" → internal "tier-N" (read side). */
function tierWireToInternal(tier) {
  if (typeof tier !== 'string') return tier;
  const m = TIER_WIRE_RE.exec(tier);
  return m ? `tier-${m[1]}` : tier;
}

/** Scan a wire card's `tags` for the tier and return its internal hyphen form
 *  "tier-N", or null when untiered. The spine carries tier ONLY as a "tier:N"
 *  tag (there is no native `card.tier`), so this is THE read seam: the first tier
 *  tag wins (single-valued by contract); `tierWireToInternal` does the per-tag
 *  colon→hyphen rewrite. */
function tierFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const internal = tierWireToInternal(t);
    if (internal !== t) return internal; // a "tier:N" tag was rewritten to "tier-N"
  }
  return null;
}

/** Project a Card coming off the wire into the internal model: set its `tier`
 *  field (hyphen "tier-N", or null when untiered) DERIVED from `tags`. `tags`
 *  itself is left untouched — the board's tier badge renders off the colon tag,
 *  and we never duplicate or strip it. Returns the SAME object only when `tier`
 *  already equals the derived value (idempotent: a re-projected card is
 *  unchanged; a fresh wire card with no `tier` field is cloned once to carry the
 *  derived value, including the explicit null that drives tierLock). */
function toInternalCard(card) {
  if (!card || typeof card !== 'object') return card;
  const tier = tierFromTags(card.tags);
  return card.tier === tier ? card : { ...card, tier };
}

/** Project a write patch/input into wire form: its `tier` field in colon form.
 *  A null `tier` is OMITTED entirely (not forwarded as null): the spine treats
 *  tier=None as "leave unchanged" and _patch_tier_to_int(None) → validation_failed,
 *  so a null must never reach the wire. Returns the SAME object when there's no
 *  `tier` key to translate. */
function toWirePatch(patch) {
  if (!patch || typeof patch !== 'object' || !('tier' in patch)) return patch;
  if (patch.tier === null) {
    const rest = { ...patch };
    delete rest.tier; // null = "no tier change"; drop the key rather than send null
    return rest;
  }
  return { ...patch, tier: tierInternalToWire(patch.tier) };
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
  let capabilities = null;  // { projects, tasks, canWrite, canResolve, escalations, artifacts, columns, tags, realtime }
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
        // check parity with the old indicator contract; board_get + card_list
        // are the real required surface, enforced by REQUIRED_TOOLS above.
        projects: true,
        tasks: true,
        // Per-tool write capability + the derived gate the board reads. canWrite
        // is true ONLY when all four card_* mutation tools are advertised; any
        // missing ⇒ read-only mirror (write affordances feature-gated off).
        hasCardCreate: toolNames.has('card_create'),
        hasCardUpdate: toolNames.has('card_update'),
        hasCardMove: toolNames.has('card_move'),
        hasCardDelete: toolNames.has('card_delete'),
        canWrite: WRITE_TOOLS.every((t) => toolNames.has(t)),
        // canRetier gates the GOVERNED tier-change control (card_retier) — the audited
        // path that re-tiers a SET tier and writes a tier_audit row. It derives from
        // card_retier ALONE, INDEPENDENT of canWrite: a server may advertise the audited
        // re-tier without the full card_* write set (exactly as canResolve is independent
        // of canWrite/escalations). Gate the re-tier affordance on this — never on canWrite.
        canRetier: toolNames.has('card_retier'),
        escalations: toolNames.has('escalation_list') && toolNames.has('escalation_resolve'),
        // canResolve gates the SINGLE mutating control (escalation approve/deny)
        // independently of `escalations` (which also needs escalation_list — this slice
        // deliberately advertises escalation_resolve WITHOUT it) and of canWrite (the
        // card_* board writes). The Claunker spine advertises escalation_resolve alone,
        // so canResolve is true while escalations stays false; that asymmetry is the whole
        // reason for a distinct flag. Gate the resolve affordance on this — never on
        // canWrite or escalations.
        canResolve: toolNames.has('escalation_resolve'),
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
      }).then((out) => ({ cards: (out.cards || []).map(toInternalCard), sync_token: out.sync_token }));
    },

    async get(id) {
      requireConnected();
      try {
        const out = await call('card_get', { id });
        return out.card ? toInternalCard(out.card) : null;
      } catch (e) {
        if (e instanceof MCPProviderError && e.code === 'not_found') return null; // LocalProvider parity
        throw e;
      }
    },

    /** card_create — the returned card is canonical; the caller adopts it
     *  wholesale (including server-minted version), replacing local state. */
    async create(input = {}) {
      requireConnected();
      const out = await call('card_create', { card: toWirePatch(input) });
      return toInternalCard(out.card);
    },

    async update(id, patch = {}, { expected_version, force } = {}) {
      requireConnected();
      const out = await call('card_update', {
        id,
        patch: toWirePatch(patch),
        expected_version,
        ...(force ? { force: true } : {}),
      });
      return toInternalCard(out.card);
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
      return toInternalCard(out.card);
    },

    /** card_delete — soft delete, returns the tombstone. No `force` by spec. */
    async delete(id, { expected_version } = {}) {
      requireConnected();
      const out = await call('card_delete', { id, expected_version });
      return toInternalCard(out.card); // the tombstone
    },

    /* ---- card write-through (Pass 2b) — board-facing mutations on EXISTING cards.
     *  These are the board's vocabulary for the live-spine write path; they mirror
     *  escalationResolve's STRUCTURE exactly — capability-gate → single call() →
     *  return the projected entity — with domain errors surfacing through
     *  call()/mapDomainError identically (a stale write → code 'conflict' carrying
     *  the current card under meta.current; a tombstoned target → conflict too).
     *  Gated on `canWrite` (all four card_* tools advertised), the SAME way
     *  escalationResolve gates on `canResolve` — independent of the read pair.
     *
     *  expected_version: per spec §Concurrency it is REQUIRED on all three (the
     *  store rejects any other value with a conflict), so the caller supplies the
     *  card's captured prior version — it rides in the options object alongside the
     *  patch fields rather than being threaded separately. The board captures it as
     *  part of the optimistic prior-state snapshot (see App's write handlers).
     *
     *  card_create is DEFERRED (it needs project-targeting plumbing that does not
     *  exist yet) — intentionally NOT added here; the next slice wires it. */
    async cardUpdate(id, { title, acceptance_criteria, tier, expected_version } = {}) {
      requireCapability('canWrite');
      // Field-scoped patch: only the keys actually supplied, so an unset field is
      // never clobbered with `undefined`. column_id/order are NOT update fields — a
      // reposition is cardMove (update never repositions, mirroring card-store).
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (acceptance_criteria !== undefined) patch.acceptance_criteria = acceptance_criteria;
      // Tier crosses the wire in COLON form; the board edits it in internal HYPHEN
      // form. Map internal → wire HERE so the spine's strict validator accepts it —
      // the failing edit sent patch.tier="tier-3" and was rejected validation_failed.
      // A null tier is OMITTED (not forwarded): tier=None means "leave unchanged" on
      // the spine and _patch_tier_to_int(None) → validation_failed. With read-from-tags
      // restoring write-once tierLock, untier is unreachable by design anyway — this is
      // belt-and-suspenders, and keeps the patch consistent with toWirePatch.
      if (tier !== undefined && tier !== null) patch.tier = tierInternalToWire(tier);
      return toInternalCard((await call('card_update', { id, patch, expected_version })).card);
    },
    async cardMove(id, toState, { order, expected_version } = {}) {
      requireCapability('canWrite');
      return toInternalCard((await call('card_move', { id, column_id: toState, order, expected_version })).card);
    },
    /** card_delete returns the spec tombstone Card; the board only needs the id to
     *  confirm removal (the Pass 2b id-for-delete contract), so surface that. */
    async cardDelete(id, { expected_version } = {}) {
      requireCapability('canWrite');
      const out = await call('card_delete', { id, expected_version });
      return (out.card && out.card.id) || id;
    },

    /** card_retier — the GOVERNED, audited tier change (spec v0.3.0 §Re-tier). Changes
     *  an ALREADY-SET tier to a different valid tier (1..4); the server records an
     *  append-only tier_audit row and enforces every invariant (currently-tiered,
     *  in-range, differs-from-current, non-empty reason) — each surfaces as code
     *  'validation_failed'. Gated on `canRetier` (card_retier advertised), INDEPENDENT of
     *  canWrite. There is NO force: a re-tier re-decides against fresh state, so a stale
     *  expected_version is code 'conflict' carrying meta.current — the SAME boundary as
     *  the other writes. `new_tier` crosses the wire in COLON form, mapped from the
     *  board's internal HYPHEN form HERE (the single tier-translation seam); the returned
     *  Card is re-projected to internal (tier DERIVED from its tags). */
    async cardRetier(id, new_tier, expected_version, reason) {
      requireCapability('canRetier');
      const out = await call('card_retier', { id, new_tier: tierInternalToWire(new_tier), expected_version, reason });
      return toInternalCard(out.card);
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
    /** escalation_resolve — the ONE mutating control. Sends BOTH the decision and
     *  its rationale; the server enforces the >=10-char rationale floor and the
     *  operator-only actor invariant. The actor is NEVER sent — the server derives it
     *  from the authenticated credential. Gated on `canResolve` (escalation_resolve
     *  advertised), INDEPENDENT of `escalations`/`canWrite`. */
    async escalationResolve(id, { resolution, resolution_rationale } = {}) {
      requireCapability('canResolve');
      return (await call('escalation_resolve', { id, resolution, resolution_rationale })).escalation;
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
