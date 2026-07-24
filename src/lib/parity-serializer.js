/**
 * Stable, lossless serialization + content-type parsing for the mock-to-real
 * envelope-parity probe (seam-audit card 9aeca184, build 1: engine only).
 */

/** Recursively sort object keys (arrays keep their element order) so two
 * structurally identical payloads serialize to the same bytes regardless of
 * key-insertion order on either side of the wire. Never drops a key — the
 * LOSSLESS requirement (D3) lives here: this is a plain recursive walk, never
 * a schema parse, so an unmapped/unknown key rides through untouched. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** Stable JSON serialization for the byte diff (D2). */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/** Split a Content-Type header into (media-type, params) per RFC 7231 §3.1.1.5 —
 * media-type lowercased/trimmed; params lowercased-key, quote-stripped.
 * `application/json; charset=utf-8` -> { mediaType: 'application/json',
 * params: { charset: 'utf-8' } }. */
export function parseContentType(header) {
  if (typeof header !== 'string' || !header.trim()) return { mediaType: '', params: {} };
  const [typePart, ...rest] = header.split(';');
  const mediaType = typePart.trim().toLowerCase();
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (k) params[k] = v;
  }
  return { mediaType, params };
}

/** FINDING (recorded in the build report): the Streamable HTTP transport legally
 * answers a POST with EITHER a plain JSON body or a single SSE `event: message`
 * frame carrying the identical JSON-RPC envelope — a transport-ENCODING choice,
 * not a wire-semantics difference (kanbantt's BYO-SPINE.md documents both as
 * conforming). The board's mock harness forces JSON (enableJsonResponse:true);
 * the real spine's FastMCP server defaults to SSE with no request-time override
 * (server-constructed `json_response` flag). Diffing raw media-type strictly
 * here would red on transport choice alone, on literally every wire step, never
 * on an actual parity break — so this equivalence class is the ONE deliberate,
 * documented narrowing of D2's "media-type diffed strictly" rule. The raw
 * media-type is still captured verbatim in every StepResult for visibility. */
export const MCP_MESSAGE_MEDIA_TYPES = new Set(['application/json', 'text/event-stream']);

export function canonicalMediaType(mediaType) {
  return MCP_MESSAGE_MEDIA_TYPES.has(mediaType) ? 'mcp-message' : mediaType;
}
