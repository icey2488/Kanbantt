/**
 * C1 — MANIFEST UNION tests (seam-audit card 9aeca184, build 2: coverage).
 * Run:  node --test src/lib/parity-manifest.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffToolManifest, REAL_TOOL_COUNT_FLOOR } from './parity-manifest.js';
import { listTools, closeSession } from './parity-wire-step.js';
import { spawnRealSpine, createMockTarget, stopMockTarget } from './parity-lifecycle.js';

/* ── PURE-LOGIC PROOFS: no wire call, so these can never flake and always
 * stay green regardless of either target's live state. ── */

test('M1: identical manifests diff clean', () => {
  const d = diffToolManifest(['a', 'b'], ['a', 'b']);
  assert.equal(d.ok, true);
  assert.deepEqual(d.onlyA, []);
  assert.deepEqual(d.onlyB, []);
  assert.deepEqual(d.union, ['a', 'b']);
});

test('M2: a tool present on one side only reds the union diff', () => {
  const d = diffToolManifest(['a', 'b', 'mock_only'], ['a', 'b', 'real_only']);
  assert.equal(d.ok, false);
  assert.deepEqual(d.onlyA, ['mock_only']);
  assert.deepEqual(d.onlyB, ['real_only']);
});

test('M3: the floor rejects an empty tool list — cannot pass vacuously', () => {
  const d = diffToolManifest([], [], { floor: REAL_TOOL_COUNT_FLOOR });
  assert.equal(d.floorOk, false);
  assert.equal(d.floorCount, 0);
});

test('M3b: the floor rejects a truncated (below-floor) real list', () => {
  const tenTools = Array.from({ length: 10 }, (_, i) => `tool_${i}`);
  const d = diffToolManifest([], tenTools, { floor: REAL_TOOL_COUNT_FLOOR });
  assert.equal(d.floorOk, false);
});

test('M3c: the floor accepts a real list AT exactly the floor', () => {
  const elevenTools = Array.from({ length: REAL_TOOL_COUNT_FLOOR }, (_, i) => `tool_${i}`);
  const d = diffToolManifest([], elevenTools, { floor: REAL_TOOL_COUNT_FLOOR });
  assert.equal(d.floorOk, true);
});

/* ── LIVE FIXTURE: an in-memory mock configured to advertise ZERO tools,
 * fetched OVER THE WIRE (tools/list), proving the floor catches an empty
 * manifest from a real MCP round trip, not just a hand-built array. The
 * omitted set is derived from the mock's OWN normal advertisement (never a
 * hardcoded tool-name list here), so this fixture cannot drift stale as the
 * mock's tool set changes. ── */

test('M4: a live target advertising zero tools REDS on the floor', async () => {
  const normalMock = createMockTarget();
  const emptyMock = createMockTarget({ omitTools: await listTools(normalMock) });
  try {
    const tools = await listTools(emptyMock);
    assert.deepEqual(tools, []);
    const d = diffToolManifest([], tools, { floor: REAL_TOOL_COUNT_FLOOR });
    assert.equal(d.floorOk, false);
  } finally {
    await closeSession(normalMock);
    await closeSession(emptyMock);
    await stopMockTarget(normalMock);
    await stopMockTarget(emptyMock);
  }
});

/* ── LIVE, CURRENT-STATE PIN (Finding 1 — see build report). Obtains BOTH
 * manifests over the wire and PINS today's exact union diff, the same
 * discipline T4/T4b use for the mask inventory / register: any FUTURE drift
 * (a tool added or removed on either side) reds here immediately. This is
 * NOT a claim the manifests match — they do not, today, by 9 tools — it is a
 * faithful, exact record of the CURRENT gap so it cannot silently widen or
 * narrow unnoticed. Reconciling the gap itself (narrowing the mock's tool
 * set, or growing the real spine's) is an assertion-scope decision reserved
 * for the operator; seam-audit card 9aeca184's build 2 report surfaces it as
 * a finding rather than resolving it here. ── */

test('M5: live manifest union — pins the CURRENT real(11)-vs-mock(20) gap (Finding 1, unresolved)', async () => {
  const hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes';
  const real = await spawnRealSpine({ hermesRepoPath });
  const mock = createMockTarget();
  try {
    const realTools = await listTools(real);
    const mockTools = await listTools(mock);
    const d = diffToolManifest(mockTools, realTools, { floor: REAL_TOOL_COUNT_FLOOR, floorTarget: 'b' });

    assert.equal(d.floorOk, true, 'real spine tool count must clear the hardcoded floor');
    assert.deepEqual(realTools, [
      'board_get', 'card_archive', 'card_create', 'card_delete', 'card_list',
      'card_move', 'card_retier', 'card_unarchive', 'card_update',
      'escalation_resolve', 'project_list',
    ].sort());
    assert.deepEqual(d.onlyB, [], 'no tool is currently real-only');
    assert.deepEqual(d.onlyA, [
      'artifact_list', 'card_get', 'column_create', 'column_delete',
      'column_update', 'escalation_list', 'tag_create', 'tag_delete', 'tag_update',
    ].sort(), 'mock-only tools — the CURRENT, reported gap (Finding 1), not a ratified exemption');
    assert.equal(d.ok, false, 'the manifests do NOT match today; this pin proves the probe would catch it, not that it is fine');
  } finally {
    await closeSession(real);
    await closeSession(mock);
    await real.stop();
    await stopMockTarget(mock);
  }
});
