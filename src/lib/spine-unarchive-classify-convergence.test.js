/**
 * Extends the field-write mutation convergence proof (see
 * spine-field-writes-convergence.test.js, and spine-snapback.test.js for the core
 * itself) to the two handlers left out of that job's scope: unarchiveTaskMcp
 * (card_unarchive) and classifyTaskMcp (card_update, effort/impact patch).
 *
 * Same rationale as the sibling file: App.jsx is JSX and untestable under plain
 * `node --test` (no transform configured), so notice wording (mutationNotice) has
 * no independent test seam. What's proven here is the data-layer contract App.jsx's
 * handlers now feed into — failureTruth's three-way classification, snapBackCards'
 * convergence, and the R5 no-force/no-auto-retry guarantee at the wire — against the
 * real MCPProvider over the in-process harness, exactly like the three already-
 * converged handlers.
 *
 * Run:  node --test src/lib/spine-unarchive-classify-convergence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapBackCards, failureTruth } from './spine-snapback.js';
import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider } from './spine-mcp-provider.js';

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

/* ================================================================== */
/* UNARCHIVE (card_unarchive)                                          */
/* ================================================================== */

test('unarchive/stale: conflict+live adopts the SERVER card, never the captured prior (red-contrast)', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const seeded = await provider.get('c1');
  const archived = await provider.cardArchive('c1', seeded.version); // must be archived to unarchive
  harness.store.update('c1', { title: 'Renamed by someone else' }, { expected_version: archived.version }); // races us
  const stale = harness.store.get('c1');
  const prior = { ...archived };
  const optimisticModel = [{ ...archived, archived_at: null }]; // our optimistic apply
  try {
    await provider.cardUnarchive('c1', archived.version);
    assert.fail('stale unarchive must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.title, 'Renamed by someone else', 'server truth wins');
    assert.notEqual(c1.title, prior.title, 'the captured prior is NOT restored over server truth');
    assert.ok(c1.archived_at, 'the server never unarchived — our optimistic clear is gone');
    assert.equal(c1.version, stale.version, 'fresh version adopted for the next retry');
  }
  await provider.disconnect(); await harness.close();
});

test('unarchive/gone: conflict+tombstoned target leaves active model, no ghost restore', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const seeded = await provider.get('c1');
  const archived = await provider.cardArchive('c1', seeded.version);
  harness.store.delete('c1', { expected_version: archived.version }); // deleted under our feet
  const prior = { ...archived };
  const optimisticModel = [{ ...archived, archived_at: null }];
  try {
    await provider.cardUnarchive('c1', archived.version);
    assert.fail('unarchiving a tombstoned card must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.ok(e.meta.current.deleted_at, 'meta.current carries the tombstone');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.equal(out.some((c) => c.id === 'c1'), false, 'card removed from active state, not tombstone-spread');
  }
  await provider.disconnect(); await harness.close();
});

test('unarchive/unknown: a non-conflict domain error restores the FULL captured prior', async () => {
  const { provider, harness } = await connectedSpy({
    seed: oneCard,
    errorOn: { card_unarchive: { code: 'rate_limited', message: 'slow down' } },
  });
  const seeded = await provider.get('c1');
  const archived = await provider.cardArchive('c1', seeded.version);
  const prior = { ...archived };
  const optimisticModel = [{ ...archived, archived_at: null }];
  try {
    await provider.cardUnarchive('c1', archived.version);
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(failureTruth(e), 'unknown', 'no server truth proven — the write never landed');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.deepEqual(out, [prior], 'reverted to the full captured prior, not a partial-field patch');
  }
  await provider.disconnect(); await harness.close();
});

test('unarchive: never sends force, never auto-retries a conflict (asserted by absence)', async () => {
  const { provider, harness, calls } = await connectedSpy({ seed: oneCard });
  const seeded = await provider.get('c1');
  const archived = await provider.cardArchive('c1', seeded.version);
  harness.store.update('c1', { title: 'Someone else' }, { expected_version: archived.version });
  await assert.rejects(() => provider.cardUnarchive('c1', archived.version));
  const unarchiveCalls = calls.filter((c) => c.name === 'card_unarchive');
  assert.equal(unarchiveCalls.length, 1, 'exactly one attempt — no auto-retry on conflict');
  assert.equal('force' in unarchiveCalls[0].arguments, false, 'force never sent');
  await provider.disconnect(); await harness.close();
});

