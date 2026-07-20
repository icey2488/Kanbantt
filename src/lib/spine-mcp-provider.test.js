/**
 * MCPProvider tests — the real provider driven against a conforming in-process
 * MCP server (spine-mcp-test-server.js: SDK Server + WebStandard StreamableHTTP
 * bridged onto the provider's fetchFn). This exercises the ACTUAL @modelcontextprotocol
 * round trip — initialize → tools/list → tools/call — not a hand-rolled mock, so
 * it closes the exact gaps the rewrite introduced:
 *   - which payload SHAPE the server emits (structuredContent vs a JSON text
 *     block) — the provider reads both; these tests prove it against each;
 *   - the conflict → meta.current remap (spec meta.card → board parity);
 *   - capability gating off advertised tool names;
 *   - LocalProvider parity (get(missing) → null, version-conflict shape).
 *
 * Run:  node --test src/lib/spine-mcp-provider.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider, MCPProviderError, classifyFatal } from './spine-mcp-provider.js';

/** Connect a provider to a fresh harness; returns { provider, harness }. */
async function connected(opts = {}) {
  const harness = createMcpTestServer(opts);
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  await provider.connect();
  return { provider, harness };
}
const oneCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med' });

/** A RAW MCP client on the harness — bypasses the provider's hyphen↔colon translation
 *  AND its null-omission, so a test can drive the mock's TOOL handlers with EXACT wire
 *  arguments (e.g. patch.tier = null, new_tier = "tier:0") and assert WIRE-LEVEL parity
 *  with the real spine, not just provider-shaped happy paths. */
