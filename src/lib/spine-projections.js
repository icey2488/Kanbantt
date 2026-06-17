/**
 * Spine boundary PROJECTIONS — pure read-boundary functions, nothing stored.
 *
 * Per claunker-spine-schema-ratified.md "two-projection state boundary". Two
 * pure mappings, both adapting at a boundary (the MCP spec's "task-semantic
 * servers adapt at the boundary" rule applied at both ends):
 *
 *   PART B — INGEST  (Hermes → spine):   hermes_state → Task.state
 *   PART C — RENDER  (spine → Kanbantt): Task.state  → reserved column
 *
 * The column is NEVER stored — storing it would create the two-sources-of-truth
 * desync the schema rejects (a merge could leave state:judged with column:todo).
 *
 * CRITICAL (Part C): the render path reads the EFFECTIVE state from the converged
 * blob via the MI-3 restoration rule (resolveTaskLiveState), NOT the raw
 * Task.state. That is the whole point of the MI-3 proof: an escalated fork with
 * no live Escalation renders as its advanced column (e.g. done), never stuck in
 * blocked. Path: converged blob → resolveTaskLiveState → effective state → column.
 */

import { projectTask } from './spine-mi3-restoration.js';
import { SpineError } from './spine-entities.js';

/* ====================================================================== */
/* PART B — INGEST projection (Hermes → spine Task.state)                  */
/* ---------------------------------------------------------------------- */
/* The many-to-one rows are NOT dumb string swaps — they derive from        */
/* spine-side fields the spine already holds (write-once tier; presence of   */
/* a kind:delivery Artifact). This is ingest-boundary logic, no new field.  */
/* ====================================================================== */

/**
 * Map a Hermes orchestration state to the canonical spine Task.state.
 * @param hermesState  one of ready|claimed|running|blocked|done
 * @param task         the spine Task (read for `tier` on the ready/claimed row)
 * @param artifactsForTask  the Task's Artifacts (read for a kind:delivery receipt
 *                          on the done row). Default [].
 */
export function ingestState(hermesState, task, artifactsForTask = []) {
  switch (hermesState) {
    case 'ready':
    case 'claimed':
      // classified ⟺ tiered (ties to the write-once tier field)
      return task && task.tier != null ? 'tiered' : 'created';
    case 'running':
      return 'dispatched';
    case 'blocked':
      return 'escalated';
    case 'done':
      // delivered ⟺ a delivery-receipt Artifact exists (why verdict ≠ delivery)
      return (artifactsForTask || []).some((a) => a.kind === 'delivery' && a.deleted_at == null)
        ? 'delivered'
        : 'judged';
    default:
      throw new SpineError('unknown_hermes_state', `no spine ingest mapping for Hermes state ${JSON.stringify(hermesState)}`, { hermesState });
  }
}

/* ====================================================================== */
/* PART C — RENDER projection (spine Task.state → Kanbantt column)         */
/* ====================================================================== */

/** The four Kanbantt reserved columns. */
export const KANBANTT_COLUMNS = new Set(['todo', 'in_progress', 'blocked', 'done']);

const STATE_TO_COLUMN = {
  created: 'todo',
  tiered: 'todo',
  dispatched: 'in_progress',
  judged: 'in_progress',
  escalated: 'blocked', // fallback tray
  delivered: 'done',
};

/**
 * Pure map from an EFFECTIVE spine state to a Kanbantt column. 'deleted' (the
 * fully-tombstoned projection sentinel) returns null = off-board (not rendered).
 * An unknown state throws — the mapping is total over the ratified enum.
 */
export function columnForState(state) {
  if (state === 'deleted') return null;
  const col = STATE_TO_COLUMN[state];
  if (col === undefined) {
    throw new SpineError('unknown_state', `no Kanbantt column for spine state ${JSON.stringify(state)}`, { state });
  }
  return col;
}

/**
 * Render a Task (by id) from a CONVERGED blob to its Kanbantt column. Goes
 * through the MI-3 restoration rule to get the EFFECTIVE state (reading across
 * .conflict forks and the Task's Escalations) BEFORE mapping — never the raw
 * Task.state. Returns null for a fully-tombstoned (off-board) Task.
 */
export function renderColumn(blob, taskId) {
  const effective = projectTask(blob, taskId); // converged blob → effective spine state
  return columnForState(effective);
}
