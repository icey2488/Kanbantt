/**
 * Module-scope Drive-sync controller singleton — the boot wiring that connects the
 * proven transport (drive-sync.js) to the card store (store-instance.js), OUTSIDE
 * the React tree so it survives StrictMode remounts (same rationale as the store).
 *
 * It is INERT until start() (App calls that on sign-in + sync-enabled). Merely
 * constructing it has NO side effects: no network, no timers, no I/O. The board
 * renders entirely from local-first boot before this is ever touched; sync only
 * ever attaches afterward and never gates render.
 *
 * Wiring consumes ONLY the existing public surfaces — it modifies nothing:
 *   - local-blob source : the store itself ({ getSnapshot, subscribe })
 *   - apply path        : store.hydrate — the SOLE way external data enters the
 *                         store (validates + atomically swaps; throws on a
 *                         malformed blob, which the controller surfaces as error)
 *   - Drive I/O         : makeDriveClient() over auth.js's withToken
 */
import { createDriveSync, makeDriveClient } from './drive-sync.js';
import { store, bootError } from './store-instance.js';

export const driveSync =
  store && !bootError
    ? createDriveSync({
        store, // { getSnapshot, subscribe }
        applyBlob: (blob) => store.hydrate(blob), // hydrate is the sole apply path
        drive: makeDriveClient(),
        // storage (localStorage) and isSignedIn (auth.js) use their defaults.
      })
    : null;
