/**
 * Uniform conflict snap-back tests — spine-snapback.js, the ONE reconciliation
 * core the MCP move/delete failure paths share.
 *
 * Two layers, in the house styles:
 *   - PURE tests of failureTruth/snapBackCards over hand-built model arrays
 *     (both op shapes: entry-present = move, entry-absent = delete), covering
 *     the three truth classes plus the version guard and the poll races.
 *   - PROVIDER-DRIVEN tests: the REAL MCPProvider against the conforming
 *     in-process harness (spine-mcp-test-server.js), proving the classes AS
 *     THROWN by the provider (conflict meta.card → meta.current remap included)
 *     feed snapBackCards to convergence with the server's own store.
 *
 * Run:  node --test src/lib/spine-snapback.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapBackCards, failureTruth } from './spine-snapback.js';
import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider, MCPProviderError } from './spine-mcp-provider.js';

/** Connect a provider to a fresh harness; returns { provider, harness }. */
async function connected(opts = {}) {
  const harness = createMcpTestServer(opts);
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn });
  await provider.connect();
  return { provider, harness };
}

/* Error builders — the provider's post-remap shapes (mapDomainError output). */
const conflictLive = (current) => Object.assign(new Error('version conflict'), { code: 'conflict', meta: { current } });
const conflictGone = (current) => conflictLive({ deleted_at: '2026-07-01T00:00:00.000Z', ...current });
const notFound = (id) => Object.assign(new Error(`no card ${id}`), { code: 'not_found', meta: { id } });
const transport = () => Object.assign(new Error('Failed to fetch'), { code: 'transport' });

/** A model card with client-side composition (the poll-attached badge). */
const card = (id, over = {}) => ({
  id, title: `T-${id}`, column_id: 'todo', order: 'm', version: 'v1', tags: [],
  badge: { kind: 'escalation', id: `esc-${id}`, reason: 'probe' },
  ...over,
});

/* ================================================================== */
/* failureTruth — the three-way classification                         */
/* ================================================================== */

test('failureTruth: conflict + live meta.current ⇒ stale', () => {
  assert.equal(failureTruth(conflictLive(card('c1', { version: 'v2' }))), 'stale');
});

test('failureTruth: conflict + tombstoned meta.current ⇒ gone', () => {
  assert.equal(failureTruth(conflictGone({ id: 'c1' })), 'gone');
});

test('failureTruth: not_found ⇒ gone', () => {
  assert.equal(failureTruth(notFound('c1')), 'gone');
});

test('failureTruth: transport / no-current conflict / anything else ⇒ unknown', () => {
  assert.equal(failureTruth(transport()), 'unknown');
  assert.equal(failureTruth(Object.assign(new Error('conflict'), { code: 'conflict', meta: {} })), 'unknown', 'a conflict WITHOUT meta.current proves nothing');
  assert.equal(failureTruth(Object.assign(new Error('rate'), { code: 'rate_limited' })), 'unknown');
  assert.equal(failureTruth(undefined), 'unknown');
});

/* ================================================================== */
/* snapBackCards — MOVE shape (entry present after the optimistic apply) */
/* ================================================================== */

test('move/stale: adopts meta.current by MERGE — server fields land, client-side badge survives', () => {
  const prior = card('c1');
  const optimistic = { ...prior, column_id: 'doing', order: 'x' }; // the optimistic apply
  const fresh = { id: 'c1', column_id: 'done', order: 'q', version: 'v2' }; // the server's truth
  const out = snapBackCards([optimistic, card('c2')], { id: 'c1', error: conflictLive(fresh), prior });
  const c1 = out.find((c) => c.id === 'c1');
  assert.equal(c1.column_id, 'done', 'server column adopted (NOT the captured prior)');
  assert.equal(c1.version, 'v2', 'fresh version adopted — the next write retries against it');
  assert.deepEqual(c1.badge, prior.badge, 'the poll-composed badge survives the merge');
  assert.ok(out.some((c) => c.id === 'c2'), 'other cards untouched');
});

test('move/gone (tombstoned meta.current): the entry is REMOVED — never a tombstone-spread the polls would not produce', () => {
  const prior = card('c1');
  const out = snapBackCards([{ ...prior, column_id: 'doing' }, card('c2')], { id: 'c1', error: conflictGone({ id: 'c1', version: 'v2' }), prior });
  assert.equal(out.some((c) => c.id === 'c1'), false, 'card dropped from the model');
  assert.equal(out.length, 1);
});

