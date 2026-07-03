/**
 * kanbantt_config reader — the single seam that points the board at a spine.
 *
 * Source of truth is `localStorage['kanbantt_config']` (the spec's config object,
 * docs/kanbantt-mcp-spec.md §Configuration). For a phone-ready build that has no
 * localStorage yet on first open, a build-time env bootstrap fills the MCP target
 * from Vite vars; anything in localStorage overrides the env baseline.
 *
 *   VITE_SPINE_URL          → mcp.url           (the running spine origin)
 *   VITE_SPINE_TOKEN        → mcp.auth_token    (optional Bearer; see §Auth)
 *   VITE_SPINE_DATA_SOURCE  → data_source       (local | mcp | auto; default auto)
 *   VITE_SPINE_POLL_MS      → poll_interval_ms  (optional)
 *
 * Shape returned matches what createMcpConnectionFromConfig consumes:
 *   { data_source, mcp: { url, auth_token }, poll_interval_ms,
 *     archive: { autoAgeDays: null|number, showArchived: boolean } }
 *
 * `archive` is the v0.4.0 client-behavior sub-key (no env bootstrap — it is a
 * per-device UI preference, defaulted here and overlaid field-by-field from the
 * stored config exactly like `mcp`): autoAgeDays drives the age-rule auto sweep
 * (null = off), showArchived the default-OFF visibility toggle.
 */

const CONFIG_KEY = 'kanbantt_config';

function envConfig() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const url = env.VITE_SPINE_URL;
  const cfg = { data_source: env.VITE_SPINE_DATA_SOURCE || 'auto', mcp: {} };
  if (url) cfg.mcp.url = url;
  if (env.VITE_SPINE_TOKEN) cfg.mcp.auth_token = env.VITE_SPINE_TOKEN;
  const pollMs = Number(env.VITE_SPINE_POLL_MS);
  if (Number.isFinite(pollMs) && pollMs > 0) cfg.poll_interval_ms = pollMs;
  return cfg;
}

function storedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // malformed config never blocks boot — fall back to env/local.
  }
}

/**
 * The effective config: env baseline with the stored config layered on top
 * (stored `mcp` fields win field-by-field, so a saved url/token overrides env).
 */
const ARCHIVE_DEFAULTS = { autoAgeDays: null, showArchived: false };

export function readKanbanttConfig() {
  const env = envConfig();
  const stored = storedConfig();
  if (!stored) return { ...env, archive: { ...ARCHIVE_DEFAULTS } };
  return {
    ...env,
    ...stored,
    mcp: { ...env.mcp, ...(stored.mcp || {}) },
    archive: { ...ARCHIVE_DEFAULTS, ...(stored.archive || {}) },
  };
}

/**
 * Whether to even stand up the MCP connection. Mirrors the controller's
 * `wantsMcp`: a url must be present and the source must not be pinned to local.
 * No target → the board stays purely local-first, unchanged.
 */
export function hasMcpTarget(config) {
  return !!(config && config.mcp && config.mcp.url) && config.data_source !== 'local';
}
