/**
 * C5 — writes the committed parity receipt, but ONLY after every live-wire
 * probe file actually passes (real spine + mock, every case in this build:
 * the engine self-tests, the manifest union, the per-tool coverage, the
 * boundary pairs). A failing run exits non-zero and leaves the last-good
 * receipt in place — there is no partial-credit receipt.
 *
 * Run:  node src/lib/parity-receipt-write.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeReceipt } from './parity-receipt.js';
import { identityBlock } from './parity-identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

const PROBE_FILES = [
  'parity-probe.test.js',
  'parity-manifest.test.js',
  'parity-coverage.test.js',
  'parity-boundary.test.js',
].map((f) => join(__dirname, f));

const run = spawnSync(process.execPath, ['--test', ...PROBE_FILES], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (run.status !== 0) {
  console.error('\nparity-receipt-write: probe did NOT run green — receipt left untouched.');
  process.exit(run.status || 1);
}

const hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes';
const { board, spine } = identityBlock({ boardRepoPath: repoRoot, hermesRepoPath });

const receipt = writeReceipt({
  timestamp: new Date().toISOString(),
  spine_sha: spine.sha,
  spine_dirty: spine.dirty,
  board_sha: board.sha,
  board_dirty: board.dirty,
  result: 'green',
});

console.log('\nparity-receipt-write: wrote a green receipt:', receipt);
