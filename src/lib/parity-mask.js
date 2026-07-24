/**
 * The mask discipline (D3): a volatile key is type-asserted against a pinned
 * expected FORMAT on BOTH sides, then replaced with a mask token before the
 * diff — NEVER deleted. A format violation is its own red, checked and
 * reported independently of the later payload byte-diff. `null` on a nullable
 * entry is never masked (D3: "null vs absent is always significant" — masking
 * a real null into the same token as a set value would erase exactly the
 * distinction the probe exists to catch).
 *
 * PINNED INVENTORY — a single module-level block by design (D3): loosening a
 * mask (adding a key, widening a regex) is a visible, deliberate edit here,
 * never a quiet one-line change buried in the differ. parity-probe.test.js
 * (T4) pins this list's exact entry count and each entry's exact format name.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_TOKEN_RE = /^\d+:[0-9a-f]{16}$/;
// Generic ISO-8601 (date + time + optional fraction + Z-or-offset) — FORMAT
// validity only. Whether two differently-formatted-but-both-valid timestamps
// are tolerated as equivalent is NOT this mask's call: that is the parity
// register's job (parity-register.js), consulted by the differ via
// findTimestampDivergences below. This mask never silently treats two
// differing raw values as identical.
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const MASK_TOKEN = (format) => `‹MASKED:${format}›`;
const isNullable = (entry) => entry.format.endsWith('_or_null');

export const MASK_INVENTORY = Object.freeze([
  Object.freeze({ key: 'id', format: 'uuid', test: (v) => UUID_RE.test(v) }),
  Object.freeze({ key: 'version', format: 'version_token', test: (v) => VERSION_TOKEN_RE.test(v) }),
  Object.freeze({ key: 'created_at', format: 'iso8601', test: (v) => ISO8601_RE.test(v) }),
  Object.freeze({ key: 'updated_at', format: 'iso8601_or_null', test: (v) => ISO8601_RE.test(v) }),
  Object.freeze({ key: 'archived_at', format: 'iso8601_or_null', test: (v) => ISO8601_RE.test(v) }),
  Object.freeze({ key: 'deleted_at', format: 'iso8601_or_null', test: (v) => ISO8601_RE.test(v) }),
  Object.freeze({ key: 'due', format: 'iso8601_or_null', test: (v) => ISO8601_RE.test(v) }),
  Object.freeze({ key: 'resolved_at', format: 'iso8601_or_null', test: (v) => ISO8601_RE.test(v) }),
]);

const BY_KEY = new Map(MASK_INVENTORY.map((e) => [e.key, e]));

/** Walk `value` recursively; for every object key matching the pinned
 * inventory: leave a `null` on a nullable entry untouched, replace a value
 * matching its pinned format with a fixed mask token, or push a FORMAT
 * VIOLATION onto `violations` (never silently swallowed) for anything else —
 * a present value that fails its pinned format. Returns the masked clone;
 * `violations` is populated by side effect so a caller can red on it BEFORE
 * ever reaching the payload byte-diff. */
export function applyMask(value, violations = [], path = '$') {
  if (Array.isArray(value)) {
    return value.map((v, i) => applyMask(v, violations, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const entry = BY_KEY.get(key);
      const childPath = `${path}.${key}`;
      const raw = value[key];
      if (!entry) {
        out[key] = applyMask(raw, violations, childPath);
      } else if (raw === null && isNullable(entry)) {
        out[key] = null;
      } else if (typeof raw === 'string' && entry.test(raw)) {
        out[key] = MASK_TOKEN(entry.format);
      } else {
        violations.push({ path: childPath, key, format: entry.format, value: raw });
        out[key] = raw;
      }
    }
    return out;
  }
  return value;
}

const isTimestampFormat = (format) => format === 'iso8601' || format === 'iso8601_or_null';

/** PROVENANCE SPLIT (build-2 ruling, seam-audit card 9aeca184 — carried forward
 * from build 1's flagged defect): a timestamp-format key is either
 * SERVER-MINTED (the target itself stamps it — created_at, updated_at,
 * archived_at, deleted_at, resolved_at) or CLIENT-ECHOED (a value the PROBE
 * sent, which the target only stores/echoes — due, the sole example today).
 * Two independent servers mint a SERVER-MINTED field at genuinely different
 * wall-clock moments — that is not a bug, and no tolerance WINDOW is the
 * fix (a tuned delta is a fudge factor that would silently absorb a real
 * one), so a server-minted key is format-asserted-and-masked ONLY and NEVER
 * instant-compared cross-target, here or via the register. A CLIENT-ECHOED
 * key is genuinely comparable — both targets observed the SAME source value
 * — so it keeps going through this paired check. */
export const SERVER_MINTED_TIMESTAMP_KEYS = new Set([
  'created_at', 'updated_at', 'archived_at', 'deleted_at', 'resolved_at',
]);

/** Walk TWO raw (pre-mask) bodies in parallel looking for CLIENT-ECHOED
 * timestamp-class keys (see the provenance split above — a SERVER-MINTED key
 * never reaches this check) present on BOTH sides, format-valid on BOTH
 * sides, whose raw string values differ. `applyMask` alone cannot surface
 * this: it masks each side INDEPENDENTLY, so any two format-valid timestamps
 * collapse to the same opaque token regardless of value. This is the paired
 * half that the differ feeds to the register (parity-register.js) to decide
 * whether the observed divergence is a ratified equivalence or a real red —
 * the mask itself renders no equivalence verdict. */
export function findTimestampDivergences(a, b, path = '$') {
  const out = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) out.push(...findTimestampDivergences(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a !== null && typeof a === 'object' && b !== null && typeof b === 'object'
      && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
      const entry = BY_KEY.get(key);
      const childPath = `${path}.${key}`;
      const rawA = a[key];
      const rawB = b[key];
      if (entry && isTimestampFormat(entry.format) && !SERVER_MINTED_TIMESTAMP_KEYS.has(key)) {
        if (
          typeof rawA === 'string' && typeof rawB === 'string' && rawA !== rawB
          && ISO8601_RE.test(rawA) && ISO8601_RE.test(rawB)
        ) {
          out.push({ path: childPath, key, a: rawA, b: rawB });
        }
      } else if (rawA !== null && typeof rawA === 'object' && rawB !== null && typeof rawB === 'object') {
        out.push(...findTimestampDivergences(rawA, rawB, childPath));
      }
    }
  }
  return out;
}
