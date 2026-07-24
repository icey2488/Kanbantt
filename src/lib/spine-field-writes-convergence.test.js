/**
 * Field-write mutation convergence — save/update, retier, and archive extend the
 * SAME uniform snap-back core (spine-snapback.js) that move/delete already ride
 * (see spine-snapback.test.js). This proves the three field-write paths feed
 * failureTruth/snapBackCards to convergence exactly like the structural writes,
 * using the real MCPProvider against the in-process harness so the shapes are
 * PROVEN as thrown (conflict meta.current normalization, tombstone gating, the
 * governed paths' no-force contract) — not hand-built fixtures.
 *
 * Notice wording (App.jsx's mutationNotice/writeError) is UI copy with no
 * independent test seam — App.jsx is JSX and untestable under plain `node --test`
 * (no transform configured), matching the pre-existing convention that writeError()
 * itself carries zero unit coverage. What's proven here is the data-layer contract
 * that copy reads off: failureTruth's three-way classification and the resulting
 * model convergence, plus the R5 no-force/no-auto-retry guarantee at the wire.
 *
 * Run:  node --test src/lib/spine-field-writes-convergence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapBackCards, failureTruth } from './spine-snapback.js';
import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider } from './spine-mcp-provider.js';

/** Connect a provider to a fresh harness, with a fetchFn SPY that records every
 *  tools/call request (name + arguments) — the seam for the R5 force/no-retry
 *  assertions. Returns { provider, harness, calls }. */
async function connectedSpy(opts = {}) {
  const harness = createMcpTestServer(opts);
  const calls = [];
  const fetchFn = async (url, init) => {
    if (init?.body) {
      try {
        const body = JSON.parse(init.body);
        if (body?.method === 'tools/call') calls.push({ name: body.params.name, arguments: body.params.arguments });
      } catch { /* not a JSON-RPC tools/call body (e.g. GET) */ }
    }
    return harness.fetchFn(url, init);
  };
  const provider = createMCPProvider({ baseUrl: harness.url, fetchFn });
  await provider.connect();
  return { provider, harness, calls };
}

const oneCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med' });
const tieredCard = (s) => s.create({ id: 'c1', title: 'First', column_id: 'todo', priority: 'med', tags: ['tier:2'] });

/* ================================================================== */
/* SAVE/UPDATE (card_update)                                           */
/* ================================================================== */

test('save/stale: conflict+live adopts the SERVER card, never the captured prior (red-contrast)', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const stale = await provider.get('c1');
  harness.store.update('c1', { title: 'Renamed by someone else' }, { expected_version: stale.version }); // another client wins
  const prior = { ...stale };
  const optimisticModel = [{ ...stale, title: 'My edit' }]; // our optimistic apply
  try {
    await provider.cardUpdate('c1', { title: 'My edit', expected_version: stale.version });
    assert.fail('stale save must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.title, 'Renamed by someone else', 'server truth wins');
    assert.notEqual(c1.title, 'My edit', 'our optimistic title never survives a conflict');
    assert.notEqual(c1.title, prior.title, 'the captured prior is NOT restored over server truth');
    assert.equal(c1.version, harness.store.get('c1').version, 'fresh version adopted for the next retry');
  }
  await provider.disconnect(); await harness.close();
});

test('save/gone: conflict+tombstoned target leaves active model, no ghost restore', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.delete('c1', { expected_version: cur.version }); // deleted under our feet
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, title: 'My edit' }];
  try {
    await provider.cardUpdate('c1', { title: 'My edit', expected_version: cur.version });
    assert.fail('updating a tombstoned card must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.ok(e.meta.current.deleted_at, 'meta.current carries the tombstone');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.equal(out.some((c) => c.id === 'c1'), false, 'card removed from active state, not tombstone-spread');
  }
  await provider.disconnect(); await harness.close();
});

test('save/unknown: a non-conflict domain error restores the FULL captured prior', async () => {
  const { provider, harness } = await connectedSpy({
    seed: oneCard,
    errorOn: { card_update: { code: 'rate_limited', message: 'slow down' } },
  });
  const cur = await provider.get('c1');
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, title: 'My edit' }];
  try {
    await provider.cardUpdate('c1', { title: 'My edit', expected_version: cur.version });
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(failureTruth(e), 'unknown', 'no server truth proven — the write never landed');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.deepEqual(out, [prior], 'reverted to the full captured prior, not a partial-field patch');
  }
  await provider.disconnect(); await harness.close();
});

test('save: never sends force, never auto-retries a conflict (asserted by absence)', async () => {
  const { provider, harness, calls } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.update('c1', { title: 'Someone else' }, { expected_version: cur.version });
  await assert.rejects(() => provider.cardUpdate('c1', { title: 'Mine', expected_version: cur.version }));
  const updateCalls = calls.filter((c) => c.name === 'card_update');
  assert.equal(updateCalls.length, 1, 'exactly one attempt — no auto-retry on conflict');
  assert.equal('force' in updateCalls[0].arguments, false, 'force never sent');
  await provider.disconnect(); await harness.close();
});

/* ================================================================== */
/* RETIER (card_retier)                                                */
/* ================================================================== */

