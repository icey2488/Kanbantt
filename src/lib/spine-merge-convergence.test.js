/**
 * Spine Step 3 — gating sub-task: RE-PROVE convergence + reference-preservation
 * for the FOUR-ENTITY spine blob, reusing Kanbantt's sync-merge.js merge core.
 *
 * Additive test file. ZERO changes to sync-merge.js (none are made or needed).
 *
 * Spine blob shape under test:
 *   { schema_version, seq, projects[], tasks[], artifacts[], escalations[] }
 * id-keyed collections (arrays of { id, version, deleted_at, ...content }) with
 * CROSS-TYPE refs carried as opaque content fields:
 *   artifact.task_id   -> task.id
 *   task.project_id    -> project.id
 *   escalation.dispatch_id -> a task/dispatch id
 *
 * ── The four collections are now REGISTERED in the real merge ───────────────
 * The collection-registry refactor of sync-merge.js enrolled projects/tasks/
 * artifacts/escalations into UNION_COLLECTIONS, so the REAL mergeBlobs gives them
 * full id-keyed conflict-copy union directly. This proof now exercises the real
 * mergeBlobs (the earlier `mergeSpine` route-through-cards shim is GONE — it was
 * scaffolding for proving the property before the registration existed). Every
 * collection inherits the matrix-proven id-keyed union / tombstone / content-
 * addressed-conflict semantics from the same algorithm; cross-type refs ride as
 * opaque content fields, untouched by the merge.
 *
 * R3 — the rule under test: the merge stays schema-DUMB — blind id-keyed union +
 * content-addressed conflictId, ZERO relational logic (no cascade, no "merge
 * unless parent absent", no FK rewrite). Claim 2 proves this with a red-on-
 * violation contrast: a HYPOTHETICAL relational merge (mergeSpineRelational)
 * FAILS the same assertions the schema-dumb merge passes.
 *
 * Run:  node --test src/lib/spine-merge-convergence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, mergeBlobs } from './sync-merge.js';

const eq = (x, y) => canonicalize(x) === canonicalize(y);

/* ------------------------------------------------------------------ */
/* Builders — spine entities carry the union's required fields         */
/* (id, version, deleted_at) plus opaque content incl. cross refs.     */
/* ------------------------------------------------------------------ */
const ent = (id, version, extra = {}) => ({ id, version, deleted_at: null, ...extra });
const dead = (id, version, extra = {}) =>
  ent(id, version, { deleted_at: '2026-06-15T00:00:00.000Z', ...extra });

const spine = (over = {}) => ({
  schema_version: 1,
  seq: 0,
  projects: [],
  tasks: [],
  artifacts: [],
  escalations: [],
  ...over,
});

const conflicts = (arr) => arr.filter((e) => e.id.includes('.conflict.'));
const byId = (arr, id) => arr.find((e) => e.id === id);

/* The four spine collections are now registered in sync-merge.js, so the REAL
 * mergeBlobs handles them directly — no shim. (Scalars schema_version/seq are
 * constant across these fixtures, so the real merge's mergeRest lesserCanon path
 * handles them identically.) */

/* The FORBIDDEN relational merge — the SAME union, then the two behaviors R3
 * outlaws. Exists ONLY to prove Claim 2's assertions are real controls: a
 * schema-dumb merge passes them; this one fails. (Same naive-contrast discipline
 * as the classifier's apex-floor proof.) */
function mergeSpineRelational(a, b, { cascade = true, rewriteFk = true } = {}) {
  const m = mergeBlobs(a, b);
  if (cascade) {
    // cascade-delete any artifact whose referenced task is tombstoned
    const tomb = new Set(m.tasks.filter((t) => t.deleted_at != null).map((t) => t.id));
    m.artifacts = m.artifacts.filter((art) => !tomb.has(art.task_id));
  }
  if (rewriteFk) {
    // rewrite a child FK to chase the .conflict copy of a diverged task
    const conflictOf = new Map();
    for (const t of m.tasks) {
      const mm = /^(.*)\.conflict\./.exec(t.id);
      if (mm) conflictOf.set(mm[1], t.id);
    }
    m.artifacts = m.artifacts.map((art) =>
      conflictOf.has(art.task_id) ? { ...art, task_id: conflictOf.get(art.task_id) } : art,
    );
  }
  return m;
}

