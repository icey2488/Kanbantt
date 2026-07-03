/**
 * PURGE-RULE GUARD regression (spec v0.4.0 §Archive, "Full-fetch purge interaction"):
 * a locally-held card with non-null `archived_at` MUST NOT be purged when a DEFAULT
 * (non-include_archived) fetch's results omit it; purge authority over archived
 * cards requires an include_archived:true fetch.
 *
 * Driven two ways:
 *   - the pure reconciler (reconcileSpineModel) directly — every branch;
 *   - END-TO-END: the real connection controller polling the real MCPProvider over
 *     the in-process harness, with applyModel composed EXACTLY as the board wires it
 *     (`(next) => { model = reconcileSpineModel(model, next) }`), through the real
 *     archive-then-poll sequence that previously purged.
 *
 * Run:  node --test src/lib/spine-purge-guard.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMcpTestServer } from './spine-mcp-test-server.js';
import { createMCPProvider } from './spine-mcp-provider.js';
import { createMcpConnection, reconcileSpineModel } from './mcp-connection.js';

const model = (cards, includedArchived = false) => ({ columns: [], cards, flags: {}, includedArchived });

test('purge guard: a locally-held ARCHIVED card survives a default (non-include_archived) fetch that omits it', () => {
  const archived = { id: 'a', title: 'Done work', archived_at: '2026-07-01T00:00:00Z', version: 3 };
  const live = { id: 'b', title: 'Live', archived_at: null, version: 1 };
  const prev = model([archived, live]);
  const next = model([{ ...live, version: 2 }]); // default fetch: archived card absent
  const out = reconcileSpineModel(prev, next);
  assert.ok(out.cards.some((c) => c.id === 'a' && c.archived_at != null), 'archived card RETAINED');
  assert.equal(out.cards.find((c) => c.id === 'b').version, 2, 'server copy of the live card wins');
});

test('purge guard: an include_archived:true fetch HAS purge authority — absence there is authoritative', () => {
  const archived = { id: 'a', archived_at: '2026-07-01T00:00:00Z', version: 3 };
  const prev = model([archived]);
  const next = model([], true); // include_archived fetch omits it → genuinely gone
  const out = reconcileSpineModel(prev, next);
  assert.equal(out.cards.length, 0, 'archived card purged by an authorized fetch');
});

test('purge guard: retention is archived-only — a NON-archived card absent from a default fetch is still purged', () => {
  const prev = model([{ id: 'x', archived_at: null, version: 1 }]);
  const out = reconcileSpineModel(prev, model([]));
  assert.equal(out.cards.length, 0, 'non-archived absence keeps existing purge semantics');
});

test('purge guard: when the fetch DOES carry the card, the server copy wins (retention never overrides)', () => {
  const prev = model([{ id: 'a', archived_at: '2026-07-01T00:00:00Z', version: 3, title: 'stale' }]);
  const fresh = { id: 'a', archived_at: null, version: 4, title: 'unarchived elsewhere' };
  const out = reconcileSpineModel(prev, model([fresh], false));
  assert.equal(out.cards.length, 1);
  assert.deepEqual(out.cards[0], fresh, 'server copy replaces the held one');
});

test('purge guard end-to-end: archive → default poll omits the card → the reconciled board model still holds it', async () => {
  const harness = createMcpTestServer({
    seed: (s) => s.create({ id: 'c1', title: 'Delivered work', column_id: 'todo', priority: 'med' }),
  });

  // Manual scheduler: the recurring poll never fires on its own; pollNow drives it.
  const sched = {
    schedule: (fn, ms) => ({ fn, ms }),
    cancel: () => {},
  };
  // applyModel composed EXACTLY as the board wires it (App.jsx): the reconcile
  // wraps every applied model, `held` standing in for spineModel.
  let held = null;
  let showArchived = false; // the UI toggle the poll's include_archived follows
  const conn = createMcpConnection({
    config: { data_source: 'mcp', mcp: { url: harness.url } },
    makeProvider: () => createMCPProvider({ baseUrl: harness.url, fetchFn: harness.fetchFn }),
    applyModel: (next) => { held = reconcileSpineModel(held, next); },
    schedule: sched.schedule,
    cancel: sched.cancel,
    includeArchived: () => showArchived,
  });
  const st = await conn.connect();
  assert.equal(st.provider, 'mcp');
  assert.equal(held.cards.length, 1, 'first paint holds the live card');

  // The write-through: archive the card, merge the returned Card into the held
  // model (the board's RECONCILE step) — the card is now locally held as archived.
  const provider = conn.getProvider();
  const archived = await provider.cardArchive('c1', held.cards[0].version);
  assert.ok(archived.archived_at);
  held = { ...held, cards: held.cards.map((c) => (c.id === 'c1' ? { ...c, ...archived } : c)) };

  // THE REGRESSION: the backstop poll after a write is a DEFAULT fetch — its results
  // omit the just-archived card. Without the guard this purged it from the model.
  await conn.pollNow();
  const heldCard = held.cards.find((c) => c.id === 'c1');
  assert.ok(heldCard, 'archived card NOT purged by the default poll');
  assert.ok(heldCard.archived_at != null, 'still held as archived');

  // Toggle "Show archived" on → the next poll fetches include_archived:true and
  // now carries the card fresh from the server (same id, server copy).
  showArchived = true;
  await conn.pollNow();
  assert.ok(held.includedArchived, 'model reflects the authorized fetch mode');
  assert.ok(held.cards.some((c) => c.id === 'c1' && c.archived_at != null), 'server-carried archived card');

  // Server-side the card gets DELETED. The include_archived poll (no include_deleted)
  // omits it — and THAT absence is authoritative: the card purges.
  harness.store.delete('c1', { expected_version: held.cards.find((c) => c.id === 'c1').version });
  await conn.pollNow();
  assert.equal(held.cards.some((c) => c.id === 'c1'), false, 'authorized fetch purges the tombstoned card');

  await conn.disconnect();
  await harness.close();
});
