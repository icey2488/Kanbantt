/**
 * Claunker MCP spine SERVER — the method surface (Phase 2, Step 3 capstone).
 *
 * This is the SEAM, not new domain logic. It assembles the proven layers:
 *   - WRITES  route through the entity layer (spine-entities.js): MI-1, MI-2,
 *             tier write-once, R6 durable-ref are enforced THERE, not re-checked
 *             here. The server only adds the method-boundary version-token check.
 *   - READS   route through the projections (spine-projections.js +
 *             spine-mi3-restoration.js): every Task read is the EFFECTIVE state
 *             (resolveTaskLiveState), never raw Task.state. Render column is a
 *             pure function of that effective state.
 *   - PERSIST reuses the proven convergent merge (sync-merge.js mergeBlobs) over
 *             a Drive-file-per-blob persistence port. The spine blob is a SEPARATE
 *             Drive file from the Kanbantt board blob (distinct lineage); see
 *             SPINE_FILE_NAME below, asserted != card STORAGE_KEY.
 *
 * GOVERNED-WRITE is INHERITED, not performed here: every write the spine records
 * originated on the Hermes dispatch path, already tiered/authorized by the armed
 * classifier (Step 2a/2b). The spine server does NOT call the classifier and adds
 * NO tiering/authorization gate — it is a ledger of what the governed dispatch
 * produced. (If a gate ever feels needed here, that is the wrong layer — a finding.)
 *
 * Reference: Foundation 02 "Kanbantt: Data Provider Architecture & MCP
 * Specification" (the KanbanttProvider interface + the /mcp REST method shapes +
 * the CapabilityMap). DELIBERATE divergences from that v0.1.0 wire spec (the spec
 * predates the 2026-06-16 ratified spine schema) are flagged inline with
 * `DIVERGENCE:` and summarized in the build report — never silently deviated.
 */

import { mergeBlobs } from './sync-merge.js';
import { createSpineStore, SpineError, ARTIFACT_KINDS } from './spine-entities.js';
import { baseId, projectTask } from './spine-mi3-restoration.js';
import { ingestState, columnForState, KANBANTT_COLUMNS } from './spine-projections.js';

/** The spine's Drive file — a SEPARATE file from the Kanbantt board blob
 *  (card-store STORAGE_KEY === 'kanbantt_data_v1'). Distinct schema_version
 *  lineage; spine state never co-mingles with the board state. */
export const SPINE_FILE_NAME = 'claunker_spine_v1';
export const SPINE_SCHEMA_VERSION = 1;

/* ======================================================================== */
/* Persistence port — dumb load/save. Convergence lives in sync-merge.js,    */
/* never here (do NOT reintroduce merge logic in the port).                  */
/* ======================================================================== */

/**
 * In-memory persistence adapter (tests + the survives-restart / multi-client
 * harness). Production wiring points a drive-sync-style controller at
 * SPINE_FILE_NAME with this same load/save shape; the convergent merge is
 * sync-merge.js either way. `seed` lets a "second client" open over the SAME
 * persisted bytes a first server wrote.
 */
export function createMemoryPersistence(seed = null) {
  let text = seed == null ? null : (typeof seed === 'string' ? seed : JSON.stringify(seed));
  return {
    name: SPINE_FILE_NAME,
    load() { return text == null ? null : JSON.parse(text); },
    save(blob) { text = JSON.stringify(blob); },
    raw() { return text; },
  };
}

/* ======================================================================== */
/* Wire-render helpers (spine entity -> Foundation 02 wire shape)            */
/* ---------------------------------------------------------------------- */
/* Every rendered entity also carries `version` (the opaque token the client */
/* echoes back as the optimistic-concurrency expected-version) — a noted     */
/* extension; the v0.1.0 wire schema has no version field.                   */
/* ======================================================================== */

function renderProjectView(p) {
  return {
    id: p.id,
    name: p.name,
    // DIVERGENCE: spine Project is inert at v1 (no status axis); the wire
    // Project.status enum {active|paused|archived|shipped} has no spine source.
    status: 'active',
    version: p.version,
    created_at: p.created_at,
    deleted_at: p.deleted_at,
  };
}