/* ================================================================== */
/* FINDING — why registration is REQUIRED (the shipped merge gap)      */
/* ================================================================== */

test('FINDING (now closed): the REAL mergeBlobs registers the spine collections — the concurrently-created artifact is NO LONGER dropped', () => {
  // The exact R4 inputs that, against the UNREGISTERED path, fell through
  // mergeRest (whole-collection lesserCanon → artifact dropped). This test was
  // RED before the registry refactor; it is GREEN against the registered path.
  const n1 = spine({ tasks: [dead('T', 'v0')], artifacts: [] });
  const n2 = spine({ tasks: [ent('T', 'v0')], artifacts: [ent('A', '1', { task_id: 'T' })] });

  for (const m of [mergeBlobs(n1, n2), mergeBlobs(n2, n1)]) {
    const A = byId(m.artifacts, 'A');
    assert.ok(A, 'artifact SURVIVES — registered into the id-keyed union, not lost to mergeRest');
    assert.equal(A.task_id, 'T', 'cross-type ref intact');
    assert.ok(byId(m.tasks, 'T').deleted_at != null, 'task still tombstoned (no cascade)');
  }

  // Conditional materialization: a pure-spine blob gets NO empty Kanbantt
  // collections injected (the registry only materializes a collection present in
  // an input).
  const m = mergeBlobs(n1, n2);
  assert.ok(!('cards' in m) && !('columns' in m) && !('tags' in m), 'no empty cards/columns/tags injected into a spine blob');
});

/* ================================================================== */
/* CLAIM 1 — pure convergence over the four-entity blob                */
/* ================================================================== */

function divergentSpinePairs() {
  const pairs = [];
  // (1) same-id different-version across ALL FOUR collections + disjoint adds.
  pairs.push([
    spine({
      projects: [ent('P', 'a', { name: 'P-A' })],
      tasks: [ent('T', 'a', { project_id: 'P', title: 'T-A' }), ent('T2', '1', { project_id: 'P' })],
      artifacts: [ent('R', 'a', { task_id: 'T' })],
      escalations: [ent('E', 'a', { dispatch_id: 'T' })],
    }),
    spine({
      projects: [ent('P', 'b', { name: 'P-B' })],
      tasks: [ent('T', 'b', { project_id: 'P', title: 'T-B' }), ent('T3', '1', { project_id: 'P' })],
      artifacts: [ent('R', 'b', { task_id: 'T' }), ent('R2', '1', { task_id: 'T2' })],
      escalations: [ent('E', 'b', { dispatch_id: 'T' })],
    }),
  ]);
  // (2) tombstone vs live-edited (different version) with refs on both sides.
  pairs.push([
    spine({
      projects: [ent('P', '1')],
      tasks: [dead('T', '9', { project_id: 'P' })],
      artifacts: [ent('R', '1', { task_id: 'T' })],
    }),
    spine({
      projects: [ent('P', '1')],
      tasks: [ent('T', '7', { project_id: 'P', title: 'edited' })],
      artifacts: [ent('R', '1', { task_id: 'T' })],
      escalations: [ent('E', '1', { dispatch_id: 'T' })],
    }),
  ]);
  // (3) cross-ref-heavy, disjoint escalations + artifacts.
  pairs.push([
    spine({
      projects: [ent('P', '1'), ent('Q', '1')],
      tasks: [ent('T', '1', { project_id: 'P' }), ent('U', '1', { project_id: 'Q' })],
      artifacts: [ent('R', '1', { task_id: 'T' })],
      escalations: [ent('E1', '1', { dispatch_id: 'T' })],
    }),
    spine({
      projects: [ent('P', '1')],
      tasks: [ent('T', '1', { project_id: 'P' })],
      artifacts: [ent('R', '1', { task_id: 'T' }), ent('S', '1', { task_id: 'U' })],
      escalations: [ent('E2', '1', { dispatch_id: 'U' })],
    }),
  ]);
  return pairs;
}

