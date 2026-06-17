/**
 * Claunker spine — four-entity DATA LAYER (entities + write-admission invariants).
 *
 * Per claunker-spine-schema-ratified.md. This is the data layer ONLY: the
 * in-memory representation, constructors, and write operations that produce a
 * blob the existing sync-merge.js consumes. NO MCP server, NO method surface, NO
 * Hermes-ingest / Kanbantt-render projections (next steps).
 *
 * Two layers of correctness, both at the CREATE/WRITE boundary (never in the
 * merge — the merge stays schema-dumb per R3):
 *   1. Schema shape: every entity carries id + opaque equality-only version +
 *      nullable deleted_at (the merge requires all three). Field constraints
 *      (state enum, kind enum, control_diff shape, durable ref) enforced here.
 *   2. Write-admission invariants MI-1 (zombie-append guard) and MI-2 (atomic
 *      Escalation resolution), plus tier write-once and the R6 durable-ref check.
 *
 * MI-3 (escalated ⟺ live Escalation) is NOT enforced here — it is read-layer-
 * restored by spine-mi3-restoration.js (already proven). No biconditional logic
 * lives in this module or in the merge.
 *
 * version policy: a FRESH unique token (uuid) is minted on every write. NOT an
 * incrementing counter — two clients incrementing from the same base would mint
 * the SAME counter value with different content, and the schema-dumb merge
 * (version compared for equality only) would treat them as identical and silently
 * drop one concurrent edit. A globally-unique token guarantees divergent writes
 * fork, which is what the convergence proof relies on.
 */

export const TASK_STATES = Object.freeze([
  'created', 'tiered', 'dispatched', 'judged', 'delivered', 'escalated',
]);
export const ARTIFACT_KINDS = Object.freeze(['diff', 'file', 'verdict', 'delivery']);

export class SpineError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SpineError';
    this.code = code;
    this.detail = detail;
  }
}

/* ====================================================================== */
/* R6 — durable-ref contract (fail-closed: REQUIRE a durable shape)        */
/* ---------------------------------------------------------------------- */
/* An Artifact.ref must point at a durable target (spine-owned Drive ref or */
/* a permanent URI — git commit hash, Drive file id). An executor-local     */
/* sandbox path (sandboxes/docker/<...>/workspace, /root, /workspace) dies   */
/* on abort, so a ref to it is a durable pointer to dead state — REJECT it.  */
/* Posture is allowlist (require durable), not denylist, so an unanticipated */
/* local shape fails closed rather than slipping minted.                     */
/* ====================================================================== */

// executor-local / non-durable shapes (rejected even if they sneak a scheme)
const FILE_SCHEME_RE = /^file:\/\//i;
const WINDOWS_LOCAL_RE = /^[a-zA-Z]:[\\/]/;             // C:\... or C:/...
const SANDBOX_BIND_RE = /(^|[\\/])sandboxes[\\/]docker[\\/]/i;
const POSIX_LOCALish_RE = /^\//;                        // any absolute POSIX path (/root, /workspace, ...)

// durable shapes
const GIT_HASH_RE = /^[0-9a-f]{7,40}$/i;                // bare git commit hash
const SCHEME_URI_RE = /^(https|gs|drive|git|ipfs|s3):\/\/[^\s]+$/i;
const PREFIXED_REF_RE = /^(git|drive):[A-Za-z0-9_.\/-]+$/i; // git:<hash>, drive:<fileId>

/** True iff `ref` is an accepted durable target. Bare ambiguous strings and any
 *  executor-local/sandbox/file path are rejected (fail-closed). */
export function isDurableRef(ref) {
  if (typeof ref !== 'string') return false;
  const r = ref.trim();
  if (r === '') return false;
  // hard-reject local/sandbox/file shapes first
  if (FILE_SCHEME_RE.test(r) || WINDOWS_LOCAL_RE.test(r) || POSIX_LOCALish_RE.test(r) || SANDBOX_BIND_RE.test(r)) {
    return false;
  }
  // require a recognized durable shape
  return GIT_HASH_RE.test(r) || SCHEME_URI_RE.test(r) || PREFIXED_REF_RE.test(r);
}

/** Throw SpineError('non_durable_ref') unless `ref` is durable. */
export function assertDurableRef(ref) {
  if (!isDurableRef(ref)) {
    throw new SpineError(
      'non_durable_ref',
      `Artifact.ref must be a durable target (git hash, drive:<id>, or permanent URI); ` +
        `rejected non-durable/executor-local ref ${JSON.stringify(ref)}`,
      { ref },
    );
  }
}

