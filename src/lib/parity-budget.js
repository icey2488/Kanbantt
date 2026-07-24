/**
 * C4 — THE BUDGET CONSTANTS, one module-level block, sourced from the single
 * authoritative reference: claunker-hermes/spine/entity.py (the reference
 * spine's write-boundary admission caps — the concrete numbers the Kanbantt
 * MCP spec's prose describes at docs/kanbantt-mcp-spec.md §Card, "Unmodeled /
 * foreign fields"). Loosening any of these is a visible, deliberate edit here,
 * never a quiet change buried in a boundary test.
 *
 * This module does NOT add a spine endpoint and does NOT enforce anything by
 * itself — it is the single place parity-boundary.test.js reads its limits
 * from, so a spec bump is one edit, not a hunt through test fixtures.
 */

// entity.py:197 — the narrative Card body (Markdown), counted in characters.
export const MAX_DESCRIPTION_LEN = 16384;

// entity.py:276-279 — the preserved/unmodeled-foreign-key metadata budget
// (SEPARATE from and larger than the created_by provenance budget). Enforced
// RECURSIVELY at every depth/object by the reference spine, not top-level only.
export const MAX_METADATA_KEYS = 24; // per-object key fan-out, at EVERY depth
export const MAX_METADATA_VALUE_LEN = 2048; // chars per STRING value, at ANY depth
export const MAX_METADATA_DEPTH = 4; // metadata dict is level 1
export const MAX_METADATA_BYTES = 32768; // serialized-byte ceiling, the primary guard