async function rawWire(opts = {}) {
  const harness = createMcpTestServer(opts);
  const transport = new StreamableHTTPClientTransport(new URL(harness.url), { fetch: harness.fetchFn });
  const client = new Client({ name: 'wire-probe', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  const callRaw = (name, args) => client.callTool({ name, arguments: args });
  return {
    harness, callRaw,
    async close() { try { await client.close(); } catch { /* best effort */ } await harness.close(); },
  };
}
/** The tool result's object payload — structuredContent, or the JSON text-block fallback. */
const payloadOf = (r) => (r.structuredContent ?? JSON.parse(r.content[0].text));

/* ================================================================== */
/* connect: handshake, required tools, capability gating               */
/* ================================================================== */

test('connect → initialize + tools/list; server name and capabilities from advertised tools', async () => {
  const { provider, harness } = await connected();
  const { server, capabilities } = provider.getCapabilities();
  assert.equal(server.name, 'Claunker');
  assert.equal(server.schema_version, 1);
  assert.deepEqual(capabilities, {
    projects: true, tasks: true,
    hasCardCreate: true, hasCardUpdate: true, hasCardMove: true, hasCardDelete: true, canWrite: true,
    canRetier: true,
    canArchive: true, canUnarchive: true,
    canTargetProjects: true,
    escalations: true, canResolve: true, artifacts: true, columns: true, tags: true, realtime: false,
  });
  assert.equal(provider.supportsRealtime(), false, 'v1 is tools-only → board polls');
  assert.ok(provider.hasTool('card_move'));
  await provider.disconnect();
  await harness.close();
});

test('capability gating: a server without escalation tools fails escalationList as unsupported', async () => {
  const { provider, harness } = await connected({ omitTools: ['escalation_list', 'escalation_resolve'] });
  assert.equal(provider.getCapabilities().capabilities.escalations, false);
  assert.equal(provider.getCapabilities().capabilities.canResolve, false, 'no escalation_resolve ⇒ canResolve false');
  await assert.rejects(() => provider.escalationList(), (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability');
  await provider.disconnect();
  await harness.close();
});

test('escalationResolve sends id + resolution + resolution_rationale, gated on canResolve (not escalations)', async () => {
  // Asymmetric advertising: a spine advertising escalation_resolve but NOT
  // escalation_list ⇒ escalations:false yet canResolve:true. The resolve control
  // gates on canResolve, so it stays usable on that read-only-board spine.
  const { provider, harness } = await connected({ omitTools: ['escalation_list'] });
  const caps = provider.getCapabilities().capabilities;
  assert.equal(caps.escalations, false, 'escalations needs escalation_list too');
  assert.equal(caps.canResolve, true, 'canResolve needs only escalation_resolve');

  const out = await provider.escalationResolve('e1', { resolution: 'deny', resolution_rationale: 'rejecting on review' });
  // the harness echoes the wire args back → proves BOTH fields were forwarded.
  assert.equal(out.resolution, 'deny');
  assert.equal(out.resolution_rationale, 'rejecting on review');
  await provider.disconnect();
  await harness.close();
});

test('escalationResolve is unsupported when escalation_resolve is not advertised (canResolve false)', async () => {
  const { provider, harness } = await connected({ omitTools: ['escalation_resolve'] });
  assert.equal(provider.getCapabilities().capabilities.canResolve, false);
  await assert.rejects(
    () => provider.escalationResolve('e1', { resolution: 'approve', resolution_rationale: 'approved after review' }),
    (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability',
  );
  await provider.disconnect();
  await harness.close();
});

test('a server missing a card_* write tool connects read-only (canWrite false), not incompatible', async () => {
  // Option A: write tools are feature-gated, not connect blockers. A server with the
  // read pair but only some card_* tools connects fine and renders a read-only mirror.
  const { provider, harness } = await connected({ omitTools: ['card_move'] });
  const { capabilities } = provider.getCapabilities();
  assert.equal(capabilities.canWrite, false, 'missing card_move ⇒ writes gated off');
  assert.equal(capabilities.hasCardMove, false);
  assert.equal(capabilities.hasCardCreate, true, 'the other write tools are still detected');
  assert.ok((await provider.list({ includeDeleted: false })).cards, 'the read surface still works');
  await provider.disconnect();
  await harness.close();
});

test('incompatible server (missing a REQUIRED read tool) → connect throws incompatible_server', async () => {
  const harness = createMcpTestServer({ omitTools: ['card_list'] });
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  await assert.rejects(
    () => provider.connect(),
    (e) => e instanceof MCPProviderError && e.code === 'incompatible_server' && e.meta.missing.includes('card_list'),
  );
  await harness.close();
});

/* ================================================================== */
/* board + card round trips                                            */
/* ================================================================== */

test('getBoard → { board, kanbantt_schema_version }; columns in spec shape', async () => {
  const { provider, harness } = await connected();
  const out = await provider.getBoard();
  assert.equal(out.kanbantt_schema_version, 1);
  const todo = out.board.columns.find((c) => c.id === 'todo');
  assert.ok(todo && todo.name && todo.order, 'spec column carries name + order');
  await provider.disconnect();
  await harness.close();
});

test('getBoard refuses a board schema_version newer than supported', async () => {
  const { provider, harness } = await connected({ schemaVersion: 2 });
  await assert.rejects(() => provider.getBoard(), (e) => e.code === 'schema_unsupported' && e.meta.found === 2);
  await provider.disconnect();
  await harness.close();
});

test('list → cards + sync_token; includeDeleted surfaces tombstones', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const live = await provider.list({ includeDeleted: false });
  assert.equal(live.cards.length, 1);
  assert.ok(live.sync_token, 'server-minted sync_token returned');

  await provider.delete('c1', { expected_version: live.cards[0].version });
  assert.equal((await provider.list({ includeDeleted: false })).cards.length, 0, 'tombstone hidden by default');
  const withDel = await provider.list({ includeDeleted: true });
  assert.equal(withDel.cards.length, 1);
  assert.ok(withDel.cards[0].deleted_at, 'tombstone carries deleted_at');
  await provider.disconnect();
  await harness.close();
});

test('create/get/update/move round trip; get(missing) → null (LocalProvider parity)', async () => {
  const { provider, harness } = await connected();
  const created = await provider.create({ id: 'x1', title: 'New', column_id: 'todo' });
  assert.equal(created.id, 'x1');
  assert.equal(created.version, 1, 'server mints the version');

  const got = await provider.get('x1');
  assert.equal(got.title, 'New');
  assert.equal(await provider.get('does-not-exist'), null, 'not_found → null, not a throw');

  const updated = await provider.update('x1', { title: 'Renamed' }, { expected_version: created.version });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.version, 2);

  const moved = await provider.move('x1', { column_id: 'doing', order: null }, { expected_version: updated.version });
  assert.equal(moved.column_id, 'doing');
  assert.equal(moved.version, 3);
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* conflict → meta.current (board parity), against BOTH payload shapes */
/* ================================================================== */

test('stale update → code "conflict" carrying the current card under meta.current (structuredContent)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  await assert.rejects(
    () => provider.update('c1', { title: 'x' }, { expected_version: 'STALE' }),
    (e) => e instanceof MCPProviderError && e.code === 'conflict' && e.meta.current.id === 'c1' && e.meta.current.version === 1,
  );
  await provider.disconnect();
  await harness.close();
});

test('text-block payloads: provider reads a board AND remaps a conflict when the server omits structuredContent', async () => {
  // The headline gap: a server that returns only a JSON text content block (no
  // structuredContent). The provider's structured()/errorPayload text fallbacks
  // must still yield the object — proven here, not assumed.
  const { provider, harness } = await connected({ payloadStyle: 'text', seed: oneCard });
  const out = await provider.getBoard();
  assert.ok(out.board.columns.length > 0, 'structured() parsed the text block');
  await assert.rejects(
    () => provider.update('c1', { title: 'x' }, { expected_version: 'STALE' }),
    (e) => e.code === 'conflict' && e.meta.current.id === 'c1',
  );
  await provider.disconnect();
  await harness.close();
});

test('retry_after on a domain error is preserved across the boundary (any code)', async () => {
  const { provider, harness } = await connected({ errorOn: { card_list: { code: 'rate_limited', message: 'slow down', meta: { retry_after: 2000 } } } });
  await assert.rejects(
    () => provider.list(),
    (e) => e.code === 'rate_limited' && e.meta.retry_after === 2000,
  );
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Pass 2b: card write-through (cardUpdate / cardMove / cardDelete)     */
/* ------------------------------------------------------------------- */
/* The board-facing mutation surface, gated on canWrite. Mirrors        */
/* escalationResolve's structure; per spec §Concurrency expected_version */
/* is REQUIRED, and a stale write surfaces code 'conflict' (meta.current)*/
/* through the SAME boundary as update()/move()/delete() above.          */
/* ================================================================== */

test('cardUpdate sends a field-scoped patch + expected_version; returns the projected Card (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const updated = await provider.cardUpdate('c1', { title: 'Renamed', acceptance_criteria: 'ship it', expected_version: 1 });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.acceptance_criteria, 'ship it', 'acceptance_criteria round-trips in the Card');
  assert.equal(updated.version, 2, 'server bumps the version');
  assert.equal(updated.priority, 'med', 'a field NOT in the patch is untouched (field-scoped, no clobber)');
  await provider.disconnect();
  await harness.close();
});

test('cardMove sends column_id + order + expected_version; returns the repositioned Card (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const moved = await provider.cardMove('c1', 'in_progress', { order: 'm', expected_version: 1 });
  assert.equal(moved.column_id, 'in_progress', 'toState maps to the wire column_id');
  assert.equal(moved.order, 'm', 'the client-minted LexoRank is forwarded verbatim');
  assert.equal(moved.version, 2);
  await provider.disconnect();
  await harness.close();
});

test('cardDelete sends expected_version and returns the id, not the tombstone Card (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const result = await provider.cardDelete('c1', { expected_version: 1 });
  assert.equal(result, 'c1', 'returns the id (the board only needs removal confirmation)');
  assert.equal((await provider.list({ includeDeleted: false })).cards.length, 0, 'live list drops the card');
  assert.equal((await provider.list({ includeDeleted: true })).cards.length, 1, 'tombstone retained');
  await provider.disconnect();
  await harness.close();
});

test('card write-through is gated on canWrite: a server missing a card_* tool rejects all three (Pass 2b)', async () => {
  const { provider, harness } = await connected({ omitTools: ['card_move'], seed: oneCard });
  assert.equal(provider.getCapabilities().capabilities.canWrite, false, 'missing card_move ⇒ canWrite false');
  const unsupported = (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability';
  await assert.rejects(() => provider.cardUpdate('c1', { title: 'x', expected_version: 1 }), unsupported);
  await assert.rejects(() => provider.cardMove('c1', 'in_progress', { order: 'm', expected_version: 1 }), unsupported);
  await assert.rejects(() => provider.cardDelete('c1', { expected_version: 1 }), unsupported);
  await provider.disconnect();
  await harness.close();
});

test('a stale card write surfaces code "conflict" with meta.current across all three (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const conflict = (e) => e instanceof MCPProviderError && e.code === 'conflict'
    && e.meta.current.id === 'c1' && e.meta.current.version === 1;
  await assert.rejects(() => provider.cardUpdate('c1', { title: 'x', expected_version: 'STALE' }), conflict);
  await assert.rejects(() => provider.cardMove('c1', 'in_progress', { order: 'm', expected_version: 'STALE' }), conflict);
  await assert.rejects(() => provider.cardDelete('c1', { expected_version: 'STALE' }), conflict);
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Pass 2b refinement: tier read-from-TAGS + write-to-TAGS at the seam  */
/* ------------------------------------------------------------------- */
/* The REAL spine has NO native `card.tier`: tier lives ONLY in `tags`   */
/* as "tier:N" (projection.py). Kanbantt's internal model is the HYPHEN  */
/* "tier-N". The provider is the ONLY translator: WRITE maps hyphen→colon*/
/* (the spine folds it into tags); READ DERIVES the internal tier from   */
/* the card's tags. The harness now MIRRORS the spine — tier in tags, no */
/* native field — so these tests exercise the FULL realistic path and    */
/* FAIL if toInternalCard ever reads a native field instead of tags.     */
/* ================================================================== */

/** Seed a tiered card the way the real spine stores it: tier as a "tier:N" TAG,
 *  with NO native tier field (the field projection.py never emits). */
const tieredCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med', tags: ['tier:2'] });

test('WRITE round-trip: cardUpdate "tier-N" → wire "tier:N" → stored as a tier TAG (no native field) → reads back "tier-N" (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard }); // starts untiered
  const updated = await provider.cardUpdate('c1', { tier: 'tier-3', expected_version: 1 });
  // The returned Card presents the internal hyphen form, DERIVED from its tags.
  assert.equal(updated.tier, 'tier-3', 'returned Card presents internal hyphen tier');
  assert.ok((updated.tags || []).includes('tier:3'), 'the colon tier tag rides in tags');
  // What actually persisted on the spine: a "tier:3" TAG and NO native tier field.
  const stored = harness.store.get('c1');
  assert.ok((stored.tags || []).includes('tier:3'), 'persisted as a "tier:3" tag');
  assert.equal(stored.tier, undefined, 'the spine has NO native tier field (tier rides in tags)');
  // A fresh read over the wire confirms toInternalCard derives "tier-3" from the tag.
  assert.equal((await provider.get('c1')).tier, 'tier-3', 'a fresh read derives tier from the tag');
  await provider.disconnect();
  await harness.close();
});

test('READ derives internal hyphen tier FROM TAGS across get + list; tags/native field untouched (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: tieredCard });
  assert.equal((await provider.get('c1')).tier, 'tier-2', 'get() derives tier-2 from the tier:2 tag');
  const listed = (await provider.list({ includeDeleted: false })).cards.find((c) => c.id === 'c1');
  assert.equal(listed.tier, 'tier-2', 'list() derives tier-2 from the tier:2 tag');
  assert.ok((listed.tags || []).includes('tier:2'), 'tags keep the colon tag (the badge renders off it)');
  // The stored form is untouched: tag stays colon, no native tier field invented.
  const stored = harness.store.get('c1');
  assert.ok((stored.tags || []).includes('tier:2'), 'the stored tag stays colon');
  assert.equal(stored.tier, undefined, 'no native tier field on the spine');
  await provider.disconnect();
  await harness.close();
});

test('untiered (no tier tag) reads back tier null — the value that engages tierLock (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard }); // no tier tag
  assert.equal((await provider.get('c1')).tier, null, 'no tier tag ⇒ internal tier is null');
  const listed = (await provider.list({ includeDeleted: false })).cards.find((c) => c.id === 'c1');
  assert.equal(listed.tier, null, 'list() also presents null for an untiered card');
  await provider.disconnect();
  await harness.close();
});

test('a conflict carries meta.current with tier DERIVED FROM TAGS (snap-back parity, Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: tieredCard });
  await assert.rejects(
    () => provider.cardUpdate('c1', { title: 'x', expected_version: 'STALE' }),
    (e) => e instanceof MCPProviderError && e.code === 'conflict' && e.meta.current.tier === 'tier-2',
  );
  await provider.disconnect();
  await harness.close();
});

