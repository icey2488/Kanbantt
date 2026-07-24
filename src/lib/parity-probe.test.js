/**
 * The probe's OWN tests (seam-audit card 9aeca184, build 1: engine only).
 * Every test asserts RED-when-violated — never green-on-the-happy-path — per
 * the ratified design. T1/T2/T3/T5/T6 feed synthetic StepResult fixtures
 * straight to the differ/masker (no live wire call needed to prove the engine
 * itself); only the harness-lifecycle smoke at the bottom makes a real call,
 * the "minimum viable single call" the build's scope boundary allows.
 *
 * Run:  node --test src/lib/parity-probe.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffStepResults } from './parity-differ.js';
import { assertParity, assertSelfConsistent } from './parity-assertions.js';
import { MASK_INVENTORY, SERVER_MINTED_TIMESTAMP_KEYS } from './parity-mask.js';
import { spawnRealSpine, createMockTarget, stopMockTarget } from './parity-lifecycle.js';
import { sendWireStep, closeSession } from './parity-wire-step.js';
import { identityBlock } from './parity-identity.js';
import { PARITY_REGISTER, getStaleEntries, printRegisterReport } from './parity-register.js';

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const VALID_VERSION = '3:abcdef0123456789';
const step = (status, contentType, body) => ({ status, contentType, body });
const withoutEntry = (id) => PARITY_REGISTER.filter((e) => e.id !== id);

// REPORTING: every probe run prints the register contents (KNOWN_DEBT loudly,
// with its finding card id) — `node --test` loading this file IS a probe run
// in this codebase's current shape (no separate report CLI exists yet).
printRegisterReport();

/* ── T1: MOCK-SIDE MUTANTS — the three historical drift shapes reintroduced.
 * These prove the DIFF ENGINE only (not forward coverage): each is a synthetic
 * fixture of the drift shape, not a claim any of these currently exist. ── */

test('T1a: tags:[] normalization — a mock omitting the tags key on an untiered card reds', () => {
  const real = step(200, 'application/json', { card: { id: VALID_ID, title: 'x', tags: [] } });
  const mockMutant = step(200, 'application/json', { card: { id: VALID_ID, title: 'x' } }); // tags key dropped
  const { ok, violations } = diffStepResults('card_get', real, mockMutant);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'payload'));
});

test('T1b: null-retier schema-layer shape — a domain-error mock reintroduction reds', () => {
  // Real: FastMCP's schema layer rejects a null new_tier BEFORE the tool body
  // runs — isError, no structuredContent at all.
  const real = step(200, 'application/json', { isError: true });
  // Mutant: the historical bug — mock answers with a domain-error envelope instead.
  const mockMutant = step(200, 'application/json', {
    isError: true, code: 'validation_failed', message: 'new_tier required', meta: { id: VALID_ID },
  });
  const { ok } = diffStepResults('card_retier', real, mockMutant);
  assert.equal(ok, false);
});

test('T1c: conflict payload meta.current vs meta.card reds', () => {
  const card = { id: VALID_ID, title: 'x', version: VALID_VERSION };
  const real = step(200, 'application/json', {
    isError: true, code: 'conflict', message: 'stale', meta: { current: card },
  });
  const mockMutant = step(200, 'application/json', {
    isError: true, code: 'conflict', message: 'stale', meta: { card }, // wrong key
  });
  const { ok } = diffStepResults('card_update', real, mockMutant);
  assert.equal(ok, false);
});

/* ── T2: SPINE-SIDE MUTANT — an unknown/unmapped key on ONE target only reds.
 * Proves the pipeline is LOSSLESS: a schema-stripping serializer would pass
 * this while being structurally blind. ── */

test('T2: an unmapped foreign key present on only one side reds', () => {
  const a = step(200, 'application/json', { card: { id: VALID_ID, some_future_field: 'x' } });
  const b = step(200, 'application/json', { card: { id: VALID_ID } });
  const { ok, violations } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'payload'));
});

/* ── T3: MASK-INTEGRITY ── */

test('T3a: a volatile-key format mismatch reds', () => {
  const a = step(200, 'application/json', { card: { version: 'not-a-real-token' } });
  const b = step(200, 'application/json', { card: { version: VALID_VERSION } });
  const { ok, violations } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'mask-format' && v.key === 'version'));
});

test('T3b: a volatile key present on one side, absent on the other, reds', () => {
  const a = step(200, 'application/json', { card: { version: VALID_VERSION } });
  const b = step(200, 'application/json', { card: {} });
  const { ok } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
});

/* ── T4: MASK-INVENTORY PIN — exact count + exact format names. Loosening the
 * mask is a visible edit to THIS test, never a quiet one-line change. ── */

