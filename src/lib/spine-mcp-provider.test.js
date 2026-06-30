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

import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider, MCPProviderError } from './spine-mcp-provider.js';

/** Connect a provider to a fresh harness; returns { provider, harness }. */
async function connected(opts = {}) {
  const harness = createMcpTestServer(opts);
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  await provider.connect();
  return { provider, harness };
}
const oneCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med' });

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
