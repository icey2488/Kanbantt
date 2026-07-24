/**
 * C2 — PER-TOOL COVERAGE (seam-audit card 9aeca184, build 2). One shared live
 * real-spine + mock pair for the whole file (spawning a fresh real spine per
 * test would cost ~1s/test); each test mints its own card id, so cases never
 * interfere. `COVERAGE_TABLE` accounts for all 20 manifest tools by
 * construction — the 9 mock-only tools (Finding 1, parity-manifest.test.js
 * M5) get NO live case here: there is no real-side counterpart to diff
 * against, so building one is impossible, not merely skipped.
 *
 * FINDINGS referenced below (full evidence + recommendation in the build
 * report, not restated per-test):
 *   F2  mock enforces none of the 5 write-boundary budget caps real enforces
 *   F3  mock's Card wire shape omits ~12 fields real's projection always emits
 *   F4  mock's `version` is a bare int; real's is a `N:hexhash` token
 *   F5  mock's default created_by/updated_by identity never matches real's
 *   F6  mock leaks an internal `seq` field onto the wire; real never has it
 *   F7  NOT_FOUND message wording differs (mock "no card X" / real "task 'X'
 *       does not exist") across every stateful card tool — code/meta match
 *   F8  CONFLICT message + meta.current shape differs (compounds F3-F6)
 *   F9  card_update: mock accepts patch.depends_on:null (stores literal
 *       null); real rejects it validation_failed — a mock-side spec gap
 *   F10 escalation_resolve: mock always succeeds, even for an unknown id;
 *       real returns not_found — no not_found path exists in the mock
 *   F13 card_list's sync_token is not in the mask inventory and byte-diffs
 *       on every comparison, even a trivially-matching empty snapshot
 *
 * Run:  node --test src/lib/parity-coverage.test.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnRealSpine, createMockTarget, stopMockTarget } from './parity-lifecycle.js';
import { sendWireStep, closeSession } from './parity-wire-step.js';
import { assertParity, assertSelfConsistent } from './parity-assertions.js';

const hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes';
const MOCK_PROJECT = { id: '22222222-2222-4222-8222-222222222222', name: 'probe-fixture', created_at: '2026-01-01T00:00:00.000Z' };

const real = await spawnRealSpine({ hermesRepoPath, seedProjects: ['probe-fixture'] });
const mock = createMockTarget({ projects: [MOCK_PROJECT] });
const projA = real.seededProjects[0].id;
const projB = MOCK_PROJECT.id;

after(async () => {
  await closeSession(real);
  await closeSession(mock);
  await real.stop();
  await stopMockTarget(mock);
});

let idCounter = 0;
/** A fresh v4-shaped, mask-valid id per case — client-minted (spec-legal) and
 * SHARED across both targets so an id echoed inside error message TEXT
 * (never masked) is identical on both sides, isolating whatever divergence
 * the case is actually testing from an incidental "different random id". */
function mintId() {
  idCounter += 1;
  return `55555555-5555-4555-8${String(idCounter).padStart(3, '0')}-555555555555`;
}

async function createOnBoth(id, card = { title: 'x' }) {
  const r = await sendWireStep(real, 'card_create', { card: { id, ...card }, project_id: projA });
  const m = await sendWireStep(mock, 'card_create', { card: { id, ...card }, project_id: projB });
  return { r, m };
}

async function readBack(target, id) {
  const res = await sendWireStep(target, 'card_list', { include_deleted: true, include_archived: true });
  return res.body.cards.find((c) => c.id === id);
}

async function currentVersion(target, id) {
  return (await readBack(target, id)).version;
}

/** The 20-tool manifest, pinned exactly as parity-manifest.test.js's M5 found
 * it live. `built` names the case this file actually exercises for a
 * SHARED tool; a mock-only tool carries `null` (Finding 1 — no real-side
 * counterpart, not merely an oversight). */