function renderEscalationView(e) {
  return {
    id: e.id,
    task_id: e.task_id,
    // DIVERGENCE: spine field is `reason`; wire field is `question`. Both emitted.
    reason: e.reason,
    question: e.reason,
    control_diff: e.control_diff,
    // wire status is derived from resolved_at/deleted_at (pending|resolved).
    status: e.resolved_at == null && e.deleted_at == null ? 'pending' : 'resolved',
    // DIVERGENCE: v1 spine schema does not persist a human `resolution` string
    // (only resolved_at + control_diff). Surfaced as null, not fabricated.
    resolution: null,
    resolved_at: e.resolved_at,
    version: e.version,
    created_at: e.created_at,
  };
}

function renderArtifactView(a) {
  return {
    id: a.id,
    task_id: a.task_id,
    // DIVERGENCE: spine field is `kind` {diff|file|verdict|delivery}; wire field
    // is `type` {code|text|file|error}. Spine stores a durable `ref`, not inline
    // `output`. Spine-true fields are authoritative; wire aliases are best-effort.
    kind: a.kind,
    type: a.kind,
    ref: a.ref,
    output: a.ref,
    version: a.version,
    created_at: a.created_at,
  };
}

/* ======================================================================== */
/* The server                                                               */
/* ======================================================================== */

/**
 * @param {object}  [opts]
 * @param {object}  [opts.persistence]  { load(): blob|null, save(blob) } port.
 *                  Defaults to a fresh in-memory adapter. On construct, a
 *                  non-empty load() HYDRATES the store (survives restart).
 * @param {object}  [opts.deps]         { uuid, now } forwarded to createSpineStore.
 * @param {string}  [opts.serverName]   capability display name (default 'Claunker').
 */