test('tier write is conservative: a non-tier update never invents a tier, and a null tier is OMITTED (Pass 2b)', async () => {
  const { provider, harness } = await connected({ seed: oneCard }); // untiered
  // An update that does not touch tier never adds a tier tag — derived tier stays null.
  const renamed = await provider.cardUpdate('c1', { title: 'Renamed', expected_version: 1 });
  assert.equal(renamed.tier, null, 'no tier tag added ⇒ derived tier null');
  assert.ok(!(renamed.tags || []).some((t) => /^tier:/.test(t)), 'no tier tag on the card');
  // A null tier is OMITTED from the wire patch (never sent as tier:null, which the
  // spine's _patch_tier_to_int(None) would reject): it is a no-op, not an untier.
  const nulled = await provider.cardUpdate('c1', { tier: null, expected_version: 2 });
  assert.equal(nulled.tier, null, 'null tier ⇒ still untiered (null omitted, not sent)');
  assert.ok(!(nulled.tags || []).some((t) => /^tier:/.test(t)), 'no tier tag minted from a null tier');
  assert.equal(harness.store.get('c1').tier, undefined, 'no native tier field ever minted');
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Pass 3: card_retier (governed/audited) + card_update write-once tier */
/* ------------------------------------------------------------------- */
/* card_retier changes a SET tier through an audited path: the harness   */
/* writes a tier_audit row (exposed via tierAudit()) with EXACTLY the    */
/* spine's semantics, and card_update REFUSES to change a set tier. The  */
/* tier seam is exercised end to end: internal "tier-N" → wire "tier:N"  */
/* → stored as a tag → read back "tier-N". reduces_control is a JS       */
/* boolean here (the spine records the same fact as int 0/1 — an internal */
/* field that never crosses the wire, so the two never need to agree on   */
/* its encoding, only its truth).                                        */
/* ================================================================== */

/** Connect against a harness seeded with one card carrying `tags` (e.g. ['tier:4']). */
async function retierFixture(tags) {
  return connected({ seed: (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', tags }) });
}

test('cardRetier DOWNGRADE: "tier-4"→wire "tier:4" seam, tag rewritten, audit row reduces_control TRUE (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:4']);
  const card = await provider.cardRetier('c1', 'tier-2', 1, 'tighten review after a near-miss');
  // The returned Card presents the internal hyphen tier, DERIVED from the rewritten tag.
  assert.equal(card.tier, 'tier-2', 'returned Card presents internal hyphen tier');
  assert.ok((card.tags || []).includes('tier:2'), 'the new colon tier tag rides in tags');
  assert.ok(!(card.tags || []).includes('tier:4'), 'the old tier tag was replaced, not duplicated');
  const rows = harness.tierAudit();
  assert.equal(rows.length, 1, 'exactly one audit row recorded');
  assert.deepEqual(
    { card_id: rows[0].card_id, old_tier: rows[0].old_tier, new_tier: rows[0].new_tier,
      reduces_control: rows[0].reduces_control, actor: rows[0].actor, reason: rows[0].reason },
    { card_id: 'c1', old_tier: 4, new_tier: 2, reduces_control: true, actor: 'client:bearer',
      reason: 'tighten review after a near-miss' },
  );
  assert.ok(typeof rows[0].ts === 'string' && rows[0].ts.includes('T'), 'ISO-8601 UTC ts');
  await provider.disconnect();
  await harness.close();
});

test('cardRetier UPGRADE: audit row reduces_control FALSE (a higher tier strengthens oversight) (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:2']);
  const card = await provider.cardRetier('c1', 'tier-4', 1, 'promote to human sign-off');
  assert.equal(card.tier, 'tier-4');
  const row = harness.tierAudit()[0];
  assert.deepEqual([row.old_tier, row.new_tier, row.reduces_control], [2, 4, false]);
  await provider.disconnect();
  await harness.close();
});