export const COVERAGE_TABLE = Object.freeze([
  { tool: 'board_get', shared: true, happy: 'RED (pre-existing, see parity-probe.test.js harness smoke)', error: 'n/a (no args)' },
  { tool: 'project_list', shared: true, happy: 'GREEN', error: 'n/a (pure enumeration read)' },
  { tool: 'card_list', shared: true, happy: 'GREEN (cards-only, empty snapshot) / RED (full response — F13)', error: 'n/a (pure read)' },
  { tool: 'card_create', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'GREEN (empty title)' },
  { tool: 'card_update', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'GREEN (malformed tier); RED (not_found F7, conflict F8, depends_on:null F9)' },
  { tool: 'card_move', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'RED (not_found F7)' },
  { tool: 'card_delete', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'RED (not_found F7)' },
  { tool: 'card_retier', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'GREEN (untiered); RED (not_found F7)' },
  { tool: 'card_archive', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'GREEN (already-archived); RED (not_found F7)' },
  { tool: 'card_unarchive', shared: true, happy: 'RED (F3,F4,F5,F6); self-consistency GREEN', error: 'GREEN (not-archived); RED (not_found F7)' },
  { tool: 'escalation_resolve', shared: true, happy: 'UNBUILT — needs real-side escalation seeding, out of build-2 time budget', error: 'RED (F10 — mock never 404s)' },
  { tool: 'card_get', shared: false, happy: 'UNBUILT — no real-side counterpart (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'column_create', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'column_update', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'column_delete', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'tag_create', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'tag_update', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'tag_delete', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'escalation_list', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
  { tool: 'artifact_list', shared: false, happy: 'UNBUILT (Finding 1)', error: 'UNBUILT (Finding 1)' },
]);

test('coverage table: all 20 manifest tools accounted for, 11 shared / 9 manifest-gap', () => {
  assert.equal(COVERAGE_TABLE.length, 20);
  assert.equal(COVERAGE_TABLE.filter((r) => r.shared).length, 11);
  assert.equal(COVERAGE_TABLE.filter((r) => !r.shared).length, 9);
});

/* ── project_list — GENUINELY GREEN happy path (no error variant: pure read) ── */

test('project_list: happy path parities once seeded with a valid uuid + timestamp', async () => {
  const r = await sendWireStep(real, 'project_list', {});
  const m = await sendWireStep(mock, 'project_list', {});
  assertParity('project_list', m, r); // created_at differs by real wall-clock ms — exempt (server-minted)
});

/* ── card_list — cards-only (scoped) parities empty; full response (sync_token) does not (F13) ── */

test('card_list: empty-snapshot cards array parities (sync_token excluded from this scoped diff)', async () => {
  const freshMock = createMockTarget({ projects: [MOCK_PROJECT] });
  try {
    const r = await sendWireStep(real, 'card_list', {});
    const m = await sendWireStep(freshMock, 'card_list', {});
    assert.deepEqual(r.body.cards, []);
    assert.deepEqual(m.body.cards, []);
    assertParity('card_list.cards', { ...m, body: { cards: m.body.cards } }, { ...r, body: { cards: r.body.cards } });
  } finally {
    await closeSession(freshMock);
    await stopMockTarget(freshMock);
  }
});

test('card_list: F13 — sync_token is unmasked and breaks the FULL response even on this same empty snapshot', async () => {
  const r = await sendWireStep(real, 'card_list', {});
  const m = await sendWireStep(mock, 'card_list', {});
  assert.throws(() => assertParity('card_list', m, r), /sync_token/);
});

/* ── card_create ── */

test('card_create: error shape parities (empty title -> validation_failed)', async () => {
  const id = mintId();
  const r = await sendWireStep(real, 'card_create', { card: { id, title: '' }, project_id: projA });
  const m = await sendWireStep(mock, 'card_create', { card: { id, title: '' }, project_id: projB });
  assertParity('card_create', m, r);
});

test('card_create: happy path is RED today (F3/F4/F5/F6 — pinned, not silently fixed)', async () => {
  const id = mintId();
  const { r, m } = await createOnBoth(id);
  assert.throws(() => assertParity('card_create', m, r));
});

test('card_create: self-consistency holds independently on EACH target (title survives its own round trip)', async () => {
  const id = mintId();
  const { r, m } = await createOnBoth(id, { title: 'hello' });
  assertSelfConsistent('card_create', { title: 'hello' }, r.body.card, ['title']);
  assertSelfConsistent('card_create', { title: 'hello' }, m.body.card, ['title']);
  const rBack = await readBack(real, id);
  const mBack = await readBack(mock, id);
  assertSelfConsistent('card_create.read-back', { title: 'hello' }, rBack, ['title']);
  assertSelfConsistent('card_create.read-back', { title: 'hello' }, mBack, ['title']);
});

/* ── card_update ── */

test('card_update: error shape parities (malformed tier)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_update', { id, patch: { tier: 'banana' }, expected_version: rVer });
  const m = await sendWireStep(mock, 'card_update', { id, patch: { tier: 'banana' }, expected_version: mVer });
  assertParity('card_update', m, r);
});