test('retier/stale: conflict+live adopts the SERVER tier + version, never the captured prior', async () => {
  const { provider, harness } = await connectedSpy({ seed: tieredCard });
  const stale = await provider.get('c1');
  harness.store.update('c1', { tags: ['tier:3'] }, { expected_version: stale.version }); // someone re-tiers first
  const prior = { ...stale };
  const optimisticModel = [{ ...stale, tier: 'tier-1' }];
  try {
    await provider.cardRetier('c1', 'tier-1', stale.version, 'demote after review');
    assert.fail('stale retier must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.tier, 'tier-3', 'server tier wins');
    assert.notEqual(c1.tier, 'tier-1', 'our optimistic tier never survives a conflict');
    assert.notEqual(c1.tier, prior.tier, 'the captured prior tier is NOT restored over server truth');
  }
  await provider.disconnect(); await harness.close();
});

test('retier/gone: conflict+tombstoned target leaves active model', async () => {
  const { provider, harness } = await connectedSpy({ seed: tieredCard });
  const cur = await provider.get('c1');
  harness.store.delete('c1', { expected_version: cur.version });
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, tier: 'tier-1' }];
  try {
    await provider.cardRetier('c1', 'tier-1', cur.version, 'demote after review');
    assert.fail('retiering a tombstoned card must conflict');
  } catch (e) {
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.equal(out.some((c) => c.id === 'c1'), false, 'card removed, not resurrected');
  }
  await provider.disconnect(); await harness.close();
});

test('retier/unknown: a non-conflict domain error restores the full captured prior', async () => {
  const { provider, harness } = await connectedSpy({
    seed: tieredCard,
    errorOn: { card_retier: { code: 'rate_limited', message: 'slow down' } },
  });
  const cur = await provider.get('c1');
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, tier: 'tier-1' }];
  try {
    await provider.cardRetier('c1', 'tier-1', cur.version, 'demote after review');
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(failureTruth(e), 'unknown');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.deepEqual(out, [prior]);
  }
  await provider.disconnect(); await harness.close();
});

test('retier: never sends force (the tool has no force param at all), never auto-retries', async () => {
  const { provider, harness, calls } = await connectedSpy({ seed: tieredCard });
  const cur = await provider.get('c1');
  harness.store.update('c1', { tags: ['tier:3'] }, { expected_version: cur.version });
  await assert.rejects(() => provider.cardRetier('c1', 'tier-1', cur.version, 'demote after review'));
  const retierCalls = calls.filter((c) => c.name === 'card_retier');
  assert.equal(retierCalls.length, 1, 'exactly one attempt — no auto-retry on conflict');
  assert.equal('force' in retierCalls[0].arguments, false, 'force never sent');
  await provider.disconnect(); await harness.close();
});

/* ================================================================== */
/* ARCHIVE (card_archive)                                               */
/* ================================================================== */

test('archive/stale: conflict+live adopts the SERVER card, never the captured prior', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  // Cycle archive→unarchive once so archived_at is an EXPLICIT null on the wire (the
  // store only stamps the field once touched — a fresh-created card omits the key
  // entirely, which is a test-harness fidelity gap, not a real Card shape).
  const seeded = await provider.get('c1');
  const archivedOnce = await provider.cardArchive('c1', seeded.version);
  await provider.cardUnarchive('c1', archivedOnce.version);
  const stale = await provider.get('c1');
  harness.store.update('c1', { title: 'Renamed first' }, { expected_version: stale.version }); // someone edits first
  const prior = { ...stale };
  const optimisticModel = [{ ...stale, archived_at: '2026-07-24T00:00:00.000Z' }];
  try {
    await provider.cardArchive('c1', stale.version);
    assert.fail('stale archive must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.title, 'Renamed first', 'server truth wins');
    assert.equal(c1.archived_at ?? null, null, 'the server never archived — our optimistic stamp is gone');
    assert.notEqual(c1.title, prior.title, 'the captured prior is NOT restored over server truth');
  }
  await provider.disconnect(); await harness.close();
});

test('archive/gone: conflict+tombstoned target leaves active model (the FLAGGED archive-on-tombstone case)', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.delete('c1', { expected_version: cur.version }); // deleted under our feet
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, archived_at: '2026-07-24T00:00:00.000Z' }];
  try {
    await provider.cardArchive('c1', cur.version);
    assert.fail('archiving a tombstoned card must conflict');
  } catch (e) {
    assert.ok(e.meta.current.deleted_at, 'meta.current carries the tombstone');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.equal(out.some((c) => c.id === 'c1'), false, 'card removed, never resurrected as a live archived card');
  }
  await provider.disconnect(); await harness.close();
});

test('archive/unknown: a non-conflict domain error restores the full captured prior', async () => {
  const { provider, harness } = await connectedSpy({
    seed: oneCard,
    errorOn: { card_archive: { code: 'rate_limited', message: 'slow down' } },
  });
  const cur = await provider.get('c1');
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, archived_at: '2026-07-24T00:00:00.000Z' }];
  try {
    await provider.cardArchive('c1', cur.version);
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(failureTruth(e), 'unknown');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.deepEqual(out, [prior], 'archived_at reverts along with everything else — the full prior wins');
  }
  await provider.disconnect(); await harness.close();
});

test('archive: never sends force (the tool has no force param at all), never auto-retries', async () => {
  const { provider, harness, calls } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.update('c1', { title: 'Someone else' }, { expected_version: cur.version });
  await assert.rejects(() => provider.cardArchive('c1', cur.version));
  const archiveCalls = calls.filter((c) => c.name === 'card_archive');
  assert.equal(archiveCalls.length, 1, 'exactly one attempt — no auto-retry on conflict');
  assert.equal('force' in archiveCalls[0].arguments, false, 'force never sent');
  await provider.disconnect(); await harness.close();
});