test('cardRetier rejects an UNTIERED card → validation_failed, no audit row (Pass 3)', async () => {
  const { provider, harness } = await connected({ seed: oneCard }); // no tier tag
  await assert.rejects(
    () => provider.cardRetier('c1', 'tier-3', 1, 'classify it'),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed',
  );
  assert.equal(harness.tierAudit().length, 0, 'no audit row on rejection');
  await provider.disconnect();
  await harness.close();
});

test('cardRetier rejects an OUT-OF-RANGE tier → validation_failed, no audit row (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:2']);
  await assert.rejects(
    () => provider.cardRetier('c1', 'tier-9', 1, 'too far'),
    (e) => e.code === 'validation_failed',
  );
  assert.equal(harness.tierAudit().length, 0);
  await provider.disconnect();
  await harness.close();
});

test('cardRetier rejects a NO-OP same-tier change → validation_failed, no audit row (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:3']);
  await assert.rejects(
    () => provider.cardRetier('c1', 'tier-3', 1, 'no real change'),
    (e) => e.code === 'validation_failed',
  );
  assert.equal(harness.tierAudit().length, 0, 'a no-op writes NO audit row');
  await provider.disconnect();
  await harness.close();
});

test('cardRetier rejects an EMPTY/whitespace reason → validation_failed, no audit row (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:2']);
  for (const reason of ['', '   ']) {
    await assert.rejects(
      () => provider.cardRetier('c1', 'tier-4', 1, reason),
      (e) => e.code === 'validation_failed',
    );
  }
  assert.equal(harness.tierAudit().length, 0);
  await provider.disconnect();
  await harness.close();
});

