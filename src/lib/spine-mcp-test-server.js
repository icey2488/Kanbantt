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
 *  can omit any of these to simulate an incompatible / capability-limited server.
 *  `card_retier` is the GOVERNED/audited tier-change tool — advertising it is what
 *  lets the provider's `canRetier` derive true (spec v0.3.0). */
const ALL_TOOLS = [
  'board_get', 'card_list', 'card_get', 'card_create', 'card_update', 'card_move', 'card_delete', 'card_retier',
  'column_create', 'column_update', 'column_delete',
  'tag_create', 'tag_update', 'tag_delete',
  'escalation_list', 'escalation_resolve', 'artifact_list',
];

/** Actor stamped on every tier_audit row — the authenticated-client PLACEHOLDER,
 *  byte-identical to the real spine's RETIER_ACTOR ("client:bearer"). Every client
 *  shares the single Bearer token today; per-user attribution is a Stage-2 seam. */
const RETIER_ACTOR = 'client:bearer';

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

/* ---- tier fidelity: match the REAL spine, which has NO native `card.tier` ----
 *  projection.py never emits a native tier field — tier lives ONLY in `tags` as
 *  "tier:N". So the harness folds an incoming colon `tier` (card_create's card /
 *  card_update's patch) INTO tags and persists no native tier field, exactly as
 *  the real wire does. (A pure mock fabricating a native tier is what made the
 *  tier tests falsely green against a field the real projection never produces.) */
const TIER_TAG_RE = /^tier:([1-9][0-9]*)$/;          // colon wire form "tier:3"
/** Replace any prior tier tag with the new one (single-valued); a non-"tier:N"
 *  value (e.g. null) just strips the existing tier tag — no native field minted. */
function foldTierIntoTags(tier, tags) {
  const base = (Array.isArray(tags) ? tags : []).filter((t) => !TIER_TAG_RE.test(t));
  return typeof tier === 'string' && TIER_TAG_RE.test(tier) ? [...base, tier] : base;
}
/** card_create: fold a native `tier` on the input card into its tags, dropping
 *  the native field so the stored/emitted card carries tier only as a tag. */
function tierFoldCreate(card) {
  if (!card || typeof card !== 'object' || !('tier' in card)) return card;
  const rest = { ...card };
  delete rest.tier;
  rest.tags = foldTierIntoTags(card.tier, rest.tags);
  return rest;
}
/** card_update: fold a patch `tier` into tags. The patch usually omits `tags`, so
 *  merge onto the card's CURRENT tags (passed in) — other tags survive the tier
 *  edit — and never persist a native tier field. */
function tierFoldPatch(patch, current) {
  if (!patch || typeof patch !== 'object' || !('tier' in patch)) return patch;
  const rest = { ...patch };
  delete rest.tier;
  const baseTags = Array.isArray(rest.tags) ? rest.tags : (current && current.tags) || [];
  rest.tags = foldTierIntoTags(patch.tier, baseTags);
  return rest;
}

/* ---- tier as an INTEGER (re-tier governance: range, no-op, write-once checks) ----
 *  The spine reasons over tier as an int (1..4); on this side tier lives as a
 *  "tier:N" tag, so these are the parse seams the governed paths use. */
/** Parse a colon wire value "tier:N" → the int N, or null if it is not a tier tag. */
function tierIntFromWire(value) {
  if (typeof value !== 'string') return null;
  const m = TIER_TAG_RE.exec(value);
  return m ? Number(m[1]) : null;
}
/** The card's CURRENT tier as an int (the first "tier:N" tag wins, single-valued by
 *  contract), or null when the card is untiered. Mirrors the spine reading task.tier. */
function tierIntFromTags(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const n = tierIntFromWire(t);
    if (n !== null) return n;
  }
  return null;
}

/* ---- wire-tier PARSER/VALIDATOR: faithful to the spine's _patch_tier_to_int ----
 *  A SEPARATE seam from TIER_TAG_RE / tierIntFromTags (which read CANONICAL stored
 *  tags, N>=1). This parses raw WIRE INPUT — card_update's patch.tier, card_retier's
 *  new_tier — EXACTLY as spine_server.server._patch_tier_to_int does, so junk that
 *  TIER_TAG_RE would silently treat as "no tier" (tier:0, negatives, non-"tier:N"
 *  strings, a literal null) is range- or malformed-REJECTED, never a silent untier.
 *  ONE seam shared by BOTH governed write paths → they classify malformed vs
 *  out-of-range identically to the spine. */

