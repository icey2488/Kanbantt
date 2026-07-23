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
 *   - { type, id }        (spine identity)  → null   (human or plain agent, no provenance)
 *   - { type, id, model?, effort?, job_id? }→ the provenance (agent mint)
 *   - unknown foreign keys                  → ignored, never an error (MCP interop:
 *                                              extra keys must not break our read path)
 *
 * Provenance is considered PRESENT iff at least one of `model` / `effort` is a
 * non-empty string — those are the chip's content. `actor` (the created_by `id`) and
 * `job_id` enrich the dialog block but do NOT, alone, surface a chip.
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
