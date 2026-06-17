/**
 * Durable spine persistence port — the production backing for spine-server's
 * load/save port, built on the LIVE-VERIFIED drive-sync controller pointed at the
 * SPINE file. This is PLUMBING: a SECOND instance of the proven controller, not a
 * new controller and not new merge.
 *
 *   - load()  → the local fast-read cell (R1: durable truth = Drive, local =
 *               derived). Populated from Drive by start() before the server reads.
 *   - save()  → stage the blob locally + schedule the controller's durable write
 *               (no-read-back, mutex-serialized). flush() forces it (e.g. shutdown).
 *
 * Convergence is NOT here — it stays in sync-merge.js. When two writers' blobs
 * reconcile, the controller's read path runs the proven convergent merge exactly
 * as the board does; this port only moves bytes (no merge import, no projection
 * import — enforced-by-absence, asserted in the test). The blob-shape predicates
 * are the spine's (projects/tasks/artifacts/escalations), passed to the SAME
 * controller so its reconcile policy serves the spine schema unchanged.
 *
 * Separate Drive file, hard: SPINE_FILE_NAME ('claunker_spine_v1') ≠ the card
 * board's 'kanbantt_data_v1', with its own marker/safety keys, so spine state and
 * board state are distinct lineages that never co-mingle.
 *
 * Collision / status taxonomy: INHERITED from drive-sync — a spine-state collision
 * is the same blocking user-choice as a board collision (resolveCollision), not a
 * reinvented one.
 */

import { createDriveSync, makeDriveClient } from './drive-sync.js';
import { SPINE_FILE_NAME, SPINE_SCHEMA_VERSION } from './spine-server.js';

export const SPINE_MARKER_KEY = 'claunker_spine_sync_marker';
export const SPINE_SAFETY_KEY = 'claunker_spine_sync_safety';

/** The empty spine blob the first-ever load (no Drive file yet) boots from. */
export const emptySpineBlob = () => ({
  schema_version: SPINE_SCHEMA_VERSION, seq: 0,
  projects: [], tasks: [], artifacts: [], escalations: [],
});

/** Structural spine-blob check (the controller's shape predicate for this file). */
export const isSpineBlob = (b) =>
  b != null && typeof b === 'object' &&
  Array.isArray(b.projects) && Array.isArray(b.tasks) &&
  Array.isArray(b.artifacts) && Array.isArray(b.escalations);

/** Emptiness check (a blank spine) — drives the controller's adopt/push short-circuit. */
export const isEmptySpineBlob = (b) =>
  isSpineBlob(b) &&
  b.projects.length === 0 && b.tasks.length === 0 &&
  b.artifacts.length === 0 && b.escalations.length === 0;

/**
 * @param {object} [opts]
 * @param {object} [opts.drive]      Drive client (defaults to the real fetch client)
 * @param {Storage}[opts.storage]    localStorage-like for the SPINE marker
 * @param {()=>boolean}[opts.isSignedIn]
 * @param {(fn,ms)=>any}[opts.schedule] / [opts.cancel] / [opts.debounceMs]
 */
export function createSpineDrivePersistence({ drive, storage, isSignedIn, schedule, cancel, debounceMs } = {}) {
  let cell = emptySpineBlob(); // local fast-read copy (durable truth lives in Drive)

  // A minimal store shim over the cell — the controller reads local via
  // getSnapshot and writes merged/adopted state back via applyBlob.
  const store = { getSnapshot: () => cell, subscribe: () => () => {} };

  const ctl = createDriveSync({
    store,
    applyBlob: (blob) => { cell = isSpineBlob(blob) ? blob : emptySpineBlob(); },
    drive: drive || makeDriveClient(),
    storage,
    isSignedIn,
    schedule, cancel, debounceMs,
    // point this instance at the SPINE file with the spine shape predicates:
    fileName: SPINE_FILE_NAME,
    markerKey: SPINE_MARKER_KEY,
    safetyKey: SPINE_SAFETY_KEY,
    isValidBlob: isSpineBlob,
    isEmptyBlob: isEmptySpineBlob,
  });

  return {
    fileName: SPINE_FILE_NAME,

    /** Hydrate the local cell from Drive (find-or-create-by-name) BEFORE the server
     *  reads it. First-ever load (no file) → the controller's create path seeds an
     *  empty spine blob; the cell stays the empty valid blob. */
    async start() {
      ctl.syncNow();
      await ctl.whenIdle();
      if (!isSpineBlob(cell)) cell = emptySpineBlob();
      return cell;
    },

    /* ---- the dumb load/save port spine-server hydrates from / persists through ---- */
    load() { return cell; },
    save(blob) { cell = blob; ctl.markDirty(); }, // stage + schedule the durable write

    /* ---- durability + reconcile controls (no merge here — it's the controller's) ---- */
    flush() { ctl.flush(); return ctl.whenIdle(); },     // force the staged write (shutdown / per-write durability)
    reconcile() { ctl.syncNow(); return ctl.whenIdle(); }, // read + reconcile against Drive (merge lives in sync-merge)
    whenIdle: ctl.whenIdle,

    /* ---- inherited collision / status taxonomy (same as the board) ---- */
    getStatus: ctl.getStatus,
    subscribeStatus: ctl.subscribeStatus,
    resolveCollision: ctl.resolveCollision,
    dispose: ctl.dispose,
  };
}
