/**
 * Module-level store singletons — the app's boot point, OUTSIDE the React tree.
 *
 * On first import (once per page load) this runs the one-time legacy migration,
 * then creates and loads the card store. Doing it at module scope is what makes
 * the in-memory store survive StrictMode's double-invoked renders and component
 * remounts — never construct the store inside a component body or effect.
 *
 * Migration is idempotent: the StrictMode/replay second pass hits its skip path.
 * A migration or schema_unsupported failure is captured in `bootError`; the app
 * renders a visible error state from it rather than ever showing a default board.
 */
import {
  createStore,
  runLegacyMigration,
  LEGACY_KEYS,
  STORAGE_KEY,
} from './card-store.js';

// LocalProvider actor, per the spec's Provider Parity Contract.
const ACTOR = { type: 'human', id: 'local' };

let store = null;
let bootError = null;

try {
  runLegacyMigration({ storage: localStorage, actor: ACTOR }); // idempotent
  store = createStore({ storage: localStorage, actor: ACTOR });
  store.load(); // may throw schema_unsupported / corrupt_blob
} catch (e) {
  bootError = { code: e?.code || 'unknown', message: e?.message || String(e) };
}

export { store, bootError, STORAGE_KEY };

// A frozen, referentially-stable empty snapshot so useSyncExternalStore has
// something safe to read when the store failed to boot.
const EMPTY = Object.freeze({
  schema_version: 1, seq: 0, cards: [], tags: [], columns: [], settings: {},
});

export const subscribe = (listener) =>
  store && !bootError ? store.subscribe(listener) : () => {};

export const getSnapshot = () =>
  store && !bootError ? store.getSnapshot() : EMPTY;

/**
 * Raw legacy keys (the natural backup), for the boot-error escape hatch: the
 * error screen's single action downloads these so no data is ever stranded.
 */
export function readLegacyDump() {
  const dump = {};
  for (const key of Object.values(LEGACY_KEYS)) {
    try { dump[key] = localStorage.getItem(key); } catch { dump[key] = null; }
  }
  return dump;
}