/* ====================================================================== */
/* Constructors — enforce schema-complete entities at creation             */
/* ====================================================================== */

const reqString = (v, field) => {
  if (typeof v !== 'string') {
    throw new SpineError('missing_field', `${field} is required and must be a string`, { field, value: v });
  }
  return v;
};

function base(deps, overrides = {}) {
  // Every entity carries id + version + deleted_at (merge requirement).
  return {
    id: overrides.id != null ? overrides.id : deps.uuid(),
    version: overrides.version != null ? overrides.version : deps.uuid(),
    deleted_at: null,
    created_at: overrides.created_at != null ? overrides.created_at : deps.iso(),
  };
}

export function newProject(input, deps) {
  return { ...base(deps, input), name: reqString(input.name, 'Project.name') };
}

export function newTask(input, deps) {
  const state = reqString(input.state, 'Task.state');
  if (!TASK_STATES.includes(state)) {
    throw new SpineError('invalid_state', `Task.state ${JSON.stringify(state)} not in lifecycle enum`, { state, allowed: TASK_STATES });
  }
  return {
    ...base(deps, input),
    project_id: reqString(input.project_id, 'Task.project_id'),
    title: reqString(input.title, 'Task.title'),
    state,
    tier: input.tier != null ? input.tier : null, // nullable; write-once enforced at setTier
    acceptance_criteria: reqString(input.acceptance_criteria, 'Task.acceptance_criteria'), // freeform string (v1)
  };
}

export function newArtifact(input, deps) {
  const kind = reqString(input.kind, 'Artifact.kind');
  if (!ARTIFACT_KINDS.includes(kind)) {
    throw new SpineError('invalid_kind', `Artifact.kind ${JSON.stringify(kind)} not enumerated`, { kind, allowed: ARTIFACT_KINDS });
  }
  assertDurableRef(input.ref); // R6
  return {
    ...base(deps, input),
    task_id: reqString(input.task_id, 'Artifact.task_id'),
    kind,
    ref: input.ref,
  };
}

/** control_diff: null OR {control_id:string, old_value:number, new_value:number, reduces_control:boolean}. */
function validateControlDiff(cd) {
  if (cd == null) return null;
  const ok =
    typeof cd === 'object' &&
    typeof cd.control_id === 'string' &&
    typeof cd.old_value === 'number' &&
    typeof cd.new_value === 'number' &&
    typeof cd.reduces_control === 'boolean';
  if (!ok) {
    throw new SpineError('invalid_control_diff', 'control_diff must be null or {control_id,old_value,new_value,reduces_control}', { control_diff: cd });
  }
  return { control_id: cd.control_id, old_value: cd.old_value, new_value: cd.new_value, reduces_control: cd.reduces_control };
}

export function newEscalation(input, deps) {
  return {
    ...base(deps, input),
    task_id: reqString(input.task_id, 'Escalation.task_id'),
    reason: reqString(input.reason, 'Escalation.reason'),
    control_diff: validateControlDiff(input.control_diff === undefined ? null : input.control_diff),
    resolved_at: null,
  };
}

/* ====================================================================== */
/* The store — holds one blob, applies write-admission invariants          */
/* ====================================================================== */

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]   clock (ms) — default Date.now
 * @param {() => string} [deps.uuid]  id/version minter — default crypto.randomUUID
 */
