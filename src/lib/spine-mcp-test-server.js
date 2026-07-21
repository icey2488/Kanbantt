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
  'card_archive', 'card_unarchive',
  'column_create', 'column_update', 'column_delete',
  'tag_create', 'tag_update', 'tag_delete',
  'escalation_list', 'escalation_resolve', 'artifact_list',
  'project_list',
];

/** Actor stamped on every tier_audit row — the authenticated-client PLACEHOLDER,
 *  byte-identical to the real spine's RETIER_ACTOR ("client:bearer"). Every client
 *  shares the single Bearer token today; per-user attribution is a Stage-2 seam. */
const RETIER_ACTOR = 'client:bearer';

/** Actor stamped on every archive_audit row — same placeholder stance as
 *  RETIER_ACTOR, byte-identical to the real spine's ARCHIVE_ACTOR. */
const ARCHIVE_ACTOR = 'client:bearer';

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

/** Emit-side projection parity: the real spine's Card lens (projection.to_card, and
 *  tombstone_card which reuses it) ALWAYS emits a `tags` ARRAY — [] when untiered
 *  (projection._tags_for) — on EVERY card that crosses the wire, conflict
 *  meta.current included. The store, by contrast, preserves client fields verbatim,
 *  so a tagless create stores no `tags` key at all. Normalize at the wire boundary,
 *  never in the store (LocalProvider shares card-store and its cards are not wire
 *  Cards). */
const emitCard = (c) => (c && typeof c === 'object' && !Array.isArray(c.tags) ? { ...c, tags: [] } : c);

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
 * @param {Array<object>} [opts.escalations]  MINIMAL escalation fixture (the mock
 *        previously had NO escalation model — escalation_list was a bare [] stub).
 *        Entries follow the spine's linkage the archive gate + projection badge share:
 *        { id, card_id, resolved_at: null|ISO, deleted_at: null|ISO, resolution? }.
 *        OPEN (blocks card_archive) = live (deleted_at == null) AND unresolved
 *        (resolved_at == null) — the spine's _has_open_escalation predicate verbatim;
 *        a resolved escalation (even a DENIED one) does NOT block. Tests mutate the
 *        exposed `escalations` handle (or use escalation_resolve) to flip states.
 * @param {Array<object>|null} [opts.projects]  MINIMAL project fixture, mirroring the
 *        real spine's project model (spec v0.6.0 §Projects). Entries:
 *        { id, name, created_at?, deleted_at? }. PROVIDED (even []) ⇒ the harness is a
 *        PROJECT-AWARE spine: project_list serves the live entries and card_create
 *        REQUIRES a live project_id — absent → validation_failed naming project_list,
 *        unknown/tombstoned → not_found — with the duplicate-id idempotency check
 *        running BEFORE the requirement (the real spine's order: a retry of a landed
 *        create never trips targeting). OMITTED (null) ⇒ the projectless conforming
 *        server: project_list serves an empty enumeration and card_create ignores
 *        project targeting entirely. The card_list projection carries NO project field
 *        either way (project is server-side semantics, exactly as the real lens).
 * @returns {{ url, fetchFn, store, server, escalations, createdProjects, close }}
 */