test('T4: mask inventory is pinned to exactly 8 entries with these formats', () => {
  assert.equal(MASK_INVENTORY.length, 8);
  const shape = MASK_INVENTORY.map((e) => `${e.key}:${e.format}`).sort();
  assert.deepEqual(shape, [
    'archived_at:iso8601_or_null',
    'created_at:iso8601',
    'deleted_at:iso8601_or_null',
    'due:iso8601_or_null',
    'id:uuid',
    'resolved_at:iso8601_or_null',
    'updated_at:iso8601_or_null',
    'version:version_token',
  ].sort());
});

/* ── T4b: PARITY REGISTER PIN — exact entry count + exact disposition per
 * entry. Adding or reclassifying an entry is a visible, deliberate edit to
 * THIS test, never a quiet one-line change. ── */

test('T4b: the parity register is pinned to exactly 2 entries with these dispositions', () => {
  assert.equal(PARITY_REGISTER.length, 2);
  const shape = PARITY_REGISTER.map((e) => `${e.id}:${e.disposition}`).sort();
  assert.deepEqual(shape, [
    'content-type-json-vs-sse:KNOWN_DEBT',
    'timestamp-ms-z-vs-us-offset:RATIFIED_EQUIVALENT',
  ].sort());
});

/* ── T5: SELF-CONSISTENCY CONTRAST — a shared bug (both targets silently
 * mutate a stored write) stays parity-GREEN while self-consistency REDs. This
 * is the proof D4 does real work and is not a tautology. ── */

test('T5: parity stays green on a bug both targets share, self-consistency reds', () => {
  const sent = { title: 'Buy milk' };
  const mutated = { id: VALID_ID, title: 'Buy milk (mutated)' };
  const readBackA = step(200, 'application/json', { card: mutated });
  const readBackB = step(200, 'application/json', { card: mutated }); // identically wrong
  assert.doesNotThrow(() => assertParity('card_create_readback', readBackA, readBackB));
  assert.throws(() => assertSelfConsistent('card_create_readback', sent, mutated, ['title']));
});

/* ── T6: CONTENT-TYPE PARAM CONTRAST ── */

test('T6a: a charset-only content-type difference does not red', () => {
  const a = step(200, 'application/json; charset=utf-8', { ok: true });
  const b = step(200, 'application/json', { ok: true });
  assert.equal(diffStepResults('board_get', a, b).ok, true);
});

test('T6b: JSON/SSE reds UNLESS the register\'s content-type entry permits it', () => {
  const a = step(200, 'application/json', { ok: true });
  const b = step(200, 'text/event-stream', { ok: true });
  // With the default (ratified) register, entry "content-type-json-vs-sse"
  // (KNOWN_DEBT) is what permits this — never inherent differ correctness.
  assert.equal(diffStepResults('board_get', a, b).ok, true);
});

test('T6b-proof: with entry 2 removed, the SAME json-vs-SSE step REDs', () => {
  const a = step(200, 'application/json', { ok: true });
  const b = step(200, 'text/event-stream', { ok: true });
  const { ok, violations } = diffStepResults('board_get', a, b, {
    register: withoutEntry('content-type-json-vs-sse'),
  });
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'media-type'));
});

test('T6c: a genuinely different media-type reds regardless of the register', () => {
  const a = step(200, 'application/json', { ok: true });
  const b = step(200, 'text/plain', { ok: true });
  assert.equal(diffStepResults('board_get', a, b).ok, false);
});

/* ── T9: TIMESTAMP INSTANT-EQUIVALENCE — the register's entry 1, proven the
 * same way as entry 2: the tolerance is the register's doing, not the
 * differ's, and it never widens past "same instant". Re-polarized in build 2
 * per the operator ruling on seam-audit card 9aeca184: `created_at` is
 * SERVER-MINTED (two independent servers mint it at genuinely different
 * wall-clock moments in live operation — proven empirically during build 2's
 * survey), so it is EXEMPT from this paired check entirely (parity-mask.js's
 * SERVER_MINTED_TIMESTAMP_KEYS) — comparing its instant cross-target was the
 * conflated-category defect build 1 flagged. `due` is CLIENT-ECHOED (the
 * probe itself supplies it, so a genuine cross-target value divergence IS
 * meaningful) and is the field these fixtures now exercise; the pass/fail
 * shape of every T9 case is unchanged from build 1, only the field name is. ── */

test('T9a: mock ms+Z vs real µs+offset at the SAME instant does not red (due — client-echoed)', () => {
  const a = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.789Z' } });
  const b = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.789012+00:00' } });
  assert.equal(diffStepResults('card_get', a, b).ok, true);
});

test('T9a-proof: with entry 1 removed, that SAME cross-format pair REDs', () => {
  const a = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.789Z' } });
  const b = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.789012+00:00' } });
  const { ok, violations } = diffStepResults('card_get', a, b, {
    register: withoutEntry('timestamp-ms-z-vs-us-offset'),
  });
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'timestamp-instant'));
});

