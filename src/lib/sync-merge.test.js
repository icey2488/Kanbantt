/**
 * Tests for the pure convergent merge core (Drive sync, Feature 1).
 * Run with: npm test   (node --test, no extra deps)
 *
 * The convergence matrix (commutativity / associativity / idempotency / the
 * amplification guard) is the make-or-break section: it PROVES the CRDT-like
 * properties rather than assuming them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalize,
  blobHash,
  conflictId,
  mergeBlobs,
  resolve,
} from './sync-merge.js';

/* ------------------------------------------------------------------ */
/* Builders                                                           */
/* ------------------------------------------------------------------ */

const card = (id, version, extra = {}) => ({
  id, version, column_id: 'todo', order: 'V', deleted_at: null, tags: [], title: id, ...extra,
});
const tomb = (id, version, extra = {}) =>
  card(id, version, { deleted_at: '2026-06-13T00:00:00.000Z', ...extra });
const blob = (over = {}) => ({
  schema_version: 1,
  seq: 0,
  cards: [],
  tags: [],
  columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }],
  settings: {},
  ...over,
});

const eq = (x, y) => canonicalize(x) === canonicalize(y);
const conflictCards = (b) => b.cards.filter((c) => c.id.includes('.conflict.'));

/* ================================================================== */
/* Convergence matrix — the make-or-break assertions                  */
/* ================================================================== */

// A spread of crafted divergent pairs reused by the algebra tests.
function divergentPairs() {
  const pairs = [];
  // same-id, different version + content
  pairs.push([
    blob({ cards: [card('X', 'a1', { title: 'AAA' }), card('Y', '1')] }),
    blob({ cards: [card('X', 'b1', { title: 'BBB' }), card('Z', '1')] }),
  ]);
  // tombstone vs live-edited (different version) + disjoint cards
  pairs.push([
    blob({ cards: [tomb('X', '9'), card('P', '1')] }),
    blob({ cards: [card('X', '7', { title: 'edited' }), card('Q', '1')] }),
  ]);
  // tombstone vs live-unchanged (same version)
  pairs.push([
    blob({ cards: [tomb('X', '5')] }),
    blob({ cards: [card('X', '5')] }),
  ]);
  // board-config divergence (same id, different color) + tag union
  pairs.push([
    blob({ tags: [{ id: 't1', name: 'one', color: 'red' }], columns: [{ id: 'todo', label: 'A', accentKey: 'ice' }] }),
    blob({ tags: [{ id: 't1', name: 'one', color: 'blue' }, { id: 't2', name: 'two', color: 'mint' }], columns: [{ id: 'todo', label: 'B', accentKey: 'amber' }] }),
  ]);
  return pairs;
}

test('commutativity: mergeBlobs(a,b) canonically equals mergeBlobs(b,a)', () => {
  for (const [a, b] of divergentPairs()) {
    assert.ok(eq(mergeBlobs(a, b), mergeBlobs(b, a)), 'merge must be commutative');
  }
});

test('associativity: both three-way groupings canonically equal', () => {
  // Three divergent versions of X, disjoint cards, a live/tombstone split on Y,
  // and a three-way-divergent tag — exercises card conflicts, deletion, and
  // board-config tie-breaks together.
  const a = blob({
    cards: [card('X', 'a1', { title: 'AA' }), card('Y', '1'), card('Pa', '1')],
    tags: [{ id: 't1', name: 'a', color: 'red' }],
  });
  const b = blob({
    cards: [card('X', 'b1', { title: 'BB' }), card('Pb', '1')],
    tags: [{ id: 't1', name: 'b', color: 'blue' }, { id: 't2', name: 'two', color: 'mint' }],
  });
  const c = blob({
    cards: [card('X', 'c1', { title: 'CC' }), tomb('Y', '2'), card('Pc', '1')],
    tags: [{ id: 't1', name: 'c', color: 'green' }],
  });

  const left = mergeBlobs(mergeBlobs(a, b), c);
  const right = mergeBlobs(a, mergeBlobs(b, c));
  assert.ok(eq(left, right), 'merge must be associative');
});