export function createSpineServer({ persistence = createMemoryPersistence(), deps = {}, serverName = 'Claunker' } = {}) {
  const store = createSpineStore(deps);

  /* ---- blob hydrate / snapshot (the persistence seam) ----------------- */
  // store.getBlob() returns the LIVE internal blob; we splice persisted arrays
  // into it by reference so the entity layer's closures see the loaded state.
  function hydrate(blob) {
    if (!blob) return;
    const fresh = JSON.parse(JSON.stringify(blob));
    const b = store.getBlob();
    b.schema_version = fresh.schema_version ?? SPINE_SCHEMA_VERSION;
    b.seq = fresh.seq ?? 0;
    b.projects = fresh.projects || [];
    b.tasks = fresh.tasks || [];
    b.artifacts = fresh.artifacts || [];
    b.escalations = fresh.escalations || [];
  }
  const snapshot = () => JSON.parse(JSON.stringify(store.getBlob()));
  const persist = () => persistence.save(snapshot());

  // Hydrate from durable storage on construct — the survives-restart path.
  hydrate(persistence.load());

  /* ---- method-boundary version-token discipline ----------------------- */
  // Opaque, EQUALITY-ONLY (the same contract the merge holds for `version`).
  // A stale expected-version => reject the write; never silently apply it.
  // Opt-in: omit expectedVersion to skip the check (first-write / blind callers).
  function assertVersion(row, expectedVersion) {
    if (expectedVersion == null) return;
    if (!row || row.version !== expectedVersion) {
      throw new SpineError(
        'version_conflict',
        `stale version token for ${row ? row.id : '<missing>'}: expected ${JSON.stringify(expectedVersion)}, current ${JSON.stringify(row ? row.version : null)}`,
        { id: row ? row.id : null, expectedVersion, currentVersion: row ? row.version : null },
      );
    }
  }

  const blob = () => store.getBlob();
  const taskForks = (taskId) => blob().tasks.filter((t) => baseId(t.id) === taskId);
  const liveTaskForks = (taskId) => taskForks(taskId).filter((t) => t.deleted_at == null);

  // Representative row for a logical Task's static fields (the requested base id
  // if live, else any live fork, else any fork). Effective STATE comes from the
  // projection, never from this row's raw .state.
  function taskRepr(taskId) {
    const forks = taskForks(taskId);
    if (forks.length === 0) return null;
    const live = forks.filter((t) => t.deleted_at == null);
    return live.find((t) => t.id === taskId) || live[0] || forks[0];
  }

  function renderTaskView(taskId) {
    const repr = taskRepr(taskId);
    if (!repr) return null;
    const effective = projectTask(blob(), taskId); // MI-3 effective state (reads forks + escalations)
    const column = columnForState(effective);      // null iff effective === 'deleted' (off-board)
    return {
      id: taskId,
      project_id: repr.project_id,
      title: repr.title,
      acceptance_criteria: repr.acceptance_criteria,
      tier: repr.tier,
      // orchestration truth (post MI-3) + the board column it renders to:
      state: effective,
      column,
      // DIVERGENCE: wire Task.status enum is {queued|running|blocked|done|failed};
      // the RATIFIED render column enum is {todo|in_progress|blocked|done} (the
      // schema doc supersedes the v0.1.0 spec). We emit the ratified column as
      // `status` for spec-shape compatibility and flag the enum mismatch.
      status: column,
      version: repr.version,
      created_at: repr.created_at,
    };
  }

  /* ====================================================================== */
  /* CONNECTION                                                             */
  /* ====================================================================== */

  function getCapabilities() {
    return {
      server: { name: serverName, version: '1.0.0', schema_version: SPINE_SCHEMA_VERSION },
      capabilities: {
        projects: true,   // required
        tasks: true,      // required
        artifacts: true,
        escalations: true,
        realtime: false,  // no WebSocket in this seam (polling fallback per spec)
        corpus: false,    // v2
      },
    };
  }

  return {
    /* ---- connection ---- */
    connect() {
      hydrate(persistence.load());
      return { ok: true, capabilities: getCapabilities() };
    },
    disconnect() {
      persist(); // flush
      return { ok: true };
    },
    getCapabilities,

    /* ---- Projects ---- */
    getProjects() {
      return blob().projects.filter((p) => p.deleted_at == null).map(renderProjectView);
    },
    getProject(id) {
      const p = blob().projects.find((x) => x.id === id);
      if (!p) throw new SpineError('not_found', `Project ${id} not found`, { id });
      return renderProjectView(p);
    },
    createProject(input) {
      const p = store.addProject(input); // entity layer validates Project.name
      persist();
      return renderProjectView(p);
    },
    // DIVERGENCE: spine Project is inert at v1 — no field is mutable (no status,
    // no rename op in the data layer). updateProject is unsupported rather than
    // inventing an entity-layer write. Surfaced explicitly, not silently dropped.
    updateProject(id) {
      throw new SpineError('unsupported_update', `Project is inert at v1; no updatable fields for ${id}`, { id });
    },

    /* ---- Tasks ---- */
    getTasks(projectId, filters = {}) {
      const ids = new Set();
      for (const t of blob().tasks) {
        if (projectId != null && t.project_id !== projectId) continue;
        ids.add(baseId(t.id));
      }
      let views = [...ids].map(renderTaskView).filter((v) => v && v.column != null); // drop off-board (deleted)
      if (filters.status != null) views = views.filter((v) => v.status === filters.status);
      // DIVERGENCE: wire getTasks also filters by `agent` — the spine has no agent
      // axis (classification is `tier`); an agent filter is ignored (no-op).
      return views;
    },
    getTask(id) {
      const v = renderTaskView(id);
      if (!v) throw new SpineError('not_found', `Task ${id} not found`, { id });
      return v;
    },
    createTask(input, { expectedVersion } = {}) {
      // expectedVersion is meaningless on create; accepted for call-site uniformity.
      void expectedVersion;
      const t = store.addTask({
        project_id: input.project_id,
        title: input.title,
        state: input.state != null ? input.state : 'created',
        acceptance_criteria: input.acceptance_criteria,
        tier: input.tier != null ? input.tier : null,
      });
      persist();
      return renderTaskView(t.id);
    },
    // Router to the spine-legitimate Task writes (NOT a free-form field patch).
    updateTask(id, patch = {}, { expectedVersion } = {}) {
      assertVersion(taskRepr(id), expectedVersion);
      if ('tier' in patch) return this.setTier(id, patch.tier);
      if ('hermes_state' in patch) return this.ingestTaskState(id, patch.hermes_state);
      throw new SpineError('unsupported_update', `Task fields are recorded via setTier / ingest, not free patch (got ${JSON.stringify(Object.keys(patch))})`, { id, keys: Object.keys(patch) });
    },
    // cancelTask === DELETE /mcp/tasks/:id (tombstone).
    cancelTask(id, { expectedVersion } = {}) {
      assertVersion(taskRepr(id), expectedVersion);
      store.deleteTask(id);
      persist();
      return { ok: true };
    },

    /* ---- Task writes the orchestration domain needs (entity-layer ops) ---- */
    setTier(taskId, tier, { expectedVersion } = {}) {
      assertVersion(taskRepr(taskId), expectedVersion);
      store.setTier(taskId, tier); // entity layer enforces write-once
      persist();
      return renderTaskView(taskId);
    },
    // EXTENSION (not in Foundation 02): record a Hermes orchestration state through
    // the ingest projection. The board spec has no ingest — this is the deliberate
    // orchestration-domain method the user pre-authorized. Reads tier (ready/claimed
    // disambig) + delivery-Artifact presence (done disambig) via ingestState, then
    // records the computed spine state through the entity layer's setState.
    ingestTaskState(taskId, hermesState, { expectedVersion } = {}) {
      const repr = taskRepr(taskId);
      if (!repr) throw new SpineError('not_found', `Task ${taskId} not found`, { taskId });
      assertVersion(repr, expectedVersion);
      const artifactsForTask = blob().artifacts.filter((a) => a.task_id === taskId);
      const spineState = ingestState(hermesState, repr, artifactsForTask); // throws unknown_hermes_state
      store.setState(taskId, spineState);
      persist();
      return renderTaskView(taskId);
    },

    /* ---- Artifacts ---- */
    getArtifacts(taskId) {
      return blob().artifacts.filter((a) => a.task_id === taskId && a.deleted_at == null).map(renderArtifactView);
    },
    createArtifact(input) {
      // entity layer enforces MI-1 (no child on tombstoned Task) + R6 (durable ref).
      const a = store.addArtifact(input);
      persist();
      return renderArtifactView(a);
    },

    /* ---- Escalations ---- */
    getEscalations(filters = {}) {
      let rows = blob().escalations.filter((e) => e.deleted_at == null).map(renderEscalationView);
      if (filters.status != null) rows = rows.filter((e) => e.status === filters.status);
      return rows;
    },
    createEscalation(input) {
      const e = store.addEscalation(input); // MI-1 enforced
      persist();
      return renderEscalationView(e);
    },
    // resolveEscalation: PATCH /mcp/escalations/:id. Wire passes `resolution: string`;
    // the spine needs `nextState` (the lifecycle state to return the Task to). MI-2
    // (atomic single-write) is enforced by the entity layer.
    resolveEscalation(id, { nextState = 'dispatched', resolution, expectedVersion } = {}) {
      void resolution; // DIVERGENCE: v1 spine does not persist the resolution string.
      const e = blob().escalations.find((x) => x.id === id);
      assertVersion(e, expectedVersion);
      const r = store.resolveEscalation(id, { nextState }); // throws invalid_resolution_state / not_found / already_resolved
      persist();
      return { escalation: renderEscalationView(r.escalation), task: renderTaskView(r.task.id) };
    },

    /* ====================================================================== */
    /* CONVERGENCE through the method surface (multi-client)                  */
    /* ---------------------------------------------------------------------- */
    /* merge a remote spine blob (another client's persisted state) into local */
    /* via the PROVEN sync-merge.js — no new merge logic. Mirrors the drive-   */
    /* sync controller's merge step. Idempotent + order-independent (proven).  */
    /* ====================================================================== */
    merge(remoteBlob) {
      hydrate(mergeBlobs(snapshot(), remoteBlob));
      persist();
      return { ok: true };
    },

    /* ---- introspection (tests / wiring) ---- */
    getBlob: () => snapshot(),
    KANBANTT_COLUMNS,
    ARTIFACT_KINDS,
  };
}