export function createMcpTestServer({ seed, name = 'Claunker', omitTools = [], payloadStyle = 'structured', schemaVersion = 1, errorOn = {}, escalations = [], projects = null } = {}) {
  const store = createStore({ storage: memStorage(), actor: { type: 'agent', id: 'spine' } });
  store.load();
  if (typeof seed === 'function') seed(store);

  // The append-only re-tier governance ledger — the in-memory analogue of the spine's
  // tier_audit table. card_retier pushes ONE row per successful change; tests read it
  // back via the exposed `tierAudit()` accessor (the spine exposes store.list_tier_audit).
  const auditLog = [];

  // The append-only ARCHIVE governance ledger — the in-memory analogue of the spine's
  // archive_audit table (one row per successful archive/unarchive; NO rejection branch
  // writes a row). Read back via the exposed `archiveAudit()` accessor.
  const archiveAuditLog = [];

  // The project fixture (see opts.projects above). `projectAware` distinguishes a
  // project-aware spine (fixture provided, even empty) from the projectless
  // conforming server (null) — the two card_create stances.
  const projectAware = projects != null;
  const projectFixture = (projects || []).map((p) => ({ ...p }));
  const liveProject = (id) => projectFixture.find((p) => p.id === id && p.deleted_at == null);
  // card id → the project_id its create targeted (the spine stores project_id on the
  // Task but never projects it onto the Card; this is the test-side observability
  // for "which project did the create land in").
  const createdProjects = new Map();

  // The live escalation fixture (see opts.escalations above). A mutable array handle:
  // the archive gate reads it, escalation_list serves it, escalation_resolve resolves
  // into it, and tests may mutate entries directly.
  const escalationFixture = escalations.map((e) => ({ ...e }));
  /** The spine's _has_open_escalation predicate: live + unresolved + linked to card. */
  const hasOpenEscalation = (cardId) =>
    escalationFixture.some((e) => e.card_id === cardId && e.deleted_at == null && e.resolved_at == null);

  const tools = ALL_TOOLS.filter((t) => !omitTools.includes(t));
  const has = (t) => tools.includes(t);

  /* ---- result builders (the payload-shape switch lives here) ---- */
  const wrap = (obj) => (payloadStyle === 'text'
    ? { content: [{ type: 'text', text: JSON.stringify(obj) }] }
    : { structuredContent: obj, content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const ok = (obj) => wrap(obj);
  const domainError = (code, message, meta = {}) => ({ isError: true, ...wrap({ code, message, meta }) });
  /** A SCHEMA-LAYER rejection — the envelope the real spine emits when arguments
   *  fail a tool's declared input schema BEFORE the tool body runs (FastMCP's
   *  pydantic layer): isError carrying the failure as PLAIN TEXT, with NO
   *  structuredContent and no domain {code,message,meta} envelope. The provider,
   *  finding no parseable payload, classifies it request_failed. */
  const schemaError = (text) => ({ isError: true, content: [{ type: 'text', text }] });

  /** Map a card-store StoreError onto a spec domain-error payload (conflict carries
   *  the current card under meta.current — the REAL spine's key, which the provider
   *  passes through to the board's conflict contract verbatim). */
  function fromStoreError(e) {
    if (e && e.code === 'conflict') return domainError('conflict', e.message, { current: emitCard(e.meta && e.meta.current) });
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
    if (card.deleted_at) return { error: domainError('conflict', 'version conflict', { current: emitCard(card) }) };
    if (!force && expected_version !== card.version) return { error: domainError('conflict', 'version conflict', { current: emitCard(card) }) };
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
          // include_archived (spec v0.4.0): archived cards are OMITTED from a FULL
          // fetch by default, included on request. The filter is SUBTRACTIVE and runs
          // over whatever include_deleted admitted, so the two flags COMPOSE: a
          // deleted+archived card needs BOTH to appear (mirrors the real spine's
          // list_cards ordering — tombstone merge first, archived filter after).
          // Per spec §Synchronization the flag is IGNORED for delta queries
          // (updated_since set): archive/unarchive mint a version like any mutation,
          // so those changes ride the delta unconditionally. (The real spine has no
          // delta path in v1 — updated_since is a documented full-snapshot no-op
          // there — so the spec, not the spine, is the parity target for deltas.)
          if (a.updated_since == null && !a.include_archived) {
            cards = cards.filter((c) => c.archived_at == null);
          }
          if (a.column_id != null) cards = cards.filter((c) => c.column_id === a.column_id);
          if (a.tag != null) cards = cards.filter((c) => (c.tags || []).includes(a.tag));
          return ok({ cards: cards.map(emitCard), sync_token: out.sync_token });
        }
        case 'card_get': {
          const card = store.get(a.id);
          return card ? ok({ card: emitCard(card) }) : domainError('not_found', `no card ${a.id}`, { id: a.id });
        }
        case 'card_create': {
          const input = a.card || {};
          // INPUT HYGIENE first (the spine's validate-before-lookup order): a create
          // is operator intent and intent needs words — title is the ONE required
          // CardInput field (v0.6.0; id/column_id/order all have authority defaults).
          if (typeof input.title !== 'string' || !input.title.trim()) {
            return domainError('validation_failed', 'card.title must be a non-empty string', {});
          }
          // IDEMPOTENT CREATE runs FIRST (spec §Create + the real spine's order): an
          // id the store already knows returns the existing card as success BEFORE
          // the project-targeting requirement — a retry of a landed create never
          // trips targeting. store.create dedupes internally too, but the check must
          // precede the project gate for order parity.
          if (input.id != null) {
            const existing = store.get(input.id);
            if (existing) return ok({ card: emitCard(existing) });
          }
          if (projectAware) {
            // PROJECT-AWARE stance (the real spine, verbatim): required, explicit,
            // live-only, no default-project fallback. Message parity with
            // spine_server.server.card_create.
            if (a.project_id == null) {
              return domainError('validation_failed',
                'card_create on this server requires project targeting: '
                + 'pass project_id (enumerate live projects via project_list)', {});
            }
            if (!liveProject(a.project_id)) {
              return domainError('not_found', `project ${pyRepr(a.project_id)} does not exist`, { project_id: a.project_id });
            }
          }
          const card = store.create(tierFoldCreate(input));
          if (projectAware) createdProjects.set(card.id, a.project_id);
          return ok({ card: emitCard(card) });
        }
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
          return ok({ card: emitCard(store.update(a.id, tierFoldPatch(patch, store.get(a.id)), { expected_version: a.expected_version, force: a.force })) });
        }
        case 'card_move': return ok({ card: emitCard(store.move(a.id, { column_id: a.column_id, order: a.order }, { expected_version: a.expected_version, force: a.force })) });
        case 'card_delete': return ok({ card: emitCard(store.delete(a.id, { expected_version: a.expected_version })) });
        case 'card_retier': {
          // GOVERNED, audited tier change — IDENTICAL semantics AND ORDER to the spine's
          // card_retier path. The spine parses new_tier with _patch_tier_to_int in the TOOL
          // layer BEFORE the store gate (so a MALFORMED new_tier is validation_failed even on
          // a not_found/tombstoned card), then Spine.retier_task runs gate → untiered → 1..4
          // RANGE → no-op → reason. So the order here is: schema(null) → malformed →
          // gate(not_found / tombstone / version; NO force) → untiered → range → no-op →
          // reason. On success:
          // rewrite the tier tag (every OTHER tag untouched) + append ONE audit row. NO
          // rejection branch writes a row.
          // The real spine types new_tier as a REQUIRED string, so a literal null (or an
          // omitted new_tier) dies at FastMCP's schema layer before the tool body runs —
          // schemaError envelope, no mutation, no audit row.
          if (a.new_tier == null) {
            return schemaError('1 validation error for card_retier\nnew_tier\n  Input should be a valid string [type=string_type, input_value=None, input_type=NoneType]');
          }
          const newTier = patchTierToInt(a.new_tier);
          if (newTier === null) {
            // MALFORMED, classified BEFORE the gate as the spine does.
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
          const card = emitCard(store.update(a.id, { tags: foldTierIntoTags(`tier:${newTier}`, current.tags) }, { expected_version: a.expected_version }));
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
        case 'card_archive': {
          // GOVERNED, audited archive — IDENTICAL semantics AND ORDER to the spine's
          // card_archive path (spec v0.4.0 §Archive). TOOL-LAYER reason defaulting
          // runs FIRST (spine server.py: an OMITTED reason → "manual_archive" before
          // anything else), so only an EXPLICIT empty/whitespace reason can reach the
          // ledger's reject — the two-layer rule: omission is ergonomic, explicit
          // garbage is loud. Then gate → invariants, the spine's archive_task order:
          // gateMutable (not_found / tombstone / stale version → conflict; NO force —
          // conflict-before-domain, so a stale re-archive is a `conflict`, never a
          // spurious "already archived") → LOUD idempotency (already-archived →
          // validation_failed; a healthy archive and a re-archive must not emit the
          // same signal — sweepers filter their own targets) → ESCALATION GATE (an
          // OPEN escalation — live AND unresolved — blocks; archiving would bury a
          // card awaiting attention; a RESOLVED escalation, even a denied one, does
          // NOT block) → the ledger's non-empty-reason invariant. On success: the
          // version-checked write (mints a fresh version; archived_at rides it) +
          // ONE audit row appended AFTER it — no orphan row on a failed write, the
          // retier idiom. NO rejection branch writes a row.
          const reason = a.reason == null ? 'manual_archive' : a.reason;
          const gate = gateMutable(a.id, { expected_version: a.expected_version }); // NO force
          if (gate.error) return gate.error;
          if (gate.card.archived_at != null) {
            return domainError('validation_failed', `task ${pyRepr(a.id)} is already archived`, { id: a.id });
          }
          if (hasOpenEscalation(a.id)) {
            return domainError('validation_failed', 'cannot archive a task with an unresolved escalation', { id: a.id });
          }
          if (typeof reason !== 'string' || reason.trim() === '') {
            return domainError('validation_failed', 'archive_audit rows require a non-empty reason', { id: a.id });
          }
          const card = emitCard(store.update(a.id, { archived_at: new Date().toISOString() }, { expected_version: a.expected_version }));
          archiveAuditLog.push({
            id: globalThis.crypto.randomUUID(),
            card_id: a.id,
            action: 'archive',
            actor: ARCHIVE_ACTOR,
            reason,
            ts: new Date().toISOString(),
          });
          return ok({ card });
        }
        case 'card_unarchive': {
          // Symmetric to card_archive (same tool-layer reason defaulting — the
          // "manual_unarchive" default — same gate-then-invariants order, same audit
          // idiom, action: "unarchive") with the two spec asymmetries: loud
          // idempotency flips (a NOT-archived target → validation_failed), and there
          // is NO escalation gate — restoring a card to view never buries anything.
          const reason = a.reason == null ? 'manual_unarchive' : a.reason;
          const gate = gateMutable(a.id, { expected_version: a.expected_version }); // NO force
          if (gate.error) return gate.error;
          if (gate.card.archived_at == null) {
            return domainError('validation_failed', `task ${pyRepr(a.id)} is not archived`, { id: a.id });
          }
          if (typeof reason !== 'string' || reason.trim() === '') {
            return domainError('validation_failed', 'archive_audit rows require a non-empty reason', { id: a.id });
          }
          const card = emitCard(store.update(a.id, { archived_at: null }, { expected_version: a.expected_version }));
          archiveAuditLog.push({
            id: globalThis.crypto.randomUUID(),
            card_id: a.id,
            action: 'unarchive',
            actor: ARCHIVE_ACTOR,
            reason,
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
        case 'escalation_list': {
          // Serves the LIVE fixture (deleted entries omitted), optional status filter
          // per the spec wire shape: pending = unresolved, resolved = resolved_at set.
          let list = escalationFixture.filter((e) => e.deleted_at == null);
          if (a.status === 'pending') list = list.filter((e) => e.resolved_at == null);
          if (a.status === 'resolved') list = list.filter((e) => e.resolved_at != null);
          return ok({ escalations: list.map((e) => ({ ...e })) });
        }
        case 'escalation_resolve': {
          // Resolves INTO the fixture when the id is known — stamping resolved_at is
          // what closes an escalation (the archive gate reads the same array, so a
          // resolve here immediately unblocks card_archive). An id the fixture does
          // not carry keeps the old echo behavior (the wire-args echo existing
          // provider tests assert on).
          const esc = escalationFixture.find((e) => e.id === a.id);
          if (esc) {
            esc.resolved_at = new Date().toISOString();
            esc.resolution = a.resolution;
            esc.resolution_rationale = a.resolution_rationale;
            return ok({ escalation: { ...esc, status: 'resolved' } });
          }
          return ok({ escalation: { id: a.id, status: 'resolved', resolution: a.resolution, resolution_rationale: a.resolution_rationale } });
        }
        case 'artifact_list': return ok({ artifacts: [] });
        case 'project_list': {
          // The project-targeting read (spec v0.6.0 §Projects): live fixture entries
          // only, minimal fields, deterministic (created_at, id) sort — the real
          // spine's serving order, preserved by the provider verbatim.
          const list = projectFixture
            .filter((p) => p.deleted_at == null)
            .map((p) => ({ id: p.id, name: p.name, created_at: p.created_at ?? null }))
            .sort((x, y) => ((x.created_at || '') < (y.created_at || '') ? -1
              : (x.created_at || '') > (y.created_at || '') ? 1
                : (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)));
          return ok({ projects: list });
        }
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
    /** The append-only archive_audit ledger (copies), in insert order — the
     *  in-memory analogue of the spine's store.list_archive_audit(). */
    archiveAudit: () => archiveAuditLog.map((r) => ({ ...r })),
    /** The LIVE escalation fixture handle (see opts.escalations): tests mutate
     *  entries directly (stamp resolved_at / deleted_at) or go through
     *  escalation_resolve; the card_archive gate reads this SAME array. */
    escalations: escalationFixture,
    /** card id → the project_id its create targeted (project-aware harness only) —
     *  the test-side analogue of Task.project_id, which the Card lens never emits. */
    createdProjects: () => new Map(createdProjects),
    async close() {
      try { await transport.close(); } catch { /* best effort */ }
      try { await server.close(); } catch { /* best effort */ }
    },
  };
}
