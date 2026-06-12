/**
 * Kanbantt — data schema & migration runner.
 *
 * The Drive store reads and writes a single JSON document. This module owns
 * its shape and version. When you change the shape, bump CURRENT_SCHEMA and
 * add a migration step.
 *
 * Shape:
 *   {
 *     schemaVersion: number,
 *     tasks: Task[],
 *     tags: Tag[],
 *     columns: Column[],
 *     // settings is reserved for future per-user prefs; theme stays in localStorage.
 *     settings: object,
 *   }
 *
 * Migrations run in sequence from the stored version up to CURRENT_SCHEMA.
 * Each step must be idempotent and safe to skip if its preconditions fail.
 */

export const CURRENT_SCHEMA = 1;

export const DEFAULT_COLUMNS = [
  { id: 'backlog', label: 'Backlog', accentKey: 'textDim' },
  { id: 'todo', label: 'To Do', accentKey: 'ice' },
  { id: 'doing', label: 'In Progress', accentKey: 'amber' },
  { id: 'done', label: 'Done', accentKey: 'mint' },
];

export const DEFAULT_TAGS = []; // No seeded tags in production — users define their own.

/** A fresh, empty app state. Used on first sign-in. */
export function emptyState() {
  return {
    schemaVersion: CURRENT_SCHEMA,
    tasks: [],
    tags: DEFAULT_TAGS,
    columns: DEFAULT_COLUMNS,
    settings: {},
  };
}

/* ------------------------------------------------------------------------ */
/* Migration pipeline                                                       */
/* ------------------------------------------------------------------------ */

/**
 * Migrate stored data up to CURRENT_SCHEMA. Returns a new object; doesn't mutate.
 * Unknown / future versions are accepted as-is (forward compatibility for
 * users who may have used a newer build on another device).
 */
export function migrate(stored) {
  let data = { ...stored };

  // Schema 0 → 1: introduce schemaVersion, fill missing top-level fields.
  // Older window.storage migration also lands here.
  if (data.schemaVersion === undefined || data.schemaVersion < 1) {
    data = {
      schemaVersion: 1,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      tags: Array.isArray(data.tags) ? data.tags : DEFAULT_TAGS,
      columns: Array.isArray(data.columns) && data.columns.length > 0 ? data.columns : DEFAULT_COLUMNS,
      settings: data.settings || {},
    };
  }

  // Future migrations go here:
  // if (data.schemaVersion < 2) { ... data.schemaVersion = 2; }

  return data;
}

/* ------------------------------------------------------------------------ */
/* One-time import from window.storage — RETIRED                            */
/* ------------------------------------------------------------------------ */

/**
 * RETIRED. Legacy import now lives in card-store.js `runLegacyMigration`, which
 * is the single source of truth for migrating the pre-Drive localStorage keys
 * into the v1 blob. The export is kept only so any lingering importer fails
 * loudly instead of silently running a stale, duplicate migration.
 */
export async function importFromWindowStorage() {
  throw new Error('Retired: legacy import now lives in card-store.js runLegacyMigration');
}