test('move/gone (not_found): the entry is REMOVED — no ghost restore for a card the server does not know', () => {
  const prior = card('c1');
  const out = snapBackCards([{ ...prior, column_id: 'doing' }], { id: 'c1', error: notFound('c1'), prior });
  assert.deepEqual(out, [], 'ghost dropped');
});

test('move/unknown: restores the captured prior (position AND all fields) when the version has not moved', () => {
  const prior = card('c1');
  const out = snapBackCards([{ ...prior, column_id: 'doing', order: 'x' }], { id: 'c1', error: transport(), prior });
  assert.deepEqual(out, [prior], 'full prior restored — the write never landed');
});

test('move/unknown VERSION GUARD: a mid-flight poll refreshed the entry (version moved) ⇒ left standing', () => {
  const prior = card('c1'); // version v1
  const polled = card('c1', { column_id: 'done', order: 'z', version: 'v3' }); // fresher truth
  const out = snapBackCards([polled], { id: 'c1', error: transport(), prior });
  assert.deepEqual(out, [polled], 'prior restore must never stomp a poll-delivered newer card');
});

/* ================================================================== */
/* snapBackCards — DELETE shape (entry absent after the optimistic apply) */
/* ================================================================== */

test('delete/stale: re-inserts the server\'s fresh card MERGED over the captured prior (badge survives)', () => {
  const prior = card('c1');
  const fresh = { id: 'c1', title: 'Renamed on spine', version: 'v2' };
  const out = snapBackCards([card('c2')], { id: 'c1', error: conflictLive(fresh), prior });
  const c1 = out.find((c) => c.id === 'c1');
  assert.equal(c1.title, 'Renamed on spine', 'server truth wins the merge');
  assert.equal(c1.version, 'v2');
  assert.equal(c1.column_id, prior.column_id, 'prior fills what the wire card omits');
  assert.deepEqual(c1.badge, prior.badge, 'client-side badge preserved from the prior');
});

test('delete/stale POLL RACE: the poll already re-added it ⇒ merge onto the polled entry, no duplicate', () => {
  const prior = card('c1');
  const polled = card('c1', { version: 'v2' });
  const fresh = { id: 'c1', version: 'v2', title: 'Fresh' };
  const out = snapBackCards([polled], { id: 'c1', error: conflictLive(fresh), prior });
  assert.equal(out.filter((c) => c.id === 'c1').length, 1, 'never a double insert');
  assert.equal(out[0].title, 'Fresh');
});

test('delete/gone (tombstoned meta.current): stays removed — the delete effectively already succeeded', () => {
  const prior = card('c1');
  const out = snapBackCards([card('c2')], { id: 'c1', error: conflictGone({ id: 'c1' }), prior });
  assert.equal(out.some((c) => c.id === 'c1'), false, 'never resurrected');
});

test('delete/gone (not_found): stays removed — the card is gone, which IS the intent', () => {
  const prior = card('c1');
  const out = snapBackCards([], { id: 'c1', error: notFound('c1'), prior });
  assert.deepEqual(out, [], 'no ghost resurrection');
});

test('delete/unknown: restores the captured prior card (the optimistic removal is undone)', () => {
  const prior = card('c1');
  const out = snapBackCards([card('c2')], { id: 'c1', error: transport(), prior });
  assert.deepEqual(out.find((c) => c.id === 'c1'), prior, 'prior re-inserted intact');
});

test('delete/unknown POLL RACE: the poll re-added it with a NEWER version ⇒ left standing (no stale stomp)', () => {
  const prior = card('c1'); // v1
  const polled = card('c1', { version: 'v4', title: 'Poll truth' });
  const out = snapBackCards([polled], { id: 'c1', error: transport(), prior });
  assert.deepEqual(out, [polled]);
});

/* ================================================================== */
/* PROVIDER-DRIVEN: the classes as the REAL provider throws them       */
/* (harness store = the server's truth; snapBackCards must converge    */
/* the model to it in every class)                                     */
/* ================================================================== */

const seedCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med' });