test('card_update: not_found is RED today — message wording differs (F7)', async () => {
  const id = mintId(); // never created
  const r = await sendWireStep(real, 'card_update', { id, patch: { title: 'y' }, expected_version: '1:0000000000000000' });
  const m = await sendWireStep(mock, 'card_update', { id, patch: { title: 'y' }, expected_version: 1 });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.code, 'not_found');
  assert.throws(() => assertParity('card_update', m, r));
});

test('card_update: conflict is RED today — message + meta.current shape differ (F8)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const r = await sendWireStep(real, 'card_update', { id, patch: { title: 'y' }, expected_version: '1:0000000000000000' });
  const m = await sendWireStep(mock, 'card_update', { id, patch: { title: 'y' }, expected_version: 999 });
  assert.equal(r.body.code, 'conflict');
  assert.equal(m.body.code, 'conflict');
  assert.throws(() => assertParity('card_update', m, r));
});

test('card_update: F9 — mock silently accepts patch.depends_on:null; real rejects it (validation_failed)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_update', { id, patch: { depends_on: null }, expected_version: rVer });
  const m = await sendWireStep(mock, 'card_update', { id, patch: { depends_on: null }, expected_version: mVer });
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.equal(m.body.isError, undefined, 'mock does NOT reject depends_on:null today — this is the finding, not a passing assertion');
});

test('card_update: self-consistency holds independently on EACH target (title survives its own round trip + read-back)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_update', { id, patch: { title: 'updated' }, expected_version: rVer });
  const m = await sendWireStep(mock, 'card_update', { id, patch: { title: 'updated' }, expected_version: mVer });
  assertSelfConsistent('card_update', { title: 'updated' }, r.body.card, ['title']);
  assertSelfConsistent('card_update', { title: 'updated' }, m.body.card, ['title']);
  assertSelfConsistent('card_update.read-back', { title: 'updated' }, await readBack(real, id), ['title']);
  assertSelfConsistent('card_update.read-back', { title: 'updated' }, await readBack(mock, id), ['title']);
});

/* ── card_move — column_id vocabulary differs (mock's UI columns vs real's
 * Task states, the SAME root cause as build-1's board_get finding), but the
 * mock's store never validates column_id against a known set, so a genuine
 * real STATE name is accepted verbatim on BOTH sides — sidestepping the
 * vocabulary gap for a real self-consistency proof, not papering over it. ── */

test('card_move: not_found is RED today — message wording differs (F7)', async () => {
  const id = mintId();
  const r = await sendWireStep(real, 'card_move', { id, column_id: 'tiered', order: 'm', expected_version: '1:0000000000000000' });
  const m = await sendWireStep(mock, 'card_move', { id, column_id: 'tiered', order: 'm', expected_version: 1 });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.code, 'not_found');
  assert.throws(() => assertParity('card_move', m, r));
});

test('card_move: self-consistency holds independently on EACH target', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_move', { id, column_id: 'tiered', order: 'm', expected_version: rVer });
  const m = await sendWireStep(mock, 'card_move', { id, column_id: 'tiered', order: 'm', expected_version: mVer });
  assertSelfConsistent('card_move', { column_id: 'tiered', order: 'm' }, r.body.card, ['column_id', 'order']);
  assertSelfConsistent('card_move', { column_id: 'tiered', order: 'm' }, m.body.card, ['column_id', 'order']);
});

/* ── card_delete ── */

test('card_delete: not_found is RED today — message wording differs (F7)', async () => {
  const id = mintId();
  const r = await sendWireStep(real, 'card_delete', { id, expected_version: '1:0000000000000000' });
  const m = await sendWireStep(mock, 'card_delete', { id, expected_version: 1 });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.code, 'not_found');
  assert.throws(() => assertParity('card_delete', m, r));
});

test('card_delete: self-consistency (tombstoned on EACH target independently, verified via read-back)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_delete', { id, expected_version: rVer });
  await sendWireStep(mock, 'card_delete', { id, expected_version: mVer });
  assert.ok((await readBack(real, id)).deleted_at);
  assert.ok((await readBack(mock, id)).deleted_at);
});

/* ── card_retier ── */

test('card_retier: error shape parities (untiered card)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_retier', { id, new_tier: 'tier:2', expected_version: rVer, reason: 'x' });
  const m = await sendWireStep(mock, 'card_retier', { id, new_tier: 'tier:2', expected_version: mVer, reason: 'x' });
  assertParity('card_retier', m, r);
});