test('Claim 1 — commutativity: mergeBlobs(a,b) canonically equals mergeBlobs(b,a) over all four collections', () => {
  for (const [a, b] of divergentSpinePairs()) {
    assert.ok(eq(mergeBlobs(a, b), mergeBlobs(b, a)), 'mergeSpine must be commutative');
  }
});

test('Claim 1 — associativity: both three-way groupings canonically equal over all four collections', () => {
  const a = spine({
    projects: [ent('P', 'a')],
    tasks: [ent('T', 'a1', { project_id: 'P', title: 'AA' }), ent('Ua', '1')],
    artifacts: [ent('R', 'a1', { task_id: 'T' })],
    escalations: [ent('E', 'a1', { dispatch_id: 'T' })],
  });
  const b = spine({
    projects: [ent('P', 'b')],
    tasks: [ent('T', 'b1', { project_id: 'P', title: 'BB' }), ent('Ub', '1')],
    artifacts: [ent('R', 'b1', { task_id: 'T' })],
    escalations: [ent('E', 'b1', { dispatch_id: 'T' })],
  });
  const c = spine({
    projects: [ent('P', 'c')],
    tasks: [ent('T', 'c1', { project_id: 'P', title: 'CC' }), dead('Ua', '2')],
    artifacts: [ent('R', 'c1', { task_id: 'T' })],
    escalations: [ent('E', 'c1', { dispatch_id: 'T' })],
  });
  const left = mergeBlobs(mergeBlobs(a, b), c);
  const right = mergeBlobs(a, mergeBlobs(b, c));
  assert.ok(eq(left, right), 'mergeSpine must be associative');
});

test('Claim 1 — idempotency: merge(a,a)==a and merge(merge(a,b),b)==merge(a,b)', () => {
  const a = spine({
    projects: [ent('P', '1')],
    tasks: [ent('T', '1', { project_id: 'P' }), dead('Z', '3')],
    artifacts: [ent('R', '2', { task_id: 'T' })],
    escalations: [ent('E', '1', { dispatch_id: 'T' })],
  });
  assert.ok(eq(mergeBlobs(a, a), a), 'merge with self must be a no-op (canonically)');

  const [x, y] = divergentSpinePairs()[0];
  const m = mergeBlobs(x, y);
  assert.ok(eq(mergeBlobs(m, y), m), 're-applying an input must be stable (no amplification)');
  assert.ok(eq(mergeBlobs(m, m), m), 'merge of the converged result with itself is a no-op');
});

test('Claim 1 — amplification guard (new shape): a forked task -> one base + one conflict copy; re-merge stable, no nested conflicts', () => {
  const a = spine({ tasks: [ent('T', 'a1', { project_id: 'P', title: 'edit-A' })] });
  const b = spine({ tasks: [ent('T', 'b1', { project_id: 'P', title: 'edit-B' })] });

  const rA = mergeBlobs(a, b);
  const rB = mergeBlobs(b, a);
  assert.ok(eq(rA, rB), 'both devices reach the same merged state');
  assert.equal(rA.tasks.length, 2, 'one base + one conflict copy');
  assert.equal(conflicts(rA.tasks).length, 1, 'exactly one conflict copy in round 1');
  assert.deepEqual(rA.tasks.map((t) => t.title).sort(), ['edit-A', 'edit-B'], 'both edits survive');

  const r2 = mergeBlobs(rA, rB);
  assert.ok(eq(r2, rA), 're-merge is stable (reaches a fixpoint)');
  assert.deepEqual(
    conflicts(r2.tasks).map((c) => c.id).sort(),
    conflicts(rA.tasks).map((c) => c.id).sort(),
    'no NEW conflict ids on re-merge',
  );
  assert.ok(
    !r2.tasks.some((t) => /\.conflict\..*\.conflict\./.test(t.id)),
    'no T.conflict.h1.conflict.h2 explosion',
  );
});

/* ================================================================== */
/* CLAIM 2 — reference-preservation under convergence (R4 / R5)        */
/* ================================================================== */