test('cardRetier with a STALE expected_version → conflict (meta.current, tier from tags); NO force, no audit row (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:2']);
  // There is no force on cardRetier — a stale version can NEVER be bypassed; it snaps
  // back to meta.current (whose tier is DERIVED from tags, board-parity), and writes
  // no audit row.
  await assert.rejects(
    () => provider.cardRetier('c1', 'tier-4', 'STALE', 'racing write'),
    (e) => e instanceof MCPProviderError && e.code === 'conflict'
      && e.meta.current.id === 'c1' && e.meta.current.tier === 'tier-2',
  );
  assert.equal(harness.tierAudit().length, 0, 'a conflict writes no audit row');
  await provider.disconnect();
  await harness.close();
});

test('canRetier gating: a server without card_retier ⇒ canRetier false and cardRetier is unsupported (Pass 3)', async () => {
  const { provider, harness } = await connected({ omitTools: ['card_retier'], seed: tieredCard });
  assert.equal(provider.getCapabilities().capabilities.canRetier, false, 'no card_retier ⇒ canRetier false');
  await assert.rejects(
    () => provider.cardRetier('c1', 'tier-4', 1, 'nope'),
    (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability',
  );
  await provider.disconnect();
  await harness.close();
});

test('canRetier is INDEPENDENT of canWrite: card_retier present but card_move absent ⇒ canRetier true, canWrite false (Pass 3)', async () => {
  const { provider, harness } = await connected({ omitTools: ['card_move'] });
  const caps = provider.getCapabilities().capabilities;
  assert.equal(caps.canWrite, false, 'missing card_move ⇒ canWrite false');
  assert.equal(caps.canRetier, true, 'card_retier still advertised ⇒ canRetier true');
  await provider.disconnect();
  await harness.close();
});

test('card_update WRITE-ONCE: changing a SET tier via cardUpdate → validation_failed, tier untouched, no audit row (Pass 3)', async () => {
  // THE fidelity guard: card_update must be as strict as the spine. If a set-tier change
  // ever slips through the free update path (instead of being forced onto card_retier),
  // this test FAILS. The board edits tier internally as "tier-4"; cardUpdate maps it to
  // wire "tier:4".
  const { provider, harness } = await retierFixture(['tier:2']);
  await assert.rejects(
    () => provider.cardUpdate('c1', { tier: 'tier-4', expected_version: 1 }),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed' && /write-once/.test(e.message),
  );
  assert.equal((await provider.get('c1')).tier, 'tier-2', 'the set tier was NOT mutated');
  assert.equal(harness.tierAudit().length, 0, 'card_update never writes the audit ledger');
  await provider.disconnect();
  await harness.close();
});

test('card_update RANGE: tier:9 as an INITIAL classification (untiered) → validation_failed, no audit row (Pass 3)', async () => {
  // The 1..4 range is input hygiene: an out-of-range INITIAL tier is rejected before any
  // write, exactly as the spine's `tier must be an int in 1..4` guard fires for an untiered
  // card. Closes the mock/spine divergence where the mock folded any tier:N tag unchecked.
  const { provider, harness } = await connected({ seed: oneCard }); // no tier tag → untiered
  await assert.rejects(
    () => provider.cardUpdate('c1', { tier: 'tier-9', expected_version: 1 }),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed' && /1\.\.4/.test(e.message),
  );
  assert.equal((await provider.get('c1')).tier, null, 'the untiered card was NOT classified');
  assert.equal(harness.tierAudit().length, 0);
  await provider.disconnect();
  await harness.close();
});

test('card_update RANGE beats WRITE-ONCE: tier:9 CHANGE on a set tier → validation_failed with the RANGE message (Pass 3)', async () => {
  // Ordering parity: the spine range-checks BEFORE the write-once guard, so an out-of-range
  // change on a SET tier reports RANGE, not "write-once". expected_version is fresh, so this
  // is NOT a conflict — it isolates the range error specifically.
  const { provider, harness } = await retierFixture(['tier:2']);
  await assert.rejects(
    () => provider.cardUpdate('c1', { tier: 'tier-9', expected_version: 1 }),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed'
      && /1\.\.4/.test(e.message) && !/write-once/.test(e.message),
  );
  assert.equal((await provider.get('c1')).tier, 'tier-2', 'the set tier was NOT mutated');
  assert.equal(harness.tierAudit().length, 0);
  await provider.disconnect();
  await harness.close();
});

test('card_update on a tiered card: a NON-tier edit still succeeds (write-once is tier-scoped) (Pass 3)', async () => {
  const { provider, harness } = await retierFixture(['tier:2']);
  const updated = await provider.cardUpdate('c1', { title: 'Renamed', expected_version: 1 });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.tier, 'tier-2', 'tier preserved (still derived from its untouched tag)');
  assert.equal(harness.tierAudit().length, 0);
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* not-connected guard                                                 */
/* ================================================================== */

test('calls before connect() throw not_connected', async () => {
  const harness = createMcpTestServer();
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  assert.throws(() => provider.getCapabilities(), (e) => e.code === 'not_connected');
  await assert.rejects(() => provider.getBoard(), (e) => e.code === 'not_connected');
  await harness.close();
});

test('createMCPProvider requires a baseUrl', () => {
  assert.throws(() => createMCPProvider({}), (e) => e instanceof MCPProviderError && e.code === 'config');
});

/* ================================================================== */
/* Pass 4: WIRE-LEVEL tier parity with the real spine                  */
/* ------------------------------------------------------------------- */
/* The provider always sends a canonical "tier:N" (or omits a null), so */
/* these drive the mock's tool handlers DIRECTLY (rawWire) with the     */
/* out-of-range / malformed / literal-null wire values the spine itself */
/* classifies, and assert byte-for-byte parity with the empirically-    */
/* observed spine. Spine truth (card seeded tier=2), confirmed against  */
/* spine_server.server over the SDK in-memory client:                   */
/*   card_update patch.tier  →  spine result                            */
/*     "tier:0"  → validation_failed  "tier must be an int in 1..4, got 0"            (RANGE)  */
/*     "tier:9"  → validation_failed  "tier must be an int in 1..4, got 9"            (RANGE)  */
/*     "tier:-1" → validation_failed  "...'tier:N' or an int 1..4, got 'tier:-1'"     (MALFORMED) */
/*     "banana"  → validation_failed  "...'tier:N' or an int 1..4, got 'banana'"      (MALFORMED) */
/*     null      → validation_failed  "...'tier:N' or an int 1..4, got None"          (MALFORMED) */
/*     (no tier key) → leave-as-is                                                              */
/*   card_retier new_tier mirrors this, but range is checked AFTER the gate+untiered  */
/*   (malformed is checked BEFORE the gate, in the tool layer).                        */
/* ================================================================== */

const MALFORMED = "tier must be the tag-id string 'tier:N' or an int 1..4, got ";

test('WIRE card_update tier:0 → validation_failed RANGE message; does NOT silently untier (parity)', async () => {
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard }); // tags ['tier:2'], version 1
  const r = await callRaw('card_update', { id: 'c1', patch: { tier: 'tier:0' }, expected_version: 1 });
  assert.equal(r.isError, true);
  const p = payloadOf(r);
  assert.equal(p.code, 'validation_failed');
  assert.equal(p.message, 'tier must be an int in 1..4, got 0', 'spine RANGE message verbatim');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'tier:0 did NOT strip the tier (no false-green untier)');
  await close();
});