test('idempotency: mergeBlobs(a,a) canonically equals canonicalize(a)', () => {
  const a = blob({
    cards: [card('X', '1', { tags: ['t1'] }), tomb('Z', '3'), card('Y', '2', { tags: ['t1', 't2'] })],
    tags: [{ id: 't1', name: 'one', color: 'red' }, { id: 't2', name: 'two', color: 'blue' }],
  });
  assert.ok(eq(mergeBlobs(a, a), a), 'merge with self must be a no-op (canonically)');
});

test('amplification guard: independent merges converge with NO new conflict ids on re-merge', () => {
  // Shared lineage X, forked + edited on two devices into different versions.
  const a = blob({ cards: [card('X', 'a1', { title: 'edit-A' })] });
  const b = blob({ cards: [card('X', 'b1', { title: 'edit-B' })] });

  // Device A merges (local a, drive b); device B merges (local b, drive a).
  const rA = mergeBlobs(a, b);
  const rB = mergeBlobs(b, a);
  assert.ok(eq(rA, rB), 'both devices reach the same merged state');

  // Round 1 produced exactly one base + one conflict copy, no data lost.
  assert.equal(rA.cards.length, 2);
  assert.equal(conflictCards(rA).length, 1, 'exactly one conflict copy in round 1');
  const titles = rA.cards.map((c) => c.title).sort();
  assert.deepEqual(titles, ['edit-A', 'edit-B'], 'both edits survive');

  // Re-merge the two device results — must converge, with the SAME conflict ids.
  const r2 = mergeBlobs(rA, rB);
  assert.ok(eq(r2, rA), 're-merge is stable (no amplification)');

  const c1 = conflictCards(rA).map((c) => c.id).sort();
  const c2 = conflictCards(r2).map((c) => c.id).sort();
  assert.deepEqual(c2, c1, 'no NEW conflict ids on re-merge');
  assert.ok(!r2.cards.some((c) => /\.conflict\..*\.conflict\./.test(c.id)), 'no X.conflict.h1.conflict.h2 explosion');
});

/* ================================================================== */
/* Canonicalization                                                   */
/* ================================================================== */

test('shuffled object-key order and shuffled cards/tags array order hash identically', () => {
  const a = blob({
    schema_version: 1,
    cards: [card('a', '1', { tags: ['t2', 't1'] }), card('b', '1', { tags: ['t1', 't2'] })],
    tags: [{ id: 't2', name: 'two', color: 'x' }, { id: 't1', name: 'one', color: 'y' }],
  });
  // Same state, different in-memory ordering at every level.
  const b = {
    settings: {},
    columns: [{ accentKey: 'ice', id: 'todo', label: 'To Do' }],
    tags: [{ color: 'y', id: 't1', name: 'one' }, { color: 'x', id: 't2', name: 'two' }],
    cards: [
      { tags: ['t1', 't2'], deleted_at: null, order: 'V', column_id: 'todo', version: '1', id: 'b', title: 'b' },
      { title: 'a', id: 'a', version: '1', column_id: 'todo', order: 'V', deleted_at: null, tags: ['t1', 't2'] },
    ],
    seq: 0,
    schema_version: 1,
  };
  assert.equal(blobHash(a), blobHash(b), 'canonical hash ignores key + insignificant array order');
});

