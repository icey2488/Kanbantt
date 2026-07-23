/**
 * Dispatch PROVENANCE reader — the "how was this card minted" metadata that rides
 * INSIDE `created_by` (spec v0.7.0), never as a top-level card field. That placement
 * is load-bearing: the card's own `effort`/`impact` are the Matrix WORK-SIZE axes, so
 * a top-level dispatch `effort`/`model` would collide with them. Provenance stays
 * namespaced under `created_by` and is READ-ONLY here — the board renders it, never
 * edits it (it is write-once at the mint).
 *
 * This reader tolerates EVERY shape `created_by` takes across providers, and never
 * throws:
 *
 *   - absent / null                         → null   (most cards)
 *   - a bare string actor (LocalProvider)   → null   (identity only, no provenance)
 *   - { type: 'human', ... }                → null   (human mint — NEVER provenance,
 *                                              even if stray model/effort keys ride along)
 *   - { type: 'agent', id }                 → null   (agent identity, no provenance)
 *   - { type: 'agent', id, model?, effort? }→ the provenance (agent mint)
 *   - unknown foreign keys                  → ignored, never an error (MCP interop:
 *                                              extra keys must not break our read path)
 *
 * THE TYPE IS THE GATE (spec v0.7.0). Provenance renders ONLY for an agent-typed
 * identity: `created_by.type === 'agent'`. This is deliberate. The spine re-stamps
 * identity from the authenticated credential and only MERGES the client's descriptive
 * sub-keys onto it, so a wire mint carrying `{type:'agent', model:'x'}` from a caller
 * authenticated as the human operator is stored as `{type:'human', id:'operator',
 * model:'x'}` — a card stamped human-minted that happens to carry a model. That is an
 * INCOHERENT audit record (a human mint has no reasoning model), and rendering a
 * dispatch chip on it would launder a human write as an agent dispatch. So presence of
 * `model`/`effort` is NECESSARY but NOT SUFFICIENT: the identity discriminator decides,
 * and a human-typed created_by renders NOTHING (no chip on the face, no dialog block)
 * regardless of what stray keys it carries.
 *
 * Given an agent-typed identity, provenance is considered PRESENT iff at least one of
 * `model` / `effort` is a non-empty string — those are the chip's content. `actor` (the
 * created_by `id`) and `job_id` enrich the dialog block but do NOT, alone, surface a chip.
 */

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Extract renderable provenance from a card's `created_by`, or null when there is
 * none. Returns `{ model, effort, actor, job_id }` with each entry a non-empty string
 * or null. The presence of the object itself is the render gate — a null return means
 * "human/plain card: render nothing" (no empty chip, no "unknown").
 */
export function readProvenance(createdBy) {
  if (!createdBy || typeof createdBy !== 'object' || Array.isArray(createdBy)) return null;
  // TYPE IS THE GATE: provenance renders ONLY for an agent-typed identity. A human-typed
  // (or type-less) created_by carrying stray model/effort keys is not valid provenance —
  // render nothing. See the header note on cyborg cards for why presence alone is unsafe.
  if (createdBy.type !== 'agent') return null;
  const model = nonEmptyString(createdBy.model);
  const effort = nonEmptyString(createdBy.effort);
  if (!model && !effort) return null; // identity-only / foreign object with no dispatch provenance
  return {
    model,
    effort,
    actor: nonEmptyString(createdBy.id),
    job_id: nonEmptyString(createdBy.job_id),
  };
}

/**
 * True iff a card carries renderable dispatch provenance. Thin predicate over
 * `readProvenance` for call sites that only gate on presence.
 */
export function hasProvenance(createdBy) {
  return readProvenance(createdBy) !== null;
}
