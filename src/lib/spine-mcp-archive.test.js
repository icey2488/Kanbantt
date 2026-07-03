/**
 * Archive-surface wire parity (spec v0.4.0 §Archive) — the real MCPProvider
 * driven against the in-process harness, proving the enumerated contract:
 *   - canArchive / canUnarchive derive from card_archive / card_unarchive ALONE
 *     (a card_archive-only server is a valid ONE-WAY archiver);
 *   - LOUD idempotency both ways (already-archived / not-archived → validation_failed);
 *   - the escalation gate's BOTH branches (an OPEN escalation blocks; a RESOLVED —
 *     even DENIED — escalation unblocks);
 *   - two-layer reason handling (omitted → the "manual_archive"/"manual_unarchive"
 *     default on the ledger row; EXPLICIT empty/whitespace → rejected, no row);
 *   - include_archived × include_deleted COMPOSITION on card_list;
 *   - conflict-before-domain ordering (tombstone / stale version → `conflict`,
 *     never a spurious idempotency/escalation validation_failed).
 *
 * Run:  node --test src/lib/spine-mcp-archive.test.js
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

test('canArchive/canUnarchive derive from card_archive/card_unarchive ALONE (one-way archiver supported)', async () => {
  // Full set → both true.
  const both = await connected();
  assert.equal(both.provider.getCapabilities().capabilities.canArchive, true);
  assert.equal(both.provider.getCapabilities().capabilities.canUnarchive, true);
  await both.provider.disconnect(); await both.harness.close();

  // card_archive WITHOUT card_unarchive → a valid ONE-WAY archiver: archive
  // affordance renders, unarchive does not (spec §Discovery).
  const oneWay = await connected({ omitTools: ['card_unarchive'] });
  const caps = oneWay.provider.getCapabilities().capabilities;
  assert.equal(caps.canArchive, true, 'card_archive alone ⇒ canArchive');
  assert.equal(caps.canUnarchive, false, 'no card_unarchive ⇒ no unarchive affordance');
  await assert.rejects(
    () => oneWay.provider.cardUnarchive('c1', 1),
    (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability',
  );
  await oneWay.provider.disconnect(); await oneWay.harness.close();

  // Neither derives from canWrite: omit card_archive, keep the card_* writes.
  const none = await connected({ omitTools: ['card_archive'] });
  assert.equal(none.provider.getCapabilities().capabilities.canWrite, true);
  assert.equal(none.provider.getCapabilities().capabilities.canArchive, false);
  await assert.rejects(
    () => none.provider.cardArchive('c1', 1),
    (e) => e instanceof MCPProviderError && e.code === 'unsupported_capability',
  );
  await none.provider.disconnect(); await none.harness.close();
});

test('cardArchive round trip: archived_at set, version minted, audit row with the manual_archive default reason', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const before = await provider.get('c1');
  assert.equal(before.archived_at ?? null, null, 'seed card starts unarchived');

  const archived = await provider.cardArchive('c1', before.version); // reason OMITTED
  assert.ok(archived.archived_at, 'archived_at stamped');
  assert.ok(archived.version > before.version, 'archive mints a fresh version');

  const rows = harness.archiveAudit();
  assert.equal(rows.length, 1, 'exactly one ledger row');
  assert.equal(rows[0].action, 'archive');
  assert.equal(rows[0].card_id, 'c1');
  assert.equal(rows[0].reason, 'manual_archive', 'omitted reason → the tool-layer default');
  assert.equal(rows[0].actor, 'client:bearer');

  // Unarchive with an EXPLICIT reason: passed through verbatim, action flips.
  const restored = await provider.cardUnarchive('c1', archived.version, 'restoring for rework');
  assert.equal(restored.archived_at, null, 'archived_at cleared');
  const rows2 = harness.archiveAudit();
  assert.equal(rows2.length, 2);
  assert.equal(rows2[1].action, 'unarchive');
  assert.equal(rows2[1].reason, 'restoring for rework');
  await provider.disconnect(); await harness.close();
});

test('LOUD idempotency both ways: re-archive → "already archived"; unarchive of a live card → "not archived"', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const v1 = (await provider.get('c1')).version;
  const archived = await provider.cardArchive('c1', v1);

  // Re-archive with the FRESH version (so the gate passes and the DOMAIN check fires).
  await assert.rejects(
    () => provider.cardArchive('c1', archived.version),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed' && /already archived/.test(e.message),
    'already-archived is a LOUD reject, never a silent no-op',
  );

  const restored = await provider.cardUnarchive('c1', archived.version);
  await assert.rejects(
    () => provider.cardUnarchive('c1', restored.version),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed' && /not archived/.test(e.message),
    'unarchive of a not-archived card is equally loud',
  );
  // No rejection branch wrote a ledger row: archive + unarchive only.
  assert.equal(harness.archiveAudit().length, 2);
  await provider.disconnect(); await harness.close();
});

test('escalation gate: an OPEN escalation blocks archive; a RESOLVED-DENIED one unblocks it', async () => {
  const { provider, harness } = await connected({
    seed: oneCard,
    escalations: [{ id: 'esc1', card_id: 'c1', resolved_at: null, deleted_at: null }],
  });
  const v1 = (await provider.get('c1')).version;

  await assert.rejects(
    () => provider.cardArchive('c1', v1),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed'
      && e.message === 'cannot archive a task with an unresolved escalation',
    'an open (live + unresolved) escalation blocks archive',
  );
  assert.equal(harness.archiveAudit().length, 0, 'blocked archive writes no ledger row');

  // Resolve it as DENIED — resolution does not matter, resolved_at does: a denied
  // escalation is still a CLOSED one, so the card is archivable.
  await provider.escalationResolve('esc1', { resolution: 'deny', resolution_rationale: 'denied after review' });
  const archived = await provider.cardArchive('c1', v1);
  assert.ok(archived.archived_at, 'resolved-denied escalation unblocks archive');
  await provider.disconnect(); await harness.close();
});

test('two-layer reason: an EXPLICIT empty/whitespace reason is rejected (never defaulted), no ledger row', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const v1 = (await provider.get('c1')).version;
  await assert.rejects(
    () => provider.cardArchive('c1', v1, '   '),
    (e) => e instanceof MCPProviderError && e.code === 'validation_failed'
      && e.message === 'archive_audit rows require a non-empty reason',
    'explicit garbage is loud; only OMISSION gets the ergonomic default',
  );
  assert.equal(harness.archiveAudit().length, 0, 'the reject staged nothing');
  const still = await provider.get('c1');
  assert.equal(still.archived_at ?? null, null, 'card untouched');
  await provider.disconnect(); await harness.close();
});

test('include_archived × include_deleted COMPOSE: a deleted+archived card needs BOTH flags', async () => {
  const { provider, harness } = await connected({ seed: oneCard });
  const v1 = (await provider.get('c1')).version;
  const archived = await provider.cardArchive('c1', v1);

  // Archived (live): omitted from a default full fetch, present with includeArchived.
  assert.equal((await provider.list()).cards.length, 0, 'default full fetch omits archived');
  assert.equal((await provider.list({ includeArchived: true })).cards.length, 1);

  // Now ALSO deleted: each flag alone is insufficient; both together surface it.
  await provider.cardDelete('c1', { expected_version: archived.version });
  assert.equal((await provider.list({ includeArchived: true })).cards.length, 0, 'tombstone still hidden');
  assert.equal((await provider.list({ includeDeleted: true })).cards.length, 0, 'archived filter still applies');
  const both = await provider.list({ includeDeleted: true, includeArchived: true });
  assert.equal(both.cards.length, 1, 'deleted+archived needs BOTH flags');
  assert.ok(both.cards[0].deleted_at && both.cards[0].archived_at, 'both flags carried on the card');
  await provider.disconnect(); await harness.close();
});

test('conflict-before-domain: a stale version or tombstone → `conflict`, never a spurious idempotency/escalation reject', async () => {
  const { provider, harness } = await connected({
    seed: oneCard,
    escalations: [{ id: 'esc1', card_id: 'c1', resolved_at: null, deleted_at: null }],
  });
  const v1 = (await provider.get('c1')).version;
  // STALE version on a card that ALSO has an open escalation: the version gate must
  // win — `conflict` carrying the current card, NOT the escalation validation_failed.
  await assert.rejects(
    () => provider.cardArchive('c1', v1 + 41),
    (e) => e instanceof MCPProviderError && e.code === 'conflict' && e.meta.current.id === 'c1',
    'stale version beats the escalation gate',
  );

  // STALE version on an already-archived card: conflict, NOT "already archived".
  harness.escalations[0].resolved_at = '2026-07-02T00:00:00Z'; // close it via the live handle
  const archived = await provider.cardArchive('c1', v1);
  await assert.rejects(
    () => provider.cardArchive('c1', archived.version + 41),
    (e) => e instanceof MCPProviderError && e.code === 'conflict',
    'stale version beats loud idempotency',
  );

  // TOMBSTONE: archive/unarchive of a deleted card is a conflict (immutable), even
  // though its archived_at state would otherwise trip the domain checks.
  await provider.cardDelete('c1', { expected_version: archived.version });
  const freshV = archived.version + 1;
  await assert.rejects(
    () => provider.cardUnarchive('c1', freshV),
    (e) => e instanceof MCPProviderError && e.code === 'conflict',
    'tombstone beats "not archived"/"already archived" alike',
  );
  await provider.disconnect(); await harness.close();
});