test('number and value formatting is stable; checklist order is preserved (meaningful)', () => {
  assert.equal(canonicalize({ a: 1.0, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(canonicalize(1.0), '1');
  assert.equal(canonicalize({ n: 1.5, s: 'x', t: true, z: null }), '{"n":1.5,"s":"x","t":true,"z":null}');
  // checklist items have no id => order is meaningful => NOT reordered.
  const c1 = canonicalize({ checklist: [{ text: 'b', done: false }, { text: 'a', done: true }] });
  const c2 = canonicalize({ checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] });
  assert.notEqual(c1, c2, 'checklist order must be preserved');
});

test('conflictId is symmetric and content-derived', () => {
  const x = card('X', '1', { title: 'AA' });
  const y = card('X', '2', { title: 'BB' });
  assert.equal(conflictId(x, y), conflictId(y, x), 'symmetric in argument order');
  assert.match(conflictId(x, y), /^X\.conflict\.[0-9a-f]{12}$/, 'shape: baseId.conflict.<12 hex>');
});

/* ================================================================== */
/* Merge semantics                                                    */
/* ================================================================== */

test('same-id different-version: one base + one deterministic conflict copy, no data lost', () => {
  const a = blob({ cards: [card('X', '1', { title: 'AA' })] });
  const b = blob({ cards: [card('X', '2', { title: 'BB' })] });
  const m = mergeBlobs(a, b);

  assert.equal(m.cards.length, 2);
  const base = m.cards.find((c) => c.id === 'X');
  const copy = m.cards.find((c) => c.id.startsWith('X.conflict.'));
  assert.ok(base && copy, 'one base id + one conflict id');
  assert.deepEqual(m.cards.map((c) => c.title).sort(), ['AA', 'BB'], 'no data discarded');
  assert.equal(copy._conflict.of, 'X', 'conflict copy records base lineage');
  // deterministic regardless of argument order
  assert.ok(eq(m, mergeBlobs(b, a)));
});

test('tombstone vs live-unchanged (same version): plain deletion, no conflict copy', () => {
  const a = blob({ cards: [tomb('X', '5')] });
  const b = blob({ cards: [card('X', '5', { title: 'live' })] });
  const m = mergeBlobs(a, b);

  assert.equal(m.cards.length, 1);
  assert.equal(m.cards[0].id, 'X');
  assert.ok(m.cards[0].deleted_at, 'slot is the tombstone');
  assert.equal(conflictCards(m).length, 0, 'no conflict copy when versions match');
});

test('tombstone vs live-edited (different version): tombstone at base + edit preserved as copy', () => {
  const a = blob({ cards: [tomb('X', '9')] });
  const b = blob({ cards: [card('X', '7', { title: 'genuine-edit' })] });
  const m = mergeBlobs(a, b);

  const base = m.cards.find((c) => c.id === 'X');
  const copy = m.cards.find((c) => c.id.startsWith('X.conflict.'));
  assert.ok(base.deleted_at, 'deletion wins the base slot');
  assert.ok(copy && copy.deleted_at == null, 'live edit preserved as a (non-deleted) conflict copy');
  assert.equal(copy.title, 'genuine-edit', 'edited content not destroyed');
});

test('never-resurrect: live on one side, tombstoned on the other, keeps deleted_at at the base', () => {
  const a = blob({ cards: [card('X', '5', { title: 'alive' })] });
  const b = blob({ cards: [tomb('X', '5')] });
  for (const m of [mergeBlobs(a, b), mergeBlobs(b, a)]) {
    const base = m.cards.find((c) => c.id === 'X');
    assert.ok(base.deleted_at != null, 'base slot must stay deleted — never resurrected');
  }
});

test('tag union + dangling-ref strip; unknown column_id retained', () => {
  const a = blob({
    cards: [card('X', '1', { tags: ['t1', 'ghost'], column_id: 'ghostcol' })],
    tags: [{ id: 't1', name: 'one', color: 'red' }],
    columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }],
  });
  const b = blob({
    tags: [{ id: 't2', name: 'two', color: 'blue' }],
    columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }],
  });
  const m = mergeBlobs(a, b);

  assert.deepEqual(m.tags.map((t) => t.id).sort(), ['t1', 't2'], 'tags unioned by id');
  const x = m.cards.find((c) => c.id === 'X');
  assert.deepEqual(x.tags, ['t1'], 'dangling tag ref "ghost" stripped; "t1" kept');
  assert.equal(x.column_id, 'ghostcol', 'card with unknown column_id is retained, not dropped/reassigned');
});

