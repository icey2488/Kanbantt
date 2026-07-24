/**
 * C3 — BOUNDARY PAIRS (seam-audit card 9aeca184, build 2). Every limit from
 * parity-budget.js, both assertion classes, at the documented write-boundary
 * caps (docs/kanbantt-mcp-spec.md §Card "Unmodeled / foreign fields";
 * concrete numbers in claunker-hermes/spine/entity.py).
 *
 * AT-LIMIT: accepted by BOTH targets AND self-consistent (byte-exact
 * read-back) on BOTH — the case C3 itself motivates: "a parity probe cannot
 * catch a bug both sides share... two targets that both silently truncate an
 * at-limit payload and both return 200 diff green forever." Self-consistency
 * is the only class that would catch that, so it is asserted here, not
 * skipped as redundant with parity.
 *
 * OVER-LIMIT: real enforces every one of these five caps (verified live,
 * build 2 survey); the mock enforces NONE of them (Finding 2 — confirmed by
 * reading spine-mcp-test-server.js's card_create/card_update dispatch: no
 * description/metadata length, key-count, depth, or byte check exists).
 * "Rejected by both, matching error shape AND status" is therefore
 * CONTESTED today — building it as a passing two-sided assertion would
 * fabricate a green that isn't real; building it as an always-red assertion
 * would break the required green suite. Per doctrine this ships UNBUILT: a
 * real-side-only rejection proof (uncontested, genuinely true) plus an
 * explicit assertion of the mock's actual (non-rejecting) behavior — the
 * SAME asymmetry-documentation pattern parity-coverage.test.js uses for F9.
 *
 * Run:  node --test src/lib/parity-boundary.test.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { spawnRealSpine, createMockTarget, stopMockTarget } from './parity-lifecycle.js';
import { sendWireStep, closeSession } from './parity-wire-step.js';
import { assertSelfConsistent } from './parity-assertions.js';
import {
  MAX_DESCRIPTION_LEN, MAX_METADATA_KEYS, MAX_METADATA_VALUE_LEN,
  MAX_METADATA_DEPTH, MAX_METADATA_BYTES,
} from './parity-budget.js';

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
function mintId() {
  idCounter += 1;
  return `66666666-6666-4666-8${String(idCounter).padStart(3, '0')}-666666666666`;
}

/** Python's `json.dumps(v, sort_keys=True)` byte length for a FLAT dict of
 * ASCII string values — the exact format the real spine's
 * `check_metadata_limits` measures against MAX_METADATA_BYTES. JSON string
 * escaping is identical to JS's for plain ASCII content, so this is exact,
 * not an approximation (verified live against the real spine during
 * build-2 calibration: 32768 accepted, 32769 rejected with that exact
 * number in the message). */
function pySortedJsonBytes(obj) {
  const keys = Object.keys(obj).sort();
  const inner = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(', ');
  return Buffer.byteLength(`{${inner}}`, 'utf8');
}

/** A flat `numKeys`-key metadata object whose Python-serialized size is
 * EXACTLY `targetBytes`, every value comfortably under MAX_METADATA_VALUE_LEN
 * so this exercises the BYTES cap in isolation, not the value-length cap. */
function metadataAtBytes(targetBytes, numKeys = 20) {
  const keys = Array.from({ length: numKeys }, (_, i) => `k${i}`);
  const obj = {};
  const base = Math.floor(targetBytes / numKeys / 2);
  for (const k of keys) obj[k] = 'x'.repeat(base);
  let bytes = pySortedJsonBytes(obj);
  let i = 0;
  while (bytes < targetBytes) { const k = keys[i % keys.length]; obj[k] += 'x'; bytes++; i++; }
  while (bytes > targetBytes) { const k = keys[i % keys.length]; if (obj[k].length > 0) { obj[k] = obj[k].slice(0, -1); bytes--; } i++; }
  const finalBytes = pySortedJsonBytes(obj);
  assert.equal(finalBytes, targetBytes, 'metadataAtBytes calibration');
  return obj;
}

async function createBoth(extra) {
  const id = mintId();
  const r = await sendWireStep(real, 'card_create', { card: { id, title: 'x', ...extra }, project_id: projA });
  const m = await sendWireStep(mock, 'card_create', { card: { id, title: 'x', ...extra }, project_id: projB });
  return { id, r, m };
}

/* ── description: MAX_DESCRIPTION_LEN (16384 chars) ── */

test('description AT-LIMIT (16384): accepted by both, self-consistent on both', async () => {
  const description = 'd'.repeat(MAX_DESCRIPTION_LEN);
  const { r, m } = await createBoth({ description });
  assert.equal(r.body.isError, undefined);
  assert.equal(m.body.isError, undefined);
  assertSelfConsistent('card_create', { description }, r.body.card, ['description']);
  assertSelfConsistent('card_create', { description }, m.body.card, ['description']);
});

