/**
 * Pure-function tests for the matrix classify logic (quadrant mapping, tray
 * bucketing, drag-to-classify value derivation). The functions live in App.jsx
 * (not importable in Node test context), so the relevant pure math is replicated
 * inline here. Any divergence from App.jsx is a bug in the test, not a pass.
 *
 * Run:  node --test src/lib/matrix-classify.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* ---- replicated from App.jsx (keep in sync with QUADRANT_DEFS / EFFORT_IMPACT_QUADRANT) ---- */

const QUADRANT_DEFS = {
  avoid:       { effort: 'high', impact: 'low'  },
  plan:        { effort: 'high', impact: 'high' },
  deprioritize:{ effort: 'low',  impact: 'low'  },
  do:          { effort: 'low',  impact: 'high' },
};

// Effort gate is STRICT (only 'low' = cheap); impact gate is LENIENT ('med' counts as high).
const EFFORT_IMPACT_QUADRANT = {
  low:  { low: 'deprioritize', med: 'do',   high: 'do'   },
  med:  { low: 'avoid',        med: 'plan',  high: 'plan' },
  high: { low: 'avoid',        med: 'plan',  high: 'plan' },
};

const getImpact = (task) => task.impact ?? (task.priority === 'low' ? 'low' : 'high');

const getQuadrant = (task) => {
  if (task.effort == null) return 'unsorted';
  const impact = getImpact(task);
  return EFFORT_IMPACT_QUADRANT[task.effort][impact];
};

/* ---- grouping helper (mirrors MatrixView's useMemo) ---- */
function group(tasks) {
  const g = { avoid: [], plan: [], deprioritize: [], do: [], unsorted: [] };
  tasks.forEach((t) => g[getQuadrant(t)].push(t));
  return g;
}

/* ================================================================== */
/* Quadrant mapping                                                     */
/* ================================================================== */

test('getQuadrant: low effort + high impact → do', () => {
  assert.equal(getQuadrant({ effort: 'low', impact: 'high' }), 'do');
});

test('getQuadrant: low effort + med impact → do (lenient impact gate)', () => {
  assert.equal(getQuadrant({ effort: 'low', impact: 'med' }), 'do');
});

test('getQuadrant: low effort + low impact → deprioritize', () => {
  assert.equal(getQuadrant({ effort: 'low', impact: 'low' }), 'deprioritize');
});

test('getQuadrant: high effort + high impact → plan', () => {
  assert.equal(getQuadrant({ effort: 'high', impact: 'high' }), 'plan');
});

test('getQuadrant: med effort + high impact → plan (strict effort gate)', () => {
  assert.equal(getQuadrant({ effort: 'med', impact: 'high' }), 'plan');
});

test('getQuadrant: high effort + low impact → avoid', () => {
  assert.equal(getQuadrant({ effort: 'high', impact: 'low' }), 'avoid');
});

test('getQuadrant: med effort + low impact → avoid', () => {
  assert.equal(getQuadrant({ effort: 'med', impact: 'low' }), 'avoid');
});

test('getQuadrant: effort null → unsorted (explicit null)', () => {
  assert.equal(getQuadrant({ effort: null, impact: 'high' }), 'unsorted');
});

test('getQuadrant: effort undefined → unsorted (absent key)', () => {
  assert.equal(getQuadrant({ impact: 'high' }), 'unsorted');
});

test('getQuadrant: effort null + impact null → unsorted (both unset)', () => {
  assert.equal(getQuadrant({ effort: null, impact: null }), 'unsorted');
});

/* ================================================================== */
/* Impact fallback (derived from priority when impact unset)           */
/* ================================================================== */

test('getImpact falls back to priority: med-priority reads as high impact', () => {
  assert.equal(getImpact({ priority: 'med' }), 'high');
});

test('getImpact falls back to priority: low-priority reads as low impact', () => {
  assert.equal(getImpact({ priority: 'low' }), 'low');
});

test('getImpact: explicit impact overrides priority', () => {
  assert.equal(getImpact({ priority: 'low', impact: 'high' }), 'high');
});

/* ================================================================== */
/* Tray: only uncategorized cards appear there                         */
/* ================================================================== */

test('tray (unsorted bucket) contains only cards with null/undefined effort', () => {
  const tasks = [
    { id: 'a', effort: 'low',  impact: 'high' },  // do
    { id: 'b', effort: null,   impact: 'high' },  // unsorted
    { id: 'c', effort: 'high', impact: 'low'  },  // avoid
    { id: 'd',                                 },  // unsorted (no effort key)
    { id: 'e', effort: 'low',  impact: 'low'  },  // deprioritize
  ];
  const g = group(tasks);
  assert.deepEqual(g.unsorted.map((t) => t.id).sort(), ['b', 'd']);
});