test('WIRE card_update negative "tier:-1" → validation_failed MALFORMED message; no untier (parity)', async () => {
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard });
  const r = await callRaw('card_update', { id: 'c1', patch: { tier: 'tier:-1' }, expected_version: 1 });
  assert.equal(r.isError, true);
  const p = payloadOf(r);
  assert.equal(p.code, 'validation_failed');
  assert.equal(p.message, `${MALFORMED}'tier:-1'`, 'spine _patch_tier_to_int MALFORMED message verbatim');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'negative tier did NOT strip the tier');
  await close();
});

test('WIRE card_update malformed junk "banana" → validation_failed MALFORMED message; no untier (parity)', async () => {
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard });
  const r = await callRaw('card_update', { id: 'c1', patch: { tier: 'banana' }, expected_version: 1 });
  assert.equal(r.isError, true);
  const p = payloadOf(r);
  assert.equal(p.code, 'validation_failed');
  assert.equal(p.message, `${MALFORMED}'banana'`, 'spine MALFORMED message verbatim');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'junk tier did NOT strip the tier');
  await close();
});

test('WIRE card_update literal "tier":null PRESENT → validation_failed (NOT untier) — kills the false-green (parity)', async () => {
  // THE residual: a literal null in the patch. The OLD mock folded null → strip = a SILENT
  // untier (a false-green the real spine never does: _patch_tier_to_int(None) → validation_failed
  // "got None"). The patch.tier KEY is present with value null, so it reaches the parser.
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard });
  const r = await callRaw('card_update', { id: 'c1', patch: { tier: null }, expected_version: 1 });
  assert.equal(r.isError, true);
  const p = payloadOf(r);
  assert.equal(p.code, 'validation_failed');
  assert.equal(p.message, `${MALFORMED}None`, 'spine null → "...got None" verbatim');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'null tier did NOT untier the card');
  await close();
});

test('WIRE card_update tier KEY ABSENT → tier left as-is (a non-tier patch never touches tier) (parity)', async () => {
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard });
  const r = await callRaw('card_update', { id: 'c1', patch: { title: 'Renamed' }, expected_version: 1 });
  assert.equal(r.isError ?? false, false);
  const card = payloadOf(r).card;
  assert.equal(card.title, 'Renamed');
  assert.ok((card.tags || []).includes('tier:2'), 'absent tier key ⇒ tier unchanged');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'));
  await close();
});

test('WIRE card_retier new_tier "tier:0" → validation_failed RANGE message; no audit row, tier unchanged (parity)', async () => {
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard }); // tier:2, version 1
  const r = await callRaw('card_retier', { id: 'c1', new_tier: 'tier:0', expected_version: 1, reason: 'probe' });
  assert.equal(r.isError, true);
  const p = payloadOf(r);
  assert.equal(p.code, 'validation_failed');
  assert.equal(p.message, 'new_tier must be an int in 1..4, got 0', 'retier RANGE message verbatim');
  assert.equal(harness.tierAudit().length, 0, 'a rejected retier writes NO audit row');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'tier unchanged');
  await close();
});

test('WIRE card_retier new_tier null → REJECTED, no audit row, tier unchanged (spine-parity invariant) (parity)', async () => {
  // Parity invariant: a null new_tier is REJECTED (no mutation, no audit row) — exactly what
  // the spine does. ENVELOPE NUANCE: the real spine types new_tier as a REQUIRED string, so it
  // rejects null at FastMCP's schema layer (isError, no domain code/message). The mock's
  // permissive {type:object} schema admits null, so it surfaces a clean validation_failed via
  // the SAME _patch_tier_to_int malformed path. Both reject; the reject-and-don't-audit
  // invariant is what parity requires here.
  const { harness, callRaw, close } = await rawWire({ seed: tieredCard });
  const r = await callRaw('card_retier', { id: 'c1', new_tier: null, expected_version: 1, reason: 'probe' });
  assert.equal(r.isError, true, 'null new_tier is rejected (matches the spine: never applied)');
  assert.equal(harness.tierAudit().length, 0, 'no audit row on the rejected retier');
  assert.ok((harness.store.get('c1').tags || []).includes('tier:2'), 'tier unchanged');
  await close();
});