export function createSpineStore(deps = {}) {
  const now = deps.now || (() => Date.now());
  const uuid = deps.uuid || (() => globalThis.crypto.randomUUID());
  const d = { uuid, iso: () => new Date(now()).toISOString() };

  const blob = { schema_version: 1, seq: 0, projects: [], tasks: [], artifacts: [], escalations: [] };

  const findTask = (id) => blob.tasks.find((t) => t.id === id);
  const findEscalation = (id) => blob.escalations.find((e) => e.id === id);

  // MI-1: a NEW child may not be appended to a tombstoned parent Task. Only an
  // EXISTING+tombstoned parent is rejected; a missing parent is a plain dangling
  // ref (refs are plain, read-layer filters orphans) and is allowed.
  function assertParentNotTombstoned(task_id) {
    const parent = findTask(task_id);
    if (parent && parent.deleted_at != null) {
      throw new SpineError('zombie_append', `cannot append a child to tombstoned Task ${task_id} (MI-1)`, { task_id });
    }
  }

  return {
    getBlob: () => blob,

    addProject(input) {
      const p = newProject(input, d);
      blob.projects.push(p);
      return p;
    },

    addTask(input) {
      const t = newTask(input, d);
      blob.tasks.push(t);
      return t;
    },

    addArtifact(input) {
      assertParentNotTombstoned(reqString(input.task_id, 'Artifact.task_id')); // MI-1
      const a = newArtifact(input, d);
      blob.artifacts.push(a);
      return a;
    },

    addEscalation(input) {
      assertParentNotTombstoned(reqString(input.task_id, 'Escalation.task_id')); // MI-1
      const e = newEscalation(input, d);
      blob.escalations.push(e);
      return e;
    },

    /** Tombstone a Task (deleted_at set, fresh version). Needed for MI-1 and the
     *  merge tombstone lifecycle. */
    deleteTask(taskId) {
      const t = findTask(taskId);
      if (!t) throw new SpineError('not_found', `Task ${taskId} not found`, { taskId });
      t.deleted_at = d.iso();
      t.version = d.uuid();
      return t;
    },

    /** tier WRITE-ONCE: settable while null; changing a non-null tier is rejected. */
    setTier(taskId, tier) {
      if (tier == null) throw new SpineError('invalid_tier', 'tier must be non-null', { taskId, tier });
      const t = findTask(taskId);
      if (!t) throw new SpineError('not_found', `Task ${taskId} not found`, { taskId });
      if (t.tier != null) {
        throw new SpineError('tier_write_once', `Task.tier is write-once; ${taskId} already tiered ${JSON.stringify(t.tier)}`, { taskId, current: t.tier, attempted: tier });
      }
      t.tier = tier;
      t.version = d.uuid();
      return t;
    },

    /**
     * Record a lifecycle-state transition (the value the Hermes→spine ingest
     * projection computed, e.g. running→dispatched, done→delivered). Validates
     * the lifecycle ENUM only — there is deliberately NO transition state-machine:
     * the spine is a LEDGER of an already-governed dispatch, it does not re-govern
     * ordering (governance is inherited from the classifier on the dispatch path).
     * A tombstoned Task is not resurrectable. MI-3's escalated⟺live-Escalation
     * biconditional stays read-layer-restored (spine-mi3-restoration.js) — this
     * records the raw state; it does not enforce the biconditional.
     */
    setState(taskId, state) {
      if (!TASK_STATES.includes(state)) {
        throw new SpineError('invalid_state', `Task.state ${JSON.stringify(state)} not in lifecycle enum`, { state, allowed: TASK_STATES });
      }
      const t = findTask(taskId);
      if (!t) throw new SpineError('not_found', `Task ${taskId} not found`, { taskId });
      if (t.deleted_at != null) {
        throw new SpineError('closed_task', `cannot transition a tombstoned Task ${taskId}`, { taskId });
      }
      t.state = state;
      t.version = d.uuid();
      return t;
    },

    /**
     * MI-2: resolve an Escalation in ONE atomic blob write — set
     * Escalation.resolved_at AND transition the parent Task out of 'escalated'.
     * Validation runs BEFORE any mutation, so a rejection leaves BOTH untouched
     * (no torn "resolved escalation + still-escalated task"). nextState defaults
     * to 'dispatched' (back on the substantive lifecycle) and may not be
     * 'escalated'.
     */
    resolveEscalation(escalationId, { nextState = 'dispatched' } = {}) {
      // --- validate first (atomic: throw before mutating anything) ---
      if (!TASK_STATES.includes(nextState) || nextState === 'escalated') {
        throw new SpineError('invalid_resolution_state', `resolution nextState must be a non-escalated lifecycle state, got ${JSON.stringify(nextState)}`, { nextState });
      }
      const e = findEscalation(escalationId);
      if (!e) throw new SpineError('not_found', `Escalation ${escalationId} not found`, { escalationId });
      if (e.deleted_at != null) throw new SpineError('not_found', `Escalation ${escalationId} is tombstoned`, { escalationId });
      if (e.resolved_at != null) throw new SpineError('already_resolved', `Escalation ${escalationId} already resolved`, { escalationId });
      const t = findTask(e.task_id);
      if (!t) throw new SpineError('not_found', `parent Task ${e.task_id} not found for Escalation ${escalationId}`, { taskId: e.task_id });

      // --- apply BOTH mutations in one synchronous write (one persist) ---
      const ts = d.iso();
      e.resolved_at = ts;
      e.version = d.uuid();
      t.state = nextState;
      t.version = d.uuid();
      return { escalation: e, task: t };
    },
  };
}