test('T9b: two ms+Z timestamps at DIFFERENT instants still red, entry 1 present (due — client-echoed)', () => {
  const a = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.789Z' } });
  const b = step(200, 'application/json', { card: { due: '2026-07-24T12:34:57.000Z' } });
  const { ok, violations } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'timestamp-instant'));
});

test('T9c: two µs+offset timestamps at DIFFERENT instants still red, entry 1 present (due — client-echoed)', () => {
  const a = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.000001+00:00' } });
  const b = step(200, 'application/json', { card: { due: '2026-07-24T12:34:56.999999+00:00' } });
  const { ok, violations } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'timestamp-instant'));
});

/* ── T10: SERVER-MINTED EXEMPTION (build 2 — the ruling's actual fix). A
 * DIFFERENT-instant pair on a server-minted key must NEVER red, cross-format
 * or same-format, because two independent servers minting their OWN
 * timestamp at genuinely different wall-clock moments is not a divergence at
 * all — it is guaranteed, every live run. This is the failure mode build 1's
 * T9b/T9c (pre-repolarization) would have wrongly flagged had they targeted
 * `created_at`: a live board_get/card_create against a real spine + mock
 * spawned moments apart would red on timing alone, forever, on every run. ── */

test('T10a: different-instant SAME-format created_at (SERVER-MINTED) does not red', () => {
  const a = step(200, 'application/json', { card: { created_at: '2026-07-24T12:34:56.789Z' } });
  const b = step(200, 'application/json', { card: { created_at: '2026-07-24T12:34:59.123Z' } });
  assert.equal(diffStepResults('card_get', a, b).ok, true);
});

test('T10b: different-instant CROSS-format created_at (SERVER-MINTED) does not red', () => {
  const a = step(200, 'application/json', { card: { created_at: '2026-07-24T12:34:56.789Z' } });
  const b = step(200, 'application/json', { card: { created_at: '2026-07-24T12:35:10.000001+00:00' } });
  assert.equal(diffStepResults('card_get', a, b).ok, true);
});

test('T10c: every SERVER_MINTED_TIMESTAMP_KEYS entry is exempt, not just created_at', () => {
  for (const key of SERVER_MINTED_TIMESTAMP_KEYS) {
    const a = step(200, 'application/json', { card: { [key]: '2026-07-24T12:34:56.789Z' } });
    const b = step(200, 'application/json', { card: { [key]: '2027-01-01T00:00:00.000Z' } });
    assert.equal(diffStepResults('card_get', a, b).ok, true, `${key} must be exempt`);
  }
});

test('T10d: a genuine mask-format violation on a server-minted key still reds — exemption is instant-only, not a free pass', () => {
  const a = step(200, 'application/json', { card: { created_at: 'not-a-timestamp' } });
  const b = step(200, 'application/json', { card: { created_at: '2026-07-24T12:34:56.789Z' } });
  const { ok, violations } = diffStepResults('card_get', a, b);
  assert.equal(ok, false);
  assert.ok(violations.some((v) => v.kind === 'mask-format' && v.key === 'created_at'));
});

/* ── harness-lifecycle smoke: the minimum viable single real wire call,
 * proving spawn (temp DB, ephemeral port) + a live board_get actually works
 * end to end, before build 2 depends on it. Still red-on-violation, not a
 * bare happy-path check: the mock's board() serves the LocalProvider's
 * generic kanban columns while the real spine's board_get serves its
 * Task-state columns — a genuine, currently-expected divergence (see build
 * report) this asserts the engine actually catches. ── */

test('harness smoke: spawn real spine + mock target, board_get parity reds on the current real divergence', async () => {
  const hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes';
  const real = await spawnRealSpine({ hermesRepoPath });
  const mock = createMockTarget();
  try {
    const realResult = await sendWireStep(real, 'board_get', {});
    const mockResult = await sendWireStep(mock, 'board_get', {});
    assert.equal(realResult.status, 200);
    assert.equal(mockResult.status, 200);
    assert.throws(() => assertParity('board_get', mockResult, realResult));
  } finally {
    await closeSession(real);
    await closeSession(mock);
    await real.stop();
    await stopMockTarget(mock);
  }
});

test('identityBlock reports a sha + dirty flag for both repos', () => {
  const hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes';
  const block = identityBlock({ hermesRepoPath });
  assert.match(block.board.sha, /^[0-9a-f]{40}$/);
  assert.match(block.spine.sha, /^[0-9a-f]{40}$/);
  assert.equal(typeof block.board.dirty, 'boolean');
  assert.equal(typeof block.spine.dirty, 'boolean');
});

/* ── STALENESS: any register entry matching zero observed divergences across
 * this run is dead weight, never silently carried. Runs LAST so every prior
 * test (T6b, T9a) has had its chance to exercise both entries via the
 * default register. ── */

test('register hygiene: no entry is stale after this run', () => {
  const stale = getStaleEntries();
  assert.deepEqual(stale.map((e) => e.id), []);
});