test('a fully classified board has an empty unsorted tray', () => {
  const tasks = [
    { id: 'a', effort: 'low',  impact: 'high' },
    { id: 'b', effort: 'high', impact: 'low'  },
    { id: 'c', effort: 'low',  impact: 'low'  },
  ];
  const g = group(tasks);
  assert.equal(g.unsorted.length, 0, 'no unsorted cards');
});

/* ================================================================== */
/* Drag-to-classify: QUADRANT_DEFS carries the right effort/impact pair*/
/* ================================================================== */

test('QUADRANT_DEFS.do → effort:low, impact:high (drag onto DO sets the correct pair)', () => {
  assert.equal(QUADRANT_DEFS.do.effort, 'low');
  assert.equal(QUADRANT_DEFS.do.impact, 'high');
});

test('QUADRANT_DEFS.plan → effort:high, impact:high', () => {
  assert.equal(QUADRANT_DEFS.plan.effort, 'high');
  assert.equal(QUADRANT_DEFS.plan.impact, 'high');
});

test('QUADRANT_DEFS.avoid → effort:high, impact:low', () => {
  assert.equal(QUADRANT_DEFS.avoid.effort, 'high');
  assert.equal(QUADRANT_DEFS.avoid.impact, 'low');
});

test('QUADRANT_DEFS.deprioritize → effort:low, impact:low', () => {
  assert.equal(QUADRANT_DEFS.deprioritize.effort, 'low');
  assert.equal(QUADRANT_DEFS.deprioritize.impact, 'low');
});

test('dragging onto a quadrant and calling getQuadrant with those values returns that quadrant', () => {
  for (const [key, def] of Object.entries(QUADRANT_DEFS)) {
    const result = getQuadrant({ effort: def.effort, impact: def.impact });
    assert.equal(result, key, `${key}: QUADRANT_DEFS.${key} effort/impact must classify back to '${key}'`);
  }
});

/* ================================================================== */
/* Drag-to-unsorted: sends null for both effort AND impact (v0.5.0)   */
/* ================================================================== */

// Simulate the handleDrop unsorted path: the update sent to onClassify.
function unsortedUpdate() {
  return { effort: null, impact: null };
}

test('drag-to-unsorted sends effort:null (not undefined)', () => {
  const u = unsortedUpdate();
  assert.ok('effort' in u, 'effort key must be present');
  assert.equal(u.effort, null);
});

test('drag-to-unsorted sends impact:null (not undefined)', () => {
  const u = unsortedUpdate();
  assert.ok('impact' in u, 'impact key must be present');
  assert.equal(u.impact, null);
});

test('drag-to-unsorted sends both nulls (not undefined) — key-presence semantics', () => {
  const u = unsortedUpdate();
  assert.equal(JSON.stringify(u), '{"effort":null,"impact":null}');
});

// Simulate classifyTask (local path) coercion: `update.effort ?? null`
function applyLocalClassify(card, update) {
  const patch = {};
  if ('effort' in update) patch.effort = update.effort ?? null;
  if ('impact' in update) patch.impact = update.impact ?? null;
  return { ...card, ...patch };
}

test('local classifyTask coerces null effort to null (not undefined)', () => {
  const card = { id: 'a', effort: 'high', impact: 'low' };
  const result = applyLocalClassify(card, { effort: null, impact: null });
  assert.equal(result.effort, null);
  assert.equal(result.impact, null);
});

test('local classifyTask coerces undefined effort to null via ?? null', () => {
  const card = { id: 'a', effort: 'high', impact: 'low' };
  // undefined can arrive from old call sites; ?? null normalizes it to null
  const result = applyLocalClassify(card, { effort: undefined, impact: undefined });
  assert.equal(result.effort, null);
  assert.equal(result.impact, null);
});

test('unset (—) option sends null for that field — single-field clear', () => {
  // Simulates user selecting "—" in the effort select when effort was 'high'
  // onChange: e.target.value || null → '' || null → null
  const selectedValue = '';
  const newEffort = selectedValue || null;
  assert.equal(newEffort, null);
});

test('drag-to-unsorted result classifies as unsorted', () => {
  const u = unsortedUpdate();
  const card = { effort: u.effort, impact: u.impact };
  assert.equal(getQuadrant(card), 'unsorted');
});