/* ================================================================== */
/* HARDENING FIX B: classifyFatal — parse-THEN-regex 401 classification */
/* ------------------------------------------------------------------- */
/* The SDK surfaces a rejected token as a THROWN transport error whose  */
/* message wraps the server's JSON body, e.g.                           */
/*   Error POSTing to endpoint: {"error":"unauthorized"}                */
/* classifyFatal extracts + JSON.parses that body and classifies 'auth' */
/* off the STRUCTURED value first, with the raw-message regex as the    */
/* final safety net. A JSON-RPC protocol error (no auth value) → null:  */
/* NOT a connection loss, so the op-level path handles it. Domain       */
/* errors (validation_failed/conflict) are isError results and never    */
/* reach this classifier at all.                                        */
/* ================================================================== */

test('classifyFatal: an HTTP 401 status field ⇒ auth (before any message parsing)', () => {
  assert.equal(classifyFatal(Object.assign(new Error('nope'), { status: 401 })), 'auth', 'e.status');
  assert.equal(classifyFatal(Object.assign(new Error('nope'), { code: 401 })), 'auth', 'e.code');
  assert.equal(classifyFatal({ response: { status: 401 } }), 'auth', 'e.response.status');
});

test('classifyFatal: JSON body {"error":"unauthorized"} in the SDK message ⇒ auth (parsed value)', () => {
  assert.equal(classifyFatal(new Error('Error POSTing to endpoint (HTTP 401): {"error":"unauthorized"}')), 'auth');
});

test('classifyFatal: JSON body {"error":"invalid credentials"} ⇒ auth (parsed value)', () => {
  assert.equal(classifyFatal(new Error('Error POSTing to endpoint: {"error":"invalid credentials"}')), 'auth');
});

test('classifyFatal: JSON body {"error":"token expired"} ⇒ auth (parsed value)', () => {
  assert.equal(classifyFatal(new Error('Error POSTing to endpoint: {"error":"token expired"}')), 'auth');
});

test('classifyFatal: a MALFORMED JSON body carrying "unauthorized" ⇒ auth via the raw-regex net', () => {
  // No closing brace ⇒ the JSON.parse branch is skipped; the final raw-message regex still
  // catches the bare word — the safety net the parse step falls through to.
  assert.equal(classifyFatal(new Error('Error POSTing to endpoint: {"error":"unauthorized"')), 'auth');
  // Braces present but not valid JSON ⇒ JSON.parse throws → same fall-through to the net.
  assert.equal(classifyFatal(new Error('boom {error: unauthorized, code: 401}')), 'auth');
});

test('classifyFatal: connection-refused / TypeError ⇒ unreachable (no auth false-positive)', () => {
  assert.equal(classifyFatal(new Error('connect ECONNREFUSED 127.0.0.1:8787')), 'unreachable');
  assert.equal(classifyFatal(new TypeError('Failed to fetch')), 'unreachable');
});

test('classifyFatal: a JSON-RPC protocol error ⇒ null (NOT a connection loss)', () => {
  // A structured body whose value is NOT auth semantics must fall through to null — the
  // connection stays up and the op-level path handles the protocol error.
  assert.equal(classifyFatal(new Error('MCP error -32601: {"code":-32601,"message":"Method not found"}')), null);
  // An object-valued `error` (the nested JSON-RPC shape) must not false-positive to auth either.
  assert.equal(classifyFatal(new Error('rpc failed: {"error":{"code":-32600,"message":"Invalid Request"}}')), null);
});

/* ================================================================== */
/* Pass 2: effort/impact write-through + local/MCP parity             */
/* ------------------------------------------------------------------- */
/* effort and impact are plain ungoverned fields — no wire remap, no   */
/* write-once gate. cardUpdate forwards them verbatim; the same store  */
/* backs the harness and the LocalProvider (spec Parity Contract).     */
/* ================================================================== */

test('cardUpdate with effort/impact: round-trips both fields; version bumps; no stray field clobbered', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const updated = await provider.cardUpdate('c1', { effort: 'low', impact: 'high', expected_version: 1 });
  assert.equal(updated.effort, 'low', 'effort round-trips');
  assert.equal(updated.impact, 'high', 'impact round-trips');
  assert.equal(updated.version, 2, 'version bumped');
  assert.equal(updated.title, 'First', 'title untouched — patch is field-scoped');
  assert.equal(updated.priority, 'med', 'priority untouched');
  await provider.disconnect();
  await harness.close();
});

test('cardUpdate patch with only effort/impact: no title change; stray-free (MCP/Local parity)', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  // First write: classify
  await provider.cardUpdate('c1', { effort: 'high', impact: 'low', expected_version: 1 });
  // Second write: reclassify via drag (same call shape classifyTaskMcp uses)
  const reclassified = await provider.cardUpdate('c1', { effort: 'low', impact: 'high', expected_version: 2 });
  assert.equal(reclassified.effort, 'low', 'effort updated');
  assert.equal(reclassified.impact, 'high', 'impact updated');
  assert.equal(reclassified.title, 'First', 'title unchanged — stray-free patch');
  assert.equal(reclassified.version, 3);
  await provider.disconnect();
  await harness.close();
});

test('cardUpdate effort/impact null: explicit null round-trips (unset sentinel); version bumps', async () => {
  const { provider, harness } = await connected({ seed: (s) => s.create({
    id: 'c1', title: 'First', column_id: 'todo', priority: 'med', effort: 'high', impact: 'low',
  }) });
  const updated = await provider.cardUpdate('c1', { effort: null, impact: null, expected_version: 1 });
  assert.equal(updated.effort, null, 'effort null stored');
  assert.equal(updated.impact, null, 'impact null stored');
  assert.equal(updated.version, 2);
  await provider.disconnect();
  await harness.close();
});