test('Claim 2 / R4 — tombstone-only, NO cascade: tombstoned parent + live child survives, ref intact; a relational (cascade) merge FAILS this', () => {
  // Node 1 tombstones Task T; Node 2 concurrently creates Artifact A -> T.
  const n1 = spine({
    projects: [ent('P', '1')],
    tasks: [dead('T', 'v0', { project_id: 'P' })],
  });
  const n2 = spine({
    projects: [ent('P', '1')],
    tasks: [ent('T', 'v0', { project_id: 'P' })],
    artifacts: [ent('A', '1', { task_id: 'T' })],
  });

  for (const m of [mergeBlobs(n1, n2), mergeBlobs(n2, n1)]) {
    const T = byId(m.tasks, 'T');
    const A = byId(m.artifacts, 'A');
    assert.ok(T && T.deleted_at != null, 'Task T is tombstoned in the converged state');
    assert.ok(A, 'Artifact A still EXISTS — NOT cascade-deleted');
    assert.equal(A.task_id, 'T', 'A.task_id still points at the (tombstoned) Task — ref NOT stripped');
    assert.equal(conflicts(m.tasks).length, 0, 'same-version tombstone vs live = plain deletion, no conflict copy');
  }

  // RED-on-violation: a relational merge that cascades the tombstone DELETES A.
  const rel = mergeSpineRelational(n1, n2, { cascade: true, rewriteFk: false });
  assert.equal(
    byId(rel.artifacts, 'A'),
    undefined,
    'CONTRAST: a cascading (relational) merge removes A — exactly what R4 forbids; the schema-dumb merge keeps it',
  );
});

test('Claim 2 / R5 — conflict, NO FK rewrite: child FK keeps the ORIGINAL task id; a relational (FK-rewrite) merge FAILS this', () => {
  // Original T@v0 with child A; two incompatible concurrent edits to T's id.
  const n1 = spine({
    tasks: [ent('T', 'v1', { project_id: 'P', title: 'edit-1' })],
    artifacts: [ent('A', '1', { task_id: 'T' })],
  });
  const n2 = spine({
    tasks: [ent('T', 'v2', { project_id: 'P', title: 'edit-2' })],
    artifacts: [ent('A', '1', { task_id: 'T' })],
  });

  for (const m of [mergeBlobs(n1, n2), mergeBlobs(n2, n1)]) {
    const baseT = byId(m.tasks, 'T');
    const copy = m.tasks.find((t) => t.id.startsWith('T.conflict.'));
    assert.ok(baseT, 'the original task id T is retained at the base slot');
    assert.ok(copy && copy._conflict.of === 'T', 'the diverging edit is preserved as a T.conflict.<hash> copy');
    const A = byId(m.artifacts, 'A');
    assert.equal(A.task_id, 'T', 'A.task_id STILL points at the ORIGINAL T — NOT rewritten to chase the conflict copy');
  }

  // RED-on-violation: a relational merge that chases the conflict copy rewrites A.
  const rel = mergeSpineRelational(n1, n2, { cascade: false, rewriteFk: true });
  const relA = byId(rel.artifacts, 'A');
  assert.match(
    relA.task_id,
    /^T\.conflict\./,
    'CONTRAST: a FK-rewriting (relational) merge points A at the conflict copy — exactly what R5 forbids; the schema-dumb merge keeps the original id',
  );
});

test('Claim 2 — idempotency of the converged R4/R5 results: re-merge changes nothing (no new conflict copies, no ref drift)', () => {
  const n1 = spine({
    tasks: [ent('T', 'v1', { project_id: 'P', title: 'e1' })],
    artifacts: [ent('A', '1', { task_id: 'T' })],
  });
  const n2 = spine({
    tasks: [ent('T', 'v2', { project_id: 'P', title: 'e2' })],
    artifacts: [ent('A', '1', { task_id: 'T' })],
  });
  const m = mergeBlobs(n1, n2);

  assert.ok(eq(mergeBlobs(m, m), m), 're-merging the converged result with itself is a no-op');
  assert.ok(eq(mergeBlobs(m, n2), m), 're-applying an input is stable — no new conflict copies');
  assert.equal(byId(mergeBlobs(m, n2).artifacts, 'A').task_id, 'T', 'ref does not drift on re-merge');
});