test('board-config same-id divergence resolves to the lesser-canonical deterministically', () => {
  const a = blob({ columns: [{ id: 'todo', label: 'To Do', accentKey: 'ice' }] });
  const b = blob({ columns: [{ id: 'todo', label: 'To Do', accentKey: 'amber' }] });
  const m1 = mergeBlobs(a, b);
  const m2 = mergeBlobs(b, a);
  assert.equal(m1.columns.length, 1, 'union by id — one column');
  assert.ok(eq(m1, m2), 'deterministic tie-break, order-independent');
});

/* ================================================================== */
/* Resolver precedence — all 7 branches + the fall-through fix         */
/* ================================================================== */

test('resolver branch 1: malformed/null drive -> recover (no merge)', () => {
  assert.equal(resolve({ local: blob(), drive: null, lastSynced: null }).action, 'recover');
  assert.equal(resolve({ local: blob(), drive: {}, lastSynced: 'h' }).action, 'recover');
});

test('resolver branch 2: identical hashes -> in_sync', () => {
  const local = blob({ cards: [card('X', '1')] });
  const drive = blob({ cards: [card('X', '1')] }); // structurally identical
  const r = resolve({ local, drive, lastSynced: 'stale' });
  assert.equal(r.action, 'in_sync');
});

test('resolver branch 3: empty side ignores lastSynced -> adopt/push', () => {
  const populated = blob({ cards: [card('X', '1')] });
  const empty = blob(); // no cards, no tags
  assert.equal(resolve({ local: empty, drive: populated, lastSynced: null }).action, 'adopt_drive');
  assert.equal(resolve({ local: populated, drive: empty, lastSynced: null }).action, 'push_local');
});

test('resolver branch 4: local unchanged since sync, drive advanced -> adopt_drive', () => {
  const local = blob({ cards: [card('X', '1')] });
  const drive = blob({ cards: [card('X', '1'), card('Y', '1')] });
  const r = resolve({ local, drive, lastSynced: blobHash(local) });
  assert.equal(r.action, 'adopt_drive');
});

test('resolver branch 5: drive unchanged since sync, local advanced -> push_local', () => {
  const drive = blob({ cards: [card('X', '1')] });
  const local = blob({ cards: [card('X', '1'), card('Y', '1')] });
  const r = resolve({ local, drive, lastSynced: blobHash(drive) });
  assert.equal(r.action, 'push_local');
});

test('resolver branch 6: never synced, both non-empty -> collision (no blob, no merge)', () => {
  const local = blob({ cards: [card('X', '1')] });
  const drive = blob({ cards: [card('Y', '1')] });
  const r = resolve({ local, drive, lastSynced: null });
  assert.equal(r.action, 'collision');
  assert.equal(r.blob, undefined, 'collision returns no blob — caller drives the choice');
});

test('resolver branch 7: shared sync point, both advanced -> merge with blob', () => {
  const local = blob({ cards: [card('X', '1', { title: 'AA' })] });
  const drive = blob({ cards: [card('X', '2', { title: 'BB' })] });
  const r = resolve({ local, drive, lastSynced: 'a-prior-shared-hash' });
  assert.equal(r.action, 'merge');
  assert.ok(r.blob, 'merge returns the merged blob');
  assert.ok(eq(r.blob, mergeBlobs(local, drive)));
});

test('resolver fall-through fix: lastSynced present, matches neither, one side empty -> adopt/push, NOT merge', () => {
  const populated = blob({ cards: [card('X', '1')] });
  const empty = blob();
  const r = resolve({ local: empty, drive: populated, lastSynced: 'matches-neither' });
  assert.equal(r.action, 'adopt_drive', 'empty side short-circuits before the merge branch');
  assert.notEqual(r.action, 'merge');
});
