import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createMcpTestServer } from './spine-mcp-test-server.js';

/**
 * D1 — HARNESS LIFECYCLE half of the two-step-category split: spawning the
 * real spine (temp DB, ephemeral port), resetting mock memory, teardown.
 * ASYMMETRIC BY NATURE, never diffed — nothing exported here returns a
 * StepResult ({ status, contentType, body }); only parity-wire-step.js does.
 * The mock's reset existing where the real spine has none is not a parity
 * violation because lifecycle is not a wire step.
 */

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port }, () => {
        sock.end();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`spine-unavailable: nothing listening on ${host}:${port} after ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

/** Spawn a freshly-provisioned real spine: temp DB, ephemeral port, a
 * throwaway Bearer token (never logged, never persisted, never the token of
 * any already-running spine — this never touches an existing process or its
 * default db). D6 — SPAWN DISCIPLINE: any failure (bad python path, process
 * exits before its port opens, port never opens) throws an explicit
 * spine-unavailable Error. There is no skip state. */
export async function spawnRealSpine({
  hermesRepoPath,
  pythonPath,
  readyTimeoutMs = 10_000,
} = {}) {
  if (!hermesRepoPath) throw new Error('spine-unavailable: hermesRepoPath is required');
  const resolvedPython = pythonPath || join(hermesRepoPath, '.venv', 'Scripts', 'python.exe');
  const dbDir = mkdtempSync(join(tmpdir(), 'spine_probe_'));
  const dbPath = join(dbDir, 'spine.db');
  const token = randomUUID();
  const host = '127.0.0.1';

  let port;
  try {
    port = await findFreePort();
  } catch (e) {
    rmSync(dbDir, { recursive: true, force: true });
    throw new Error(`spine-unavailable: could not reserve an ephemeral port: ${e.message}`, { cause: e });
  }

  const child = spawn(resolvedPython, ['-m', 'spine_server.server'], {
    cwd: hermesRepoPath,
    env: {
      ...process.env,
      CLAUNKER_SPINE_TOKEN: token,
      CLAUNKER_SPINE_DB: dbPath,
      CLAUNKER_SPINE_HOST: host,
      CLAUNKER_SPINE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  // A spawn failure (bad python path, ENOENT, EACCES) fires 'error', never
  // 'exit' — left unhandled it crashes the whole process instead of surfacing
  // as the D6 spine-unavailable rejection, so both events race the port wait.
  child.on('error', () => { /* observed via the race below; never left unhandled */ });

  try {
    await Promise.race([
      waitForPort(host, port, readyTimeoutMs),
      new Promise((_, reject) => {
        child.once('exit', (code, signal) => {
          reject(new Error(`spine-unavailable: real spine process exited before it opened its port (code=${code}, signal=${signal})`));
        });
        child.once('error', (err) => {
          reject(new Error(`spine-unavailable: could not spawn the real spine process: ${err.message}`, { cause: err }));
        });
      }),
    ]);
  } catch (e) {
    if (exited === null) { try { child.kill(); } catch { /* best effort */ } }
    rmSync(dbDir, { recursive: true, force: true });
    throw e;
  }

  return {
    kind: 'real',
    url: `http://${host}:${port}/mcp`,
    token,
    async stop() {
      if (exited === null) {
        child.kill();
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

/** The board's mock spine, in-memory (no port, no process, no temp dir). */
export function createMockTarget(opts = {}) {
  const server = createMcpTestServer(opts);
  return { kind: 'mock', url: server.url, fetchFn: server.fetchFn, _server: server };
}

/** "Resetting mock memory" (D1): close the old in-memory server and mint a
 * fresh one in its place, mutating `target` so any wire-step session bound to
 * it observes the new instance. There is no real-spine analogue for this call
 * — the real spine has no reset route, which is expected asymmetry, not a
 * parity gap. */
export async function resetMockTarget(target, opts = {}) {
  await target._server.close();
  const fresh = createMockTarget(opts);
  target.fetchFn = fresh.fetchFn;
  target.url = fresh.url;
  target._server = fresh._server;
  return target;
}

export async function stopMockTarget(target) {
  await target._server.close();
}