test('provider move/stale: stale expected_version ⇒ conflict meta.current; snap-back adopts the server card', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const stale = (await provider.list({ includeDeleted: false })).cards.find((c) => c.id === 'c1');
  harness.store.update('c1', { title: 'Server renamed' }, { expected_version: stale.version }); // another client wins
  const model = [{ ...stale, column_id: 'doing' }]; // our optimistic move, now doomed
  try {
    await provider.cardMove('c1', 'doing', { order: 'x', expected_version: stale.version });
    assert.fail('stale move must conflict');
  } catch (e) {
    assert.ok(e instanceof MCPProviderError && e.code === 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(model, { id: 'c1', error: e, prior: stale });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.title, 'Server renamed', 'model converged to the server card');
    assert.equal(c1.version, harness.store.get('c1').version, 'fresh version adopted');
    assert.equal(c1.column_id, harness.store.get('c1').column_id, 'server position, not our optimistic one');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider move/gone: target tombstoned server-side ⇒ conflict + deleted_at; snap-back drops the card', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const cur = harness.store.get('c1');
  harness.store.delete('c1', { expected_version: cur.version }); // deleted under our feet
  const model = [{ ...cur, column_id: 'doing' }];
  try {
    await provider.cardMove('c1', 'doing', { order: 'x', expected_version: cur.version });
    assert.fail('moving a tombstoned card must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.ok(e.meta.current.deleted_at, 'meta.current carries the tombstone');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(model, { id: 'c1', error: e, prior: cur });
    assert.deepEqual(out, [], 'model converged: the card is gone, not tombstone-spread');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider move/gone: unknown id ⇒ not_found; snap-back drops the ghost', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const ghost = { id: 'ghost', title: 'Ghost', column_id: 'todo', order: 'm', version: 'v0' };
  try {
    await provider.cardMove('ghost', 'doing', { order: 'x', expected_version: 'v0' });
    assert.fail('moving an unknown card must not_found');
  } catch (e) {
    assert.equal(e.code, 'not_found');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards([ghost], { id: 'ghost', error: e, prior: ghost });
    assert.deepEqual(out, [], 'the ghost is dropped — a restore would strand an unwritable card');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider delete/stale: stale expected_version ⇒ conflict live; snap-back re-inserts the SERVER card', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const stale = harness.store.get('c1');
  harness.store.update('c1', { title: 'Moved on' }, { expected_version: stale.version });
  const model = []; // our optimistic removal
  try {
    await provider.cardDelete('c1', { expected_version: stale.version });
    assert.fail('stale delete must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(model, { id: 'c1', error: e, prior: stale });
    const c1 = out.find((c) => c.id === 'c1');
    assert.ok(c1, 're-inserted: the card still lives server-side');
    assert.equal(c1.title, 'Moved on', 'with the SERVER state, not our stale capture');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider delete/gone: already tombstoned ⇒ conflict + deleted_at; snap-back leaves it removed', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const cur = harness.store.get('c1');
  harness.store.delete('c1', { expected_version: cur.version }); // someone else deleted it first
  try {
    await provider.cardDelete('c1', { expected_version: cur.version });
    assert.fail('deleting a tombstone must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'gone');
    assert.deepEqual(snapBackCards([], { id: 'c1', error: e, prior: cur }), [], 'stays removed — never resurrected');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider delete/gone: unknown id ⇒ not_found; snap-back leaves it removed (no ghost resurrection)', async () => {
  const { provider, harness } = await connected({ seed: seedCard });
  const ghost = { id: 'ghost', title: 'Ghost', column_id: 'todo', order: 'm', version: 'v0' };
  try {
    await provider.cardDelete('ghost', { expected_version: 'v0' });
    assert.fail('deleting an unknown card must not_found');
  } catch (e) {
    assert.equal(e.code, 'not_found');
    assert.equal(failureTruth(e), 'gone');
    assert.deepEqual(snapBackCards([], { id: 'ghost', error: e, prior: ghost }), [], 'stays removed');
  }
  await provider.disconnect();
  await harness.close();
});

test('provider unknown: an in-band NON-conflict domain error (rate_limited) reverts to prior on both ops', async () => {
  const { provider, harness } = await connected({
    seed: seedCard,
    errorOn: { card_move: { code: 'rate_limited', message: 'slow down', meta: { retry_after: 1 } } },
  });
  const cur = harness.store.get('c1');
  const model = [{ ...cur, column_id: 'doing' }]; // optimistic move
  try {
    await provider.cardMove('c1', 'doing', { order: 'x', expected_version: cur.version });
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(e.code, 'rate_limited');
    assert.equal(failureTruth(e), 'unknown', 'no truth proven — the write may simply retry later');
    const out = snapBackCards(model, { id: 'c1', error: e, prior: cur });
    assert.deepEqual(out, [cur], 'restored to the captured prior');
  }
  await provider.disconnect();
  await harness.close();
});