/** Python repr() for the values the spine's malformed message interpolates ({value!r}):
 *  a string → single-quoted, null/undefined → None, a bool → True/False, a number →
 *  bare. Lets the mock emit _patch_tier_to_int's message BYTE-FOR-BYTE (e.g. the
 *  null case → "...got None"). */
function pyRepr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}

/** The MALFORMED message, verbatim from _patch_tier_to_int — a value not parseable to a
 *  tier int (e.g. "tier:-1", "tier:abc", "banana", a literal null → "got None"). */
const malformedTierMsg = (v) => `tier must be the tag-id string 'tier:N' or an int 1..4, got ${pyRepr(v)}`;

/** Parse a wire tier value the way _patch_tier_to_int does — a bare int OR the tag-id
 *  string "tier:<digits>" (INCLUDING "tier:0"; a leading-zero suffix too, as Python's
 *  str.isdigit() allows). Returns the int with the 1..4 RANGE STILL UNCHECKED (the
 *  caller enforces it with its OWN message — "tier must be..." for update vs
 *  "new_tier must be..." for retier), or null when the value is MALFORMED (not parseable
 *  → the spine's _patch_tier_to_int ValueError). A bool is never a tier (bool is an int
 *  subclass on the spine, rejected there too). */
function patchTierToInt(value) {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.startsWith('tier:')) {
    const suffix = value.slice('tier:'.length);
    if (/^[0-9]+$/.test(suffix)) return Number(suffix);
  }
  return null;
}

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

  // The append-only re-tier governance ledger — the in-memory analogue of the spine's
  // tier_audit table. card_retier pushes ONE row per successful change; tests read it
  // back via the exposed `tierAudit()` accessor (the spine exposes store.list_tier_audit).
  const auditLog = [];

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

  /** The store's write gate WITHOUT writing: not_found → tombstone-immutable →
   *  version mismatch, in that order. This lets the governed paths (card_retier, the
   *  card_update write-once guard) run their validation in the SPINE's order — the
   *  gate FIRST, so a tombstoned/stale target is a `conflict`, never a spurious
   *  validation_failed. Returns { card } (a clone, from store.get) on pass, or
   *  { error } (a ready domain-error result) to short-circuit. MUST mirror
   *  card-store.assertMutable + its not_found check (kept in lockstep with it). */
  function gateMutable(id, { expected_version, force = false }) {
    const card = store.get(id); // get() returns a clone, tombstones included, or null
    if (!card) return { error: domainError('not_found', `no card ${id}`, { id }) };
    // A tombstone is immutable — even force cannot resurrect it (checked before version).
    if (card.deleted_at) return { error: domainError('conflict', 'version conflict', { card }) };
    if (!force && expected_version !== card.version) return { error: domainError('conflict', 'version conflict', { card }) };
    return { card };
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
        case 'card_create': return ok({ card: store.create(tierFoldCreate(a.card || {})) });
        case 'card_update': {
          let patch = a.patch || {};
          // TIER hygiene → gate → WRITE-ONCE, in the SPINE's order (server._patch_tier_to_int
          // + Spine.update_task). INPUT HYGIENE runs BEFORE the gate: parse the wire tier as
          // _patch_tier_to_int does, then range-check 1..4. A value that does not parse to a
          // tier int is MALFORMED (the _patch_tier_to_int message — incl. a literal null →
          // "got None", a REJECT, NOT a silent untier-strip); a parseable int outside 1..4 is
          // the RANGE error (update_task's `tier must be an int in 1..4`). Both are
          // validation_failed regardless of version/tombstone, so an out-of-range CHANGE on a
          // set tier reports RANGE, not "write-once". The WRITE-ONCE guard, needing the CURRENT
          // tier, runs AFTER the gate (so a stale/tombstoned write is a `conflict`, not a
          // spurious validation_failed). Untiered → N (initial classification) and a same-tier
          // restatement pass; force bypasses neither.
          if (patch && typeof patch === 'object' && 'tier' in patch) {
            const newTier = patchTierToInt(patch.tier);
            if (newTier === null) {
              return domainError('validation_failed', malformedTierMsg(patch.tier), { id: a.id });
            }
            if (newTier < 1 || newTier > 4) {
              return domainError('validation_failed', `tier must be an int in 1..4, got ${newTier}`, { id: a.id });
            }
            const gate = gateMutable(a.id, { expected_version: a.expected_version, force: a.force });
            if (gate.error) return gate.error;
            const oldTier = tierIntFromTags(gate.card.tags);
            if (oldTier !== null && newTier !== oldTier) {
              return domainError('validation_failed', 'tier is write-once; use card_retier to change a set tier', { id: a.id });
            }
            // Normalize to the canonical "tier:N" tag form so the fold SETS the tier even for
            // a bare-int caller (the spine tolerates a bare int; the projection always re-emits
            // "tier:N"). For the "tier:N" wire form this is a no-op.
            patch = { ...patch, tier: `tier:${newTier}` };
          }
          return ok({ card: store.update(a.id, tierFoldPatch(patch, store.get(a.id)), { expected_version: a.expected_version, force: a.force }) });
        }
        case 'card_move': return ok({ card: store.move(a.id, { column_id: a.column_id, order: a.order }, { expected_version: a.expected_version, force: a.force }) });
        case 'card_delete': return ok({ card: store.delete(a.id, { expected_version: a.expected_version }) });
        case 'card_retier': {
          // GOVERNED, audited tier change — IDENTICAL semantics AND ORDER to the spine's
          // card_retier path. The spine parses new_tier with _patch_tier_to_int in the TOOL
          // layer BEFORE the store gate (so a MALFORMED new_tier is validation_failed even on
          // a not_found/tombstoned card), then Spine.retier_task runs gate → untiered → 1..4
          // RANGE → no-op → reason. So the order here is: malformed → gate(not_found /
          // tombstone / version; NO force) → untiered → range → no-op → reason. On success:
          // rewrite the tier tag (every OTHER tag untouched) + append ONE audit row. NO
          // rejection branch writes a row.
          const newTier = patchTierToInt(a.new_tier);
          if (newTier === null) {
            // MALFORMED (incl. a literal null), classified BEFORE the gate as the spine does.
            // NOTE: the real spine types new_tier as a REQUIRED string, so on the wire a literal
            // null is rejected at FastMCP's schema layer (isError, NO domain envelope) and never
            // reaches _patch_tier_to_int; the mock's permissive {type:object} schema lets null
            // through, so it lands here as a clean validation_failed. Both REJECT (no mutation,
            // no audit row) — the parity invariant — differing only in the error envelope.
            return domainError('validation_failed', malformedTierMsg(a.new_tier), { id: a.id });
          }
          const gate = gateMutable(a.id, { expected_version: a.expected_version }); // NO force
          if (gate.error) return gate.error;
          const current = gate.card;
          const oldTier = tierIntFromTags(current.tags);
          if (oldTier === null) return domainError('validation_failed', 'card is untiered; set the initial tier via card_update', { id: a.id });
          if (newTier < 1 || newTier > 4) {
            return domainError('validation_failed', `new_tier must be an int in 1..4, got ${newTier}`, { id: a.id });
          }
          if (newTier === oldTier) return domainError('validation_failed', 'new_tier equals current tier; nothing to change', { id: a.id });
          if (typeof a.reason !== 'string' || a.reason.trim() === '') return domainError('validation_failed', 'retier requires a non-empty reason', { id: a.id });
          // Atomic on the spine; here the write is version-checked (the gate already
          // passed, so it succeeds) and the row is appended AFTER it — no orphan row on a
          // failed write. reduces_control is a JS boolean (new < old); the spine records
          // the SAME fact as int 0/1 — an internal field that never crosses the wire.
          const card = store.update(a.id, { tags: foldTierIntoTags(`tier:${newTier}`, current.tags) }, { expected_version: a.expected_version });
          auditLog.push({
            card_id: a.id,
            old_tier: oldTier,
            new_tier: newTier,
            reduces_control: newTier < oldTier,
            actor: RETIER_ACTOR,
            reason: a.reason,
            ts: new Date().toISOString(),
          });
          return ok({ card });
        }
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
    /** The append-only tier_audit ledger (copies), in insert order — the in-memory
     *  analogue of the spine's store.list_tier_audit() for test assertions. */
    tierAudit: () => auditLog.map((r) => ({ ...r })),
    async close() {
      try { await transport.close(); } catch { /* best effort */ }
      try { await server.close(); } catch { /* best effort */ }
    },
  };
}
