/**
 * Compact display labels for dispatch-provenance model IDs (spec v0.7.0 `created_by.model`).
 * The raw ID (e.g. `claude-haiku-4-5-20251001`) is meant for the API, not a ~150px card
 * face — shown verbatim it either overflows the row or gets cut mid-string by CSS
 * ellipsis, landing on a truncated date suffix that tells the reader nothing.
 *
 * KNOWN Anthropic IDs: `claude-<family>-<version segments>[-<8-digit date>]` maps to
 * "<Family> <version, dot-joined>" — `claude-opus-4-8` → "Opus 4.8", `claude-haiku-4-5-
 * 20251001` → "Haiku 4.5" (the dated snapshot suffix is stripped; it identifies a
 * snapshot, not a different model, and is exactly the noise that was getting truncated
 * into view).
 *
 * UNKNOWN/foreign IDs (the MCP spec lets ANY caller stamp ANY string here) fall back to a
 * bounded, word-boundary-safe label: strip a recognized vendor prefix if present, title-
 * case each hyphen segment, and ellipsize at a segment boundary under MAX_LABEL_LEN —
 * never mid-word. Only a single pathological segment longer than the cap itself is hard-
 * truncated, since there is no earlier boundary to cut at.
 */

const VENDOR_PREFIXES = ['claude-', 'anthropic.', 'anthropic/'];
const KNOWN_FAMILIES = ['sonnet', 'opus', 'haiku', 'fable'];
const DATED_SUFFIX = /-\d{8}$/;
const MAX_LABEL_LEN = 18;

function stripVendorPrefix(id) {
  const lower = id.toLowerCase();
  const prefix = VENDOR_PREFIXES.find((p) => lower.startsWith(p));
  return prefix ? id.slice(prefix.length) : id;
}

function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Vendor-keyed treatment for the provenance chip's color (see App.jsx's CHIP_COLORS
 * orange/slate tokens): `'anthropic'` for a recognized VENDOR_PREFIXES match (this
 * stack minted the card), `'foreign'` for any OTHER non-empty model string — the MCP
 * spec lets any caller stamp any model id, so an unrecognized string is a real signal
 * ("not this stack"), not an error. Returns `null` when there is no model to key off
 * (effort-only provenance keeps the existing neutral chip treatment).
 */
export function provenanceChipTreatment(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const lower = model.trim().toLowerCase();
  return VENDOR_PREFIXES.some((p) => lower.startsWith(p)) ? 'anthropic' : 'foreign';
}

/**
 * Maps a dispatch-provenance model ID to a short display label, or null for an empty
 * input. Never returns a mid-word truncation — see module header for the two rules.
 */
export function formatModelLabel(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const stripped = stripVendorPrefix(model.trim()).replace(DATED_SUFFIX, '');
  const segments = stripped.split('-').filter(Boolean);
  if (segments.length === 0) return null;

  const [family, ...versionSegments] = segments;
  if (KNOWN_FAMILIES.includes(family.toLowerCase()) && versionSegments.every((s) => /^\d+$/.test(s))) {
    return versionSegments.length
      ? `${titleCase(family)} ${versionSegments.join('.')}`
      : titleCase(family);
  }

  const label = segments.map(titleCase).join(' ');
  if (label.length <= MAX_LABEL_LEN) return label;

  let bounded = '';
  for (const word of label.split(' ')) {
    const next = bounded ? `${bounded} ${word}` : word;
    if (next.length > MAX_LABEL_LEN - 1) break;
    bounded = next;
  }
  // No word fit at all (one giant segment) — hard-truncate as a last resort.
  return `${bounded || label.slice(0, MAX_LABEL_LEN - 1)}…`;
}
