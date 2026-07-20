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
/* Transport-error classification (mid-session degrade discrimination)      */
/* ------------------------------------------------------------------------ */
/**
 * Classify a RAW transport/SDK error (thrown by client.callTool / client.connect /
 * client.listTools) into the two FATAL classes that must tear the whole connection
 * down — or null for a non-fatal transport hiccup that stays op-level.
 *
 *   'auth'        — HTTP 401: the request got a RESPONSE with status 401. The token is
 *                   rejected; retrying with the same credential is pointless → degrade.
 *   'unreachable' — the request never got a response: a network / CORS / mixed-content /
 *                   connection failure. Browsers DELIBERATELY collapse these into an
 *                   opaque TypeError ("Failed to fetch" / "NetworkError…" / "Load
 *                   failed"), so JS cannot tell which — all mean the spine is gone.
 *   null          — anything else (e.g. a JSON-RPC protocol error): NOT a connection
 *                   loss; leave the connection up and let the op-level path handle it.
 *
 * Domain errors (validation_failed / conflict) NEVER reach this classifier: they come
 * back as in-band `isError` results (not thrown), so they can never trigger a degrade —
 * exactly the discrimination the mid-session hardening requires.
 */
export function classifyFatal(e) {
  const status = e && (e.status ?? e.code ?? (e.response && e.response.status));
  if (status === 401) return 'auth';
  const msg = String((e && e.message) || e || '');

  // Auth semantics an error VALUE may carry. Keyed off the value (not a bare scan of the
  // whole message), so an unrelated mention of a word can't false-positive.
  const AUTH_VALUE = /unauthorized|invalid[\s_-]*(token|credential)|token[\s_-]*expired|\b401\b/i;

  // Parse-THEN-regex (FIX B): the SDK wraps the server's JSON body in a prose prefix, e.g.
  //   Error POSTing to endpoint: {"error":"unauthorized"}
  // Extract the {...} substring and JSON.parse it under try/catch; if a STRING error field
  // carries auth semantics, classify 'auth' off that structured value. On a parse failure or
  // no match, fall through to the raw-message regex net below (behavior unchanged there).
  const open = msg.indexOf('{');
  const close = msg.lastIndexOf('}');
  if (open !== -1 && close > open) {
    try {
      const body = JSON.parse(msg.slice(open, close + 1));
      const field = body && (body.error ?? body.message ?? body.error_description ?? body.code);
      if (typeof field === 'string' && AUTH_VALUE.test(field)) return 'auth';
    } catch { /* not JSON — fall through to the raw regex net */ }
  }

  // Raw-message safety net (final): a 401/unauthorized anywhere in the text is still auth;
  // the opaque browser network collapses (TypeError / "failed to fetch" / connection-refused)
  // are unreachable. This block is unchanged from before FIX B — the structured parse only
  // ADDS a precise auth path ahead of it, never removing a classification.
  if (/\b401\b|unauthorized/i.test(msg)) return 'auth';
  if ((typeof TypeError !== 'undefined' && e instanceof TypeError)
    || /failed to fetch|networkerror|network request failed|load failed|err_connection|connection (refused|reset|closed|timed out)|econnrefused|enotfound|fetch failed/i.test(msg)) {
    return 'unreachable';
  }
  return null;
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
  onFatal,
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
      // Mid-session TRANSPORT failure (thrown by the SDK — distinct from an in-band
      // domain error, which arrives below as an isError result). Discriminate the two
      // FATAL classes that must tear the whole connection down (auth 401 /
      // network|CORS|connection) from a benign protocol hiccup: ONLY a fatal class
      // notifies onFatal → the controller degrades to Local (setLocal(true)), firing the
      // subscribe→setSpineModel(null) cascade so the board snaps to disconnected. We
      // STILL throw so the caller's per-op loud-revert also runs (both fire; the revert
      // no-ops once the mirror is gone). validation_failed / conflict never reach here
      // (they're isError results, handled below) — so they NEVER degrade.
      const fatal = classifyFatal(e);
      const err = new MCPProviderError(fatal || 'transport', e?.message || `MCP transport error calling ${toolName}`, { cause: e });
      // Label the fatal class on the thrown error (FIX C) so the controller's degrade policy
      // can tell 'auth' (degrade instantly) from 'unreachable' (poll rides out strikes)
      // without re-classifying. onFatal still fires here so a USER-OP fatal degrades at once;
      // the controller counts strikes only for the poll path (via its pollInFlight window).
      if (fatal) err.fatalKind = fatal;
      if (fatal && typeof onFatal === 'function') onFatal(err);
      throw err;
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
        // Classify so the UI can separate a rejected token (401 → 'auth' → "check your
        // token") from an unreachable/CORS/mixed-content spine ('unreachable' → the
        // connection checklist). A non-fatal-classed connect failure still surfaces as
        // 'unreachable' (connect failed = no board to render), never a false 'auth'.
        const cls = classifyFatal(e);
        throw new MCPProviderError(cls === 'auth' ? 'auth' : 'unreachable', e?.message || 'MCP connect failed', { cause: e });
      }

      const info = client.getServerVersion(); // serverInfo { name, version }
      let tools;
      try {
        ({ tools } = await client.listTools());
      } catch (e) {
        // A 401/network failure on tools/list (after a clean initialize) is still a
        // fatal connect outcome — classify it so the UI shows the right message; any
        // other listTools failure stays 'transport'.
        const cls = classifyFatal(e);
        throw new MCPProviderError(cls || 'transport', e?.message || 'tools/list failed', { cause: e });
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
        // canArchive gates the GOVERNED archive pair (spec v0.4.0 §Archive) — the
        // audited path that sets/clears the orthogonal archived_at flag and writes an
        // archive_audit row. Per spec §Discovery it derives from card_archive ALONE,
        // INDEPENDENT of canWrite and canRetier (the exact canRetier pattern).
        // canUnarchive derives from card_unarchive alone: a server advertising
        // card_archive WITHOUT card_unarchive is a valid one-way archiver — the client
        // shows the archive affordance but no unarchive affordance (spec §Discovery).
        canArchive: toolNames.has('card_archive'),
        canUnarchive: toolNames.has('card_unarchive'),
        // canTargetProjects gates the PROJECT-TARGETING READ (project_list) — the
        // enumeration a project-aware create rides on (spec v0.6.0 §Projects). Per
        // spec §Discovery it derives from project_list ALONE, independent of canWrite
        // (a server may expose the enumeration read-only, or accept untargeted
        // creates without it). The board's project picker gates on THIS flag; when
        // false, cardCreate simply sends no project_id (a projectless conforming
        // server accepts the bare CardInput).
        canTargetProjects: toolNames.has('project_list'),
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
    async list({ since = null, includeDeleted = false, includeArchived = false, columnId, tag } = {}) {
      requireConnected();
      return call('card_list', {
        updated_since: since,
        include_deleted: includeDeleted,
        // include_archived (spec v0.4.0): archived cards are OMITTED from a default
        // full fetch; the flag composes with include_deleted (a deleted+archived card
        // needs both). Param name mirrors includeDeleted at THIS interface.
        include_archived: includeArchived,
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
     *  part of the optimistic prior-state snapshot (see App's write handlers). */
    /** cardCreate — the board's create write-through (the slice the DEFERRED note
     *  here used to reserve; the project-targeting plumbing now exists). Sends the
     *  spec's { card: CardInput } with the OPTIONAL top-level project_id extension
     *  (spec v0.6.0): project_id rides NEXT TO the card, so CardInput stays a pure
     *  Card subset. The caller resolves the target via projectList() when
     *  canTargetProjects; when it passes none, the key is genuinely OMITTED (never
     *  sent null) — a project-aware server then rejects loudly (validation_failed
     *  naming project_list), a projectless server just creates. HUMAN-INTAKE
     *  SEMANTICS LIVE AT THE CALL SITE: the board sends column_id 'created' and NO
     *  tier (creation is intent capture; classification is a later rung) — this
     *  method still maps a tier if a non-board caller supplies one (toWirePatch,
     *  the single tier-translation seam, internal hyphen → wire colon; null tier
     *  dropped). Gated on canWrite (card_create is one of the four-tool write set,
     *  spec §Discovery). The returned card is CANONICAL (spec §Create): the caller
     *  adopts it wholesale — server-minted version included — replacing any
     *  optimistic local state; it re-projects to internal here (tier from tags)
     *  like every Card crossing this boundary. */
    async cardCreate(input = {}, { project_id } = {}) {
      requireCapability('canWrite');
      const out = await call('card_create', {
        card: toWirePatch(input),
        ...(project_id != null ? { project_id } : {}),
      });
      return toInternalCard(out.card);
    },
    async cardUpdate(id, { title, acceptance_criteria, tier, effort, impact, due, depends_on, expected_version } = {}) {
      requireCapability('canWrite');
      // Field-scoped patch: only the keys actually supplied, so an unset field is
      // never clobbered with `undefined`. column_id/order are NOT update fields — a
      // reposition is cardMove (update never repositions, mirroring card-store).
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (acceptance_criteria !== undefined) patch.acceptance_criteria = acceptance_criteria;
      // Tier crosses the wire in COLON form; the board edits it in internal HYPHEN
      // form. Map internal → wire HERE so the spine's strict validator accepts it.
      // A null tier is OMITTED (not forwarded): tier=None means "leave unchanged" on
      // the spine. With read-from-tags restoring write-once tierLock, untier is
      // unreachable by design anyway — belt-and-suspenders.
      if (tier !== undefined && tier !== null) patch.tier = tierInternalToWire(tier);
      // effort/impact: plain ungoverned fields, forwarded verbatim including null
      // (key-presence semantics: null = clear, per RFC 7386 / v0.5.0 spec).
      if (effort !== undefined) patch.effort = effort;
      if (impact !== undefined) patch.impact = impact;
      // due: nullable ISO 8601; null = clear (key-presence semantics).
      if (due !== undefined) patch.due = due;
      // depends_on: [] = clear (type-strict per spec; null → validation_failed).
      if (depends_on !== undefined) patch.depends_on = depends_on;
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

    /** card_archive — the GOVERNED, audited archive (spec v0.4.0 §Archive). Sets the
     *  orthogonal archived_at flag on an ACTIVE card (NOT a delete, NOT a column move);
     *  the server records an append-only archive_audit row and enforces every invariant:
     *  LOUD idempotency (an already-archived target → 'validation_failed', never a
     *  silent no-op) and the ESCALATION GATE (an OPEN escalation on the card blocks
     *  archive → 'validation_failed'). Gated on `canArchive` (card_archive advertised),
     *  INDEPENDENT of canWrite/canRetier — cardRetier's shape mirrored exactly. There is
     *  NO force: a stale expected_version or tombstoned target is code 'conflict'
     *  carrying meta.current (the gate runs BEFORE the domain invariants — same
     *  boundary as every governed write). `reason` is OPTIONAL on the wire: when the
     *  caller omits it, it is genuinely OMITTED from the call (never sent as null) and
     *  the server defaults "manual_archive"; an EXPLICITLY empty/whitespace reason is
     *  server-REJECTED, not defaulted — so this method passes a supplied reason through
     *  verbatim. NEVER folded into cardUpdate: archived_at moves ONLY through this pair. */
    async cardArchive(id, expected_version, reason) {
      requireCapability('canArchive');
      const out = await call('card_archive', { id, expected_version, ...(reason != null ? { reason } : {}) });
      return toInternalCard(out.card);
    },
    /** card_unarchive — clears archived_at, returning the card to the default view.
     *  Symmetric to cardArchive (same governed shape, same conflict-before-invariants
     *  gate, same two-layer reason handling with the "manual_unarchive" default) with
     *  two deliberate asymmetries: it gates on `canUnarchive` (card_unarchive
     *  advertised ALONE — a card_archive-only server is a valid one-way archiver per
     *  spec §Discovery, so unarchive gets its own flag), and it has NO escalation gate
     *  (restoring a card to view never buries anything). Loud idempotency mirrors
     *  archive: a NOT-archived target → 'validation_failed'. */
    async cardUnarchive(id, expected_version, reason) {
      requireCapability('canUnarchive');
      const out = await call('card_unarchive', { id, expected_version, ...(reason != null ? { reason } : {}) });
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

    /* ---- projects (optional capability — the project-targeting read) ---- */
    /** project_list — enumerate the server's live projects ({ id, name, created_at })
     *  so a create can be TARGETED (the id feeds cardCreate's project_id). Gated on
     *  `canTargetProjects` (project_list advertised ALONE, independent of canWrite —
     *  the exact canRetier pattern). Read-only; server order is preserved (the spine
     *  serves a deterministic (created_at, id) sort — never re-sorted here). */
    async projectList() {
      requireCapability('canTargetProjects');
      return (await call('project_list', {})).projects || [];
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