test('card_retier: not_found is RED today — message wording differs (F7)', async () => {
  const id = mintId();
  const r = await sendWireStep(real, 'card_retier', { id, new_tier: 'tier:2', expected_version: '1:0000000000000000', reason: 'x' });
  const m = await sendWireStep(mock, 'card_retier', { id, new_tier: 'tier:2', expected_version: 1, reason: 'x' });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.code, 'not_found');
  assert.throws(() => assertParity('card_retier', m, r));
});

test('card_retier: self-consistency (tier tag set on EACH target independently)', async () => {
  const id = mintId();
  await createOnBoth(id);
  let rVer = await currentVersion(real, id);
  let mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_update', { id, patch: { tier: 'tier:1' }, expected_version: rVer });
  await sendWireStep(mock, 'card_update', { id, patch: { tier: 'tier:1' }, expected_version: mVer });
  rVer = await currentVersion(real, id);
  mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_retier', { id, new_tier: 'tier:2', expected_version: rVer, reason: 'promote' });
  await sendWireStep(mock, 'card_retier', { id, new_tier: 'tier:2', expected_version: mVer, reason: 'promote' });
  assert.ok((await readBack(real, id)).tags.includes('tier:2'));
  assert.ok((await readBack(mock, id)).tags.includes('tier:2'));
});

/* ── card_archive ── */

test('card_archive: error shape parities (already archived)', async () => {
  const id = mintId();
  await createOnBoth(id);
  let rVer = await currentVersion(real, id);
  let mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_archive', { id, expected_version: rVer });
  await sendWireStep(mock, 'card_archive', { id, expected_version: mVer });
  rVer = (await readBack(real, id)).version;
  mVer = (await readBack(mock, id)).version;
  const r = await sendWireStep(real, 'card_archive', { id, expected_version: rVer });
  const m = await sendWireStep(mock, 'card_archive', { id, expected_version: mVer });
  assertParity('card_archive', m, r);
});

test('card_archive: not_found is RED today — message wording differs (F7)', async () => {
  const id = mintId();
  const r = await sendWireStep(real, 'card_archive', { id, expected_version: '1:0000000000000000' });
  const m = await sendWireStep(mock, 'card_archive', { id, expected_version: 1 });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.code, 'not_found');
  assert.throws(() => assertParity('card_archive', m, r));
});

test('card_archive: self-consistency (archived_at set on EACH target independently)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_archive', { id, expected_version: rVer });
  await sendWireStep(mock, 'card_archive', { id, expected_version: mVer });
  assert.ok((await readBack(real, id)).archived_at);
  assert.ok((await readBack(mock, id)).archived_at);
});

/* ── card_unarchive ── */

test('card_unarchive: error shape parities (not archived)', async () => {
  const id = mintId();
  await createOnBoth(id);
  const rVer = await currentVersion(real, id);
  const mVer = await currentVersion(mock, id);
  const r = await sendWireStep(real, 'card_unarchive', { id, expected_version: rVer });
  const m = await sendWireStep(mock, 'card_unarchive', { id, expected_version: mVer });
  assertParity('card_unarchive', m, r);
});

test('card_unarchive: self-consistency (archived_at cleared on EACH target independently)', async () => {
  const id = mintId();
  await createOnBoth(id);
  let rVer = await currentVersion(real, id);
  let mVer = await currentVersion(mock, id);
  await sendWireStep(real, 'card_archive', { id, expected_version: rVer });
  await sendWireStep(mock, 'card_archive', { id, expected_version: mVer });
  rVer = (await readBack(real, id)).version;
  mVer = (await readBack(mock, id)).version;
  await sendWireStep(real, 'card_unarchive', { id, expected_version: rVer });
  await sendWireStep(mock, 'card_unarchive', { id, expected_version: mVer });
  assert.equal((await readBack(real, id)).archived_at, null);
  assert.equal((await readBack(mock, id)).archived_at, null);
});

/* ── escalation_resolve — happy path UNBUILT (needs real-side escalation
 * seeding infra; time-boxed out of build 2, see report). Error shape is
 * buildable and documents F10 directly. ── */

test('escalation_resolve: F10 — mock always succeeds on an unknown id; real returns not_found', async () => {
  const r = await sendWireStep(real, 'escalation_resolve', { id: 'nonexistent', resolution: 'approve', resolution_rationale: 'probe coverage' });
  const m = await sendWireStep(mock, 'escalation_resolve', { id: 'nonexistent', resolution: 'approve', resolution_rationale: 'probe coverage' });
  assert.equal(r.body.code, 'not_found');
  assert.equal(m.body.isError, undefined, 'mock has no not_found path for escalation_resolve today — this is the finding');
});
