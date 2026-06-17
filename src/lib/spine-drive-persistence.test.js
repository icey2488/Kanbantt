/**
 * Durable spine persistence port — survives-restart + convergence through the REAL
 * drive-sync controller, hermetic (in-memory stub Drive backend, no live network).
 * The port is the proven controller pointed at the spine file; convergence stays
 * in sync-merge.js (the port moves bytes only).
 *
 * Run:  node --test src/lib/spine-drive-persistence.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalize, blobHash } from './sync-merge.js';
import { STORAGE_KEY } from './card-store.js';
import { createSpineServer } from './spine-server.js';
import {
  createSpineDrivePersistence,
  SPINE_MARKER_KEY,
  isSpineBlob,
  isEmptySpineBlob,
} from './spine-drive-persistence.js';

/* ---- a shared in-memory Drive backend (the drive client interface) ---- */
function makeStubDrive() {
  const files = new Map(); // id -> { id, name, revisions: [{id, text}] }
  let nextId = 1, nextRev = 1;
  const headText = (f) => f.revisions[f.revisions.length - 1].text;
  return {
    _files: files,
    async listByName(name) {
      return [...files.values()].filter((f) => f.name === name).map((f) => ({ id: f.id, name: f.name }));
    },
    async create(name, content) {
      const id = `f${nextId++}`; const rev = `r${nextRev++}`;
      files.set(id, { id, name, revisions: [{ id: rev, text: content }] });
      return { id, headRevisionId: rev };
    },
    async read(fileId) { return { text: headText(files.get(fileId)) }; },
    async update(fileId, content) {
      const rev = `r${nextRev++}`;
      files.get(fileId).revisions.push({ id: rev, text: content });
      return { id: fileId, headRevisionId: rev };
    },
    async listRevisions(fileId) { return files.get(fileId).revisions.map((r) => ({ id: r.id, modifiedTime: r.id })); },
    async readRevision(fileId, revId) { return { text: files.get(fileId).revisions.find((r) => r.id === revId).text }; },
  };
}

function mkStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const signedIn = () => true;
const noopTimers = { schedule: () => 0, cancel: () => {} }; // staged writes fire on explicit flush()

function makePort(drive, storage = mkStorage()) {
  return createSpineDrivePersistence({ drive, storage, isSignedIn: signedIn, ...noopTimers });
}

/* ================================================================== */
/* Separate Drive file — hard                                          */
/* ================================================================== */

test('separate file: the spine port targets "claunker_spine_v1", never the board key', () => {
  const port = makePort(makeStubDrive());
  assert.equal(port.fileName, 'claunker_spine_v1');
  assert.notEqual(port.fileName, STORAGE_KEY);
  assert.equal(STORAGE_KEY, 'kanbantt_data_v1', 'board key (sanity)');
  assert.notEqual(SPINE_MARKER_KEY, 'kanbantt_sync_marker', 'spine marker is its own key, not the board marker');
});

/* ================================================================== */
/* First-ever load (no file) → create path → empty valid spine blob     */
/* ================================================================== */

test('first-ever load (no spine file) → create path → empty valid spine blob, server boots clean', async () => {
  const drive = makeStubDrive();
  const port = makePort(drive);
  const loaded = await port.start();
  assert.ok(isSpineBlob(loaded) && isEmptySpineBlob(loaded), 'empty valid spine blob');

  // the controller created the spine file (seeded with the empty blob)
  const named = await drive.listByName('claunker_spine_v1');
  assert.equal(named.length, 1, 'spine file created on first load');

  // the server boots clean over it
  const server = createSpineServer({ persistence: port });
  assert.deepEqual(server.getProjects(), []);
  assert.deepEqual(server.getTasks(undefined), []);
});

/* ================================================================== */
/* Survives restart THROUGH the real drive-sync port                    */
/* ================================================================== */

test('survives restart through the real port: write state, fresh server over the same Drive, state intact', async () => {
  const drive = makeStubDrive(); // the durable backend, shared across "restarts"

  // boot #1: write a dispatch lifecycle through the server
  const port1 = makePort(drive);
  await port1.start();
  const server1 = createSpineServer({ persistence: port1 });
  const p = server1.createProject({ name: 'Spine' });
  const t = server1.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  server1.setTier(t.id, 'tier-4', { expectedVersion: t.version });
  server1.ingestTaskState(t.id, 'running'); // → dispatched
  await port1.flush(); // durable write to Drive (shutdown flush)

  // "restart": a brand-new port (fresh marker storage → find-by-name) + fresh server
  const port2 = makePort(drive); // SAME Drive backend, NEW storage
  await port2.start();
  const server2 = createSpineServer({ persistence: port2 });

  const t2 = server2.getTask(t.id);
  assert.equal(t2.tier, 'tier-4', 'tier survived restart through Drive');
  assert.equal(t2.state, 'dispatched');
  assert.equal(t2.column, 'in_progress');
  assert.equal(server2.getProjects().length, 1);
  assert.equal(server2.getProjects()[0].name, 'Spine');
});

/* ================================================================== */
/* Convergence STILL in sync-merge — concurrent writes via the port     */
/* ================================================================== */

test('convergence: two servers over the same Drive reconcile via mergeBlobs (not the port) — both edits survive', async () => {
  const drive = makeStubDrive();

  // shared base on Drive
  const seedPort = makePort(drive);
  await seedPort.start();
  const seed = createSpineServer({ persistence: seedPort });
  const p = seed.createProject({ name: 'P' });
  const t = seed.createTask({ project_id: p.id, title: 'T', acceptance_criteria: 'x' });
  await seedPort.flush();

  // two clients both sync down the base (each its own marker storage)
  const portA = makePort(drive);
  const portB = makePort(drive);
  await portA.start();
  await portB.start();
  const serverA = createSpineServer({ persistence: portA });
  const serverB = createSpineServer({ persistence: portB });

  // divergent edits to the SAME task, staged locally (not yet pushed)
  serverA.setTier(t.id, 'tier-3');        // A
  serverB.ingestTaskState(t.id, 'running'); // B (→ dispatched)

  // B pushes first; then A reconciles — the controller's read sees both advanced
  // since the shared base and runs resolve()→mergeBlobs (in sync-merge, not here).
  await portB.flush();
  await portA.reconcile(); // A: merge(A, B) → applied locally + pushed to Drive
  await portB.reconcile(); // B: adopt the merged Drive head

  // converge: byte-identical canonical state on both clients
  assert.equal(canonicalize(portA.load()), canonicalize(portB.load()), 'both clients converge');
  assert.equal(blobHash(portA.load()), blobHash(portB.load()));

  // no clobber: both divergent edits survived (base + .conflict fork of the Task)
  const forks = portA.load().tasks.filter((x) => x.id === t.id || x.id.startsWith(t.id + '.conflict.'));
  assert.equal(forks.length, 2, 'both concurrent edits survive as forks');
});

/* ================================================================== */
/* Port stays dumb — no merge import, no projection import              */
/* ================================================================== */

test('port stays dumb: no merge call, no projection import (convergence lives in sync-merge)', () => {
  const src = readFileSync(new URL('./spine-drive-persistence.js', import.meta.url), 'utf8');
  assert.ok(!/mergeBlobs\s*\(/.test(src), 'the port never calls mergeBlobs — convergence stays in sync-merge.js');
  assert.ok(!/from '\.\/spine-mi3-restoration\.js'/.test(src), 'no MI-3 projection import');
  assert.ok(!/from '\.\/spine-projections\.js'/.test(src), 'no render/ingest projection import');
});