/* ================================================================== */
/* Project targeting + cardCreate (spec v0.6.0) — the board-create     */
/* slice: project_list feeds the picker; card_create lands the intake. */
/* ================================================================== */

const TWO_PROJECTS = [
  { id: 'p2', name: 'Dispatch Log', created_at: '2026-02-01T00:00:00Z' },
  { id: 'p1', name: 'Claunker First Light', created_at: '2026-01-01T00:00:00Z' },
  { id: 'p3', name: 'Retired', created_at: '2026-03-01T00:00:00Z', deleted_at: '2026-04-01T00:00:00Z' },
];

test('projectList: live projects only, server (created_at, id) order preserved, gated on canTargetProjects', async () => {
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  assert.equal(provider.getCapabilities().capabilities.canTargetProjects, true);
  const projects = await provider.projectList();
  // The tombstoned fixture entry is omitted; the harness serves (created_at, id)
  // ascending and the provider preserves that order verbatim (never re-sorts).
  assert.deepEqual(projects, [
    { id: 'p1', name: 'Claunker First Light', created_at: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Dispatch Log', created_at: '2026-02-01T00:00:00Z' },
  ]);
  await provider.disconnect();
  await harness.close();
});

test('projectList is unsupported when project_list is not advertised (canTargetProjects false)', async () => {
  const { provider, harness } = await connected({ omitTools: ['project_list'] });
  assert.equal(provider.getCapabilities().capabilities.canTargetProjects, false);
  await assert.rejects(() => provider.projectList(), (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability');
  await provider.disconnect();
  await harness.close();
});

test('cardCreate targets a project and adopts the returned card wholesale (canonical, untiered intake)', async () => {
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  const card = await provider.cardCreate(
    { id: 'n1', title: 'Board intake', column_id: 'todo', order: 'm' },
    { project_id: 'p1' },
  );
  // Canonical adoption (spec §Create): the returned card IS the state — client id
  // honored, server-minted version present, and NO tier (human intake is untiered;
  // toInternalCard derives tier:null from the tag-free card).
  assert.equal(card.id, 'n1');
  assert.equal(card.title, 'Board intake');
  assert.ok(card.version != null, 'server-minted version adopted');
  assert.equal(card.tier, null, 'untiered — no tier derived from tags');
  assert.deepEqual(card.tags, [], 'no tier tag on an intake card');
  // The harness recorded which project the create landed in (Task.project_id
  // never rides the Card lens — this is the test-side observability).
  assert.equal(harness.createdProjects().get('n1'), 'p1');
  await provider.disconnect();
  await harness.close();
});

test('cardCreate without project_id on a project-aware spine: validation_failed naming project_list', async () => {
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  await assert.rejects(
    () => provider.cardCreate({ title: 'untargeted' }),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed' && /project_list/.test(e.message),
  );
  await provider.disconnect();
  await harness.close();
});

test('cardCreate against an unknown or tombstoned project is not_found', async () => {
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  await assert.rejects(
    () => provider.cardCreate({ title: 'orphan' }, { project_id: 'ghost' }),
    (e) => e instanceof MCPProviderError && e.code === 'not_found',
  );
  await assert.rejects(
    () => provider.cardCreate({ title: 'orphan' }, { project_id: 'p3' }), // tombstoned
    (e) => e instanceof MCPProviderError && e.code === 'not_found',
  );
  await provider.disconnect();
  await harness.close();
});

test('cardCreate duplicate id is idempotent and runs BEFORE the targeting requirement', async () => {
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  harness.store.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med' });
  // A retry replaying a landed id returns the EXISTING card as success even with NO
  // project_id — the spine's order (idempotency precedes targeting validation).
  const card = await provider.cardCreate({ id: 'c1', title: 'totally different' });
  assert.equal(card.title, 'First', 'existing card returned untouched');
  await provider.disconnect();
  await harness.close();
});

test('cardCreate on a projectless conforming server needs no project_id', async () => {
  const { provider, harness } = await connected(); // no projects fixture — the generic server
  assert.equal(provider.getCapabilities().capabilities.canTargetProjects, true, 'the full harness still advertises project_list');
  const card = await provider.cardCreate({ id: 'n2', title: 'Generic create', column_id: 'todo', order: 'm' });
  assert.equal(card.id, 'n2');
  await provider.disconnect();
  await harness.close();
});

test('cardCreate maps an internal hyphen tier to the wire colon form (non-board callers)', async () => {
  // The board never sends a tier on create (human intake) — but the provider seam
  // stays uniform: an internal "tier-N" crossing this boundary rides as "tier:N",
  // and the returned card re-projects to internal (tier derived from its tag).
  const { provider, harness } = await connected({ projects: TWO_PROJECTS });
  const card = await provider.cardCreate(
    { id: 'n3', title: 'Pre-tiered', column_id: 'todo', order: 'm', tier: 'tier-2' },
    { project_id: 'p2' },
  );
  assert.deepEqual(card.tags, ['tier:2'], 'tier folded into tags on the wire');
  assert.equal(card.tier, 'tier-2', 'internal tier derived back from the tag');
  await provider.disconnect();
  await harness.close();
});

test('cardCreate is unsupported when the card_* write set is incomplete (canWrite false)', async () => {
  const { provider, harness } = await connected({ omitTools: ['card_create'] });
  assert.equal(provider.getCapabilities().capabilities.canWrite, false);
  await assert.rejects(() => provider.cardCreate({ title: 'x' }), (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability');
  await provider.disconnect();
  await harness.close();
});
