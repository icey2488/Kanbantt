import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * C5 — RECEIPT + LIVENESS GUARD. The watched set is the board-side
 * "mock/provider-wire" surface: the files whose content determines what the
 * mock advertises/returns (spine-mcp-test-server.js, its backing data model
 * card-store.js) and how the board's REAL MCP client speaks the wire
 * (spine-mcp-provider.js, its connection/polling wrapper mcp-connection.js).
 * A change to any of these can silently invalidate the last probe run's
 * verdict — that is exactly what the guard test (parity-receipt-guard.test.js,
 * in the ALWAYS-running default suite) exists to catch. Pinned by name AND
 * by count so renaming/moving this set can never make the guard pass
 * vacuously (an empty watched set would always digest-match trivially).
 *
 * RESIDUAL (see build report): this watches the BOARD side only. A spine-side
 * wire change (claunker-hermes/spine_server/server.py, spine/entity.py) is
 * NOT covered by this guard — a mirror guard in the spine repo is the later,
 * out-of-scope fix.
 */
export const WATCHED_PATHS = Object.freeze([
  'spine-mcp-test-server.js',
  'card-store.js',
  'spine-mcp-provider.js',
  'mcp-connection.js',
]);

export function computeWatchedPathDigest(baseDir = __dirname) {
  const hash = createHash('sha256');
  for (const rel of WATCHED_PATHS) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(baseDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export const RECEIPT_PATH = join(__dirname, 'parity-receipt.json');

export function writeReceipt({ timestamp, spine_sha, spine_dirty, board_sha, board_dirty, result }) {
  const receipt = {
    timestamp,
    spine_sha,
    spine_dirty,
    board_sha,
    board_dirty,
    result,
    watched_paths: WATCHED_PATHS,
    watched_path_digest: computeWatchedPathDigest(),
  };
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function readReceipt() {
  if (!existsSync(RECEIPT_PATH)) {
    throw new Error(`parity-receipt: no committed receipt at ${RECEIPT_PATH} — run the probe (node src/lib/parity-receipt-write.mjs) at least once`);
  }
  return JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
}
