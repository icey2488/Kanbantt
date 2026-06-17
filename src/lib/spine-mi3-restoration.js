/**
 * MI-3 read-layer restoration (Drive spine projection) — PURE, merge-free.
 *
 * MI-3 (biconditional): Task projects as escalated/blocked  ⟺  it has >=1 LIVE
 * Escalation (resolved_at === null AND deleted_at === null).
 *
 * MI-3 is NOT merge-preserved and CANNOT be: enforcing the biconditional inside
 * sync-merge.js is the conditional relational logic R3 forbids (it would break
 * associativity / the convergence proof). So MI-3 is RESTORED at the READ LAYER:
 * given a CONVERGED raw blob (post sync-merge.js, including .conflict forks), this
 * module derives an unambiguous presentation state per Task WITHOUT mutating the
 * blob. This file adds NO logic to the merge.
 *
 * Totality is the property under test (see spine-mi3-restoration.test.js): for
 * EVERY converged shape a concurrent Escalation-resolution can produce, the rule
 * returns exactly one defined presentation state — never undefined, never a
 * throw, never two states — and it returns the state the biconditional requires,
 * reading across BOTH forks of a conflict-forked Task and across all of that
 * Task's Escalations (themselves possibly conflict-forked).
 */

/**
 * Rank over the SIX ratified spine lifecycle states (claunker-spine-schema-
 * ratified.md): created → tiered → dispatched → judged → delivered, with
 * 'escalated' as the human branch (co-located at the dispatch branch-point).
 * Used for the non-blocked projection: when there is NO live Escalation, an
 * 'escalated' raw fork is treated as resolved and remapped to 'dispatched' (its
 * substantive baseline, matching the entity layer's MI-2 default nextState), so
 * the projection takes the most-advanced live fork. Higher rank = more advanced.
 *
 * NOTE: 'in_progress' is NOT a spine state — it is a Kanbantt RENDER COLUMN
 * (dispatched/judged → in_progress), applied by the render projection
 * (spine-projections.js), never here. This rank table is the authoritative spine
 * enum; the prior 'in_progress' label was a placeholder, reconciled out.
 */
export const TASK_RANK = { created: 0, tiered: 1, dispatched: 2, escalated: 2, judged: 3, delivered: 4 };

/** Effective spine states the restoration rule can emit. 'escalated' is a real
 *  spine state (live-Escalation case); 'deleted' is a projection sentinel for a
 *  fully-tombstoned Task (not a lifecycle state). The render projection maps each
 *  to a Kanbantt column. */
export const EFFECTIVE_STATES = new Set([
  'deleted',
  'escalated',
  'created',
  'tiered',
  'dispatched',
  'judged',
  'delivered',
]);

/** Base id of a (possibly conflict-forked) entity id: strip ".conflict.<hash>". */
export function baseId(id) {
  const i = id.indexOf('.conflict.');
  return i === -1 ? id : id.slice(0, i);
}

const isLiveRow = (e) => e.resolved_at == null && e.deleted_at == null;

/**
 * Does the Task have a live Escalation? Escalation rows (including .conflict
 * forks) are grouped by base escalation id; an escalation is LIVE iff EVERY fork
 * of it is live (no fork resolved or tombstoned). Resolution / tombstone is a
 * TERMINAL action, so a concurrent non-resolving edit that forked the escalation
 * cannot resurrect the block. Returns true iff >=1 grouped escalation is live.
 *
 * This grouping reduction is the deterministic restoration choice that makes the
 * load-bearing case correct: a fork {live, resolved} reduces to NOT live.
 */
export function hasLiveEscalation(escalationsForTask) {
  const groups = new Map();
  for (const e of escalationsForTask || []) {
    const k = baseId(e.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const forks of groups.values()) {
    if (forks.every(isLiveRow)) return true;
  }
  return false;
}

/**
 * The restoration rule. Reads the CONVERGED raw state and returns exactly one
 * presentation state, deterministically, for every reachable converged shape.
 *
 * @param taskForks  ALL converged forks (base + .conflict copies) for ONE
 *                   logical Task id. (The requested `task` arg, generalized to
 *                   the fork-set so the rule reads across a conflict-forked Task.)
 * @param escalationsForTask  ALL Escalation rows whose task_id is that Task
 *                   (including their conflict forks).
 * @returns {'deleted'|'escalated'|'created'|'tiered'|'dispatched'|'judged'|'delivered'|string}
 *          an EFFECTIVE SPINE STATE (the render projection maps it to a column).
 */
export function resolveTaskLiveState(taskForks, escalationsForTask) {
  const liveForks = (taskForks || []).filter((t) => t.deleted_at == null);

  // (0) Every fork tombstoned → the Task is deleted (off-board). Precedence note:
  //     a PARTIAL delete (some fork still live) does NOT delete — it falls through
  //     so a live Escalation can still surface it as escalated.
  if (liveForks.length === 0) return 'deleted';

  // (1) MI-3: the effective state is 'escalated' IFF a live Escalation exists.
  if (hasLiveEscalation(escalationsForTask)) return 'escalated';

  // (2) Not blocked: any 'escalated' raw fork has NO live Escalation, so the
  //     escalation is over — treat it as resolved (remap to 'dispatched', its
  //     substantive baseline) and project the MOST-ADVANCED live fork.
  //     Deterministic: rank is a function of the (remapped) state, ties (only
  //     reachable among unknown states) break lexicographically, so the result is
  //     independent of fork order.
  let best = 'created';
  let bestRank = -1;
  for (const t of liveForks) {
    const s = t.state === 'escalated' ? 'dispatched' : (t.state ?? 'created');
    const r = Object.prototype.hasOwnProperty.call(TASK_RANK, s) ? TASK_RANK[s] : 0;
    if (r > bestRank || (r === bestRank && s < best)) {
      bestRank = r;
      best = s;
    }
  }
  return best;
}

/**
 * Convenience: slice a converged blob into (taskForks, escalationsForTask) for a
 * logical Task id and resolve. PURE read — never mutates the blob.
 */
export function projectTask(blob, taskId) {
  const taskForks = (blob.tasks || []).filter((t) => baseId(t.id) === taskId);
  const escalationsForTask = (blob.escalations || []).filter((e) => e.task_id === taskId);
  return resolveTaskLiveState(taskForks, escalationsForTask);
}