test('description OVER-LIMIT (16385): real rejects (uncontested); mock accepts — Finding 2, unbuilt as a shared assertion', async () => {
  const description = 'd'.repeat(MAX_DESCRIPTION_LEN + 1);
  const { r, m } = await createBoth({ description });
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.match(r.body.message, new RegExp(String(MAX_DESCRIPTION_LEN)));
  assert.equal(m.body.isError, undefined, 'mock enforces no description length cap today — this is the finding, not a passing assertion');
});

/* ── metadata keys: MAX_METADATA_KEYS (24) ── */

test('metadata KEYS AT-LIMIT (24 foreign keys): accepted by both, self-consistent on both', async () => {
  const extra = {}; for (let i = 0; i < MAX_METADATA_KEYS; i++) extra[`k${i}`] = `v${i}`;
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, undefined);
  assert.equal(m.body.isError, undefined);
  const fields = Object.keys(extra);
  assertSelfConsistent('card_create', extra, r.body.card, fields);
  assertSelfConsistent('card_create', extra, m.body.card, fields);
});

test('metadata KEYS OVER-LIMIT (25): real rejects (uncontested); mock accepts — Finding 2, unbuilt as a shared assertion', async () => {
  const extra = {}; for (let i = 0; i < MAX_METADATA_KEYS + 1; i++) extra[`k${i}`] = `v${i}`;
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.match(r.body.message, new RegExp(String(MAX_METADATA_KEYS)));
  assert.equal(m.body.isError, undefined, 'mock enforces no metadata key-count cap today — this is the finding, not a passing assertion');
});

/* ── metadata value length: MAX_METADATA_VALUE_LEN (2048 chars, any depth) ── */

test('metadata VALUE-LEN AT-LIMIT (2048 chars): accepted by both, self-consistent on both', async () => {
  const extra = { k0: 'v'.repeat(MAX_METADATA_VALUE_LEN) };
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, undefined);
  assert.equal(m.body.isError, undefined);
  assertSelfConsistent('card_create', extra, r.body.card, ['k0']);
  assertSelfConsistent('card_create', extra, m.body.card, ['k0']);
});

test('metadata VALUE-LEN OVER-LIMIT (2049 chars): real rejects (uncontested); mock accepts — Finding 2, unbuilt as a shared assertion', async () => {
  const extra = { k0: 'v'.repeat(MAX_METADATA_VALUE_LEN + 1) };
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.match(r.body.message, new RegExp(String(MAX_METADATA_VALUE_LEN)));
  assert.equal(m.body.isError, undefined, 'mock enforces no metadata value-length cap today — this is the finding, not a passing assertion');
});

/* ── metadata depth: MAX_METADATA_DEPTH (4 — the metadata dict is level 1) ── */

test('metadata DEPTH AT-LIMIT (4): accepted by both, self-consistent on both', async () => {
  const extra = { nested: { L2: { L3: { L4: 'deep-value' } } } };
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, undefined);
  assert.equal(m.body.isError, undefined);
  assertSelfConsistent('card_create', extra, r.body.card, ['nested']);
  assertSelfConsistent('card_create', extra, m.body.card, ['nested']);
});

test('metadata DEPTH OVER-LIMIT (5): real rejects (uncontested); mock accepts — Finding 2, unbuilt as a shared assertion', async () => {
  const extra = { nested: { L2: { L3: { L4: { L5: 'x' } } } } };
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.match(r.body.message, new RegExp(String(MAX_METADATA_DEPTH)));
  assert.equal(m.body.isError, undefined, 'mock enforces no metadata depth cap today — this is the finding, not a passing assertion');
});

/* ── metadata total bytes: MAX_METADATA_BYTES (32768, Python json.dumps
 * sort_keys=True serialized size — the PRIMARY size guard) ── */

test('metadata BYTES AT-LIMIT (32768): accepted by both, self-consistent on both', async () => {
  const extra = metadataAtBytes(MAX_METADATA_BYTES, 20);
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, undefined);
  assert.equal(m.body.isError, undefined);
  const fields = Object.keys(extra);
  assertSelfConsistent('card_create', extra, r.body.card, fields);
  assertSelfConsistent('card_create', extra, m.body.card, fields);
});

test('metadata BYTES OVER-LIMIT (32769): real rejects (uncontested); mock accepts — Finding 2, unbuilt as a shared assertion', async () => {
  const extra = metadataAtBytes(MAX_METADATA_BYTES + 1, 20);
  const { r, m } = await createBoth(extra);
  assert.equal(r.body.isError, true);
  assert.equal(r.body.code, 'validation_failed');
  assert.match(r.body.message, new RegExp(`${MAX_METADATA_BYTES + 1} > ${MAX_METADATA_BYTES}`));
  assert.equal(m.body.isError, undefined, 'mock enforces no metadata byte-total cap today — this is the finding, not a passing assertion');
});