/* ================================================================== */
/* CLASSIFY (card_update, effort/impact patch — the Matrix drag write) */
/* ================================================================== */

test('classify/stale: conflict+live adopts the SERVER card, never the captured prior (red-contrast)', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  // Cycle a classify once so effort is an EXPLICIT value on the wire (the store only
  // stamps the field once touched — a fresh-created card omits the key entirely, a
  // test-harness fidelity gap, not a real Card shape; matches the archive test's
  // archived_at priming for the same reason).
  const seeded = await provider.get('c1');
  const classifiedOnce = await provider.cardUpdate('c1', { effort: 1, impact: 1, expected_version: seeded.version });
  harness.store.update('c1', { title: 'Renamed by someone else', effort: 4 }, { expected_version: classifiedOnce.version }); // races us
  const stale = harness.store.get('c1');
  const prior = { ...classifiedOnce };
  const optimisticModel = [{ ...classifiedOnce, effort: 3, impact: 2 }]; // our optimistic apply
  try {
    await provider.cardUpdate('c1', { effort: 3, impact: 2, expected_version: classifiedOnce.version });
    assert.fail('stale classify must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.equal(failureTruth(e), 'stale');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    const c1 = out.find((c) => c.id === 'c1');
    assert.equal(c1.title, 'Renamed by someone else', 'server truth wins');
    assert.notEqual(c1.title, prior.title, 'the captured prior is NOT restored over server truth');
    assert.equal(c1.effort, 4, 'the server truth wins — our optimistic effort (3) never survives a conflict');
    assert.notEqual(c1.effort, prior.effort, 'the captured prior effort is NOT restored over server truth');
    assert.equal(c1.version, stale.version, 'fresh version adopted for the next retry');
  }
  await provider.disconnect(); await harness.close();
});

test('classify/gone: conflict+tombstoned target leaves active model, no ghost restore', async () => {
  const { provider, harness } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.delete('c1', { expected_version: cur.version }); // deleted under our feet
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, effort: 3, impact: 2 }];
  try {
    await provider.cardUpdate('c1', { effort: 3, impact: 2, expected_version: cur.version });
    assert.fail('classifying a tombstoned card must conflict');
  } catch (e) {
    assert.equal(e.code, 'conflict');
    assert.ok(e.meta.current.deleted_at, 'meta.current carries the tombstone');
    assert.equal(failureTruth(e), 'gone');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.equal(out.some((c) => c.id === 'c1'), false, 'card removed from active state, not tombstone-spread');
  }
  await provider.disconnect(); await harness.close();
});

test('classify/unknown: a non-conflict domain error restores the FULL captured prior', async () => {
  const { provider, harness } = await connectedSpy({
    seed: oneCard,
    errorOn: { card_update: { code: 'rate_limited', message: 'slow down' } },
  });
  const cur = await provider.get('c1');
  const prior = { ...cur };
  const optimisticModel = [{ ...cur, effort: 3, impact: 2 }];
  try {
    await provider.cardUpdate('c1', { effort: 3, impact: 2, expected_version: cur.version });
    assert.fail('forced rate_limited must throw');
  } catch (e) {
    assert.equal(failureTruth(e), 'unknown', 'no server truth proven — the write never landed');
    const out = snapBackCards(optimisticModel, { id: 'c1', error: e, prior });
    assert.deepEqual(out, [prior], 'reverted to the full captured prior, not a partial-field patch');
  }
  await provider.disconnect(); await harness.close();
});

test('classify: never sends force, never auto-retries a conflict (asserted by absence)', async () => {
  const { provider, harness, calls } = await connectedSpy({ seed: oneCard });
  const cur = await provider.get('c1');
  harness.store.update('c1', { title: 'Someone else' }, { expected_version: cur.version });
  await assert.rejects(() => provider.cardUpdate('c1', { effort: 3, impact: 2, expected_version: cur.version }));
  const updateCalls = calls.filter((c) => c.name === 'card_update');
  assert.equal(updateCalls.length, 1, 'exactly one attempt — no auto-retry on conflict');
  assert.equal('force' in updateCalls[0].arguments, false, 'force never sent');
  await provider.disconnect(); await harness.close();
});
