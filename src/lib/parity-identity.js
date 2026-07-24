import { execFileSync } from 'node:child_process';

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** One repo's identity for the report's IDENTITY BLOCK (D7): commit SHA + dirty
 * flag. Dirty uses `git status --porcelain` non-empty — NOT `git diff --quiet`,
 * which misses a staged-but-uncommitted change (e.g. after a bare `git add .`). */
export function repoIdentity(cwd) {
  const sha = runGit(['rev-parse', 'HEAD'], cwd);
  const porcelain = runGit(['status', '--porcelain'], cwd);
  return { sha, dirty: porcelain.length > 0 };
}

/** The full IDENTITY BLOCK: spine repo + board repo, each independently. Path
 * defaults reflect this machine's current layout — Build 2 / CI should source
 * `hermesRepoPath` from an env var or config rather than this literal default. */
export function identityBlock({
  boardRepoPath = process.cwd(),
  hermesRepoPath = process.env.CLAUNKER_SPINE_REPO_PATH || 'C:\\Users\\Raide\\code\\claunker-hermes',
} = {}) {
  return {
    board: repoIdentity(boardRepoPath),
    spine: repoIdentity(hermesRepoPath),
  };
}
