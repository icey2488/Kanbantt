/**
 * C5 — LIVENESS GUARD, in the DEFAULT board unit suite (matched by
 * `src/lib/*.test.js`, `npm test`'s glob — this file needs no real spine and
 * runs on every invocation). It proves the SOMETIMES-running probe
 * (parity-receipt-write.mjs, which needs a real spine) actually ran against
 * the CURRENT content of the watched mock/provider-wire files: it recomputes
 * their digest and reds the instant it differs from the committed receipt's
 * — i.e. one of those files changed since the last recorded green run.
 *
 * RESIDUAL (see build report): this watches the BOARD side of the wire only
 * (parity-receipt.js's WATCHED_PATHS). A spine-side change is invisible to
 * this guard; a mirror guard in the spine repo is the later fix.
 *
 * Run:  node --test src/lib/parity-receipt-guard.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WATCHED_PATHS, computeWatchedPathDigest, readReceipt } from './parity-receipt.js';

test('the watched path set is non-empty and pinned by count (an empty set cannot pass vacuously)', () => {
  assert.ok(WATCHED_PATHS.length > 0);
  assert.equal(WATCHED_PATHS.length, 4);
  assert.deepEqual([...WATCHED_PATHS].sort(), [
    'card-store.js', 'mcp-connection.js', 'spine-mcp-provider.js', 'spine-mcp-test-server.js',
  ].sort());
});

test('the watched mock/provider-wire files match the last recorded green probe run', () => {
  const receipt = readReceipt();
  assert.equal(receipt.result, 'green', 'the last recorded receipt was not itself a green run');
  const currentDigest = computeWatchedPathDigest();
  assert.equal(
    currentDigest,
    receipt.watched_path_digest,
    'a watched mock/provider-wire file changed since the last green parity-probe run — '
    + 're-run it (node src/lib/parity-receipt-write.mjs) before trusting mock-vs-real parity again',
  );
});
