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
// Generic ISO-8601 (date + time + optional fraction + Z-or-offset). Deliberately
// loose on fractional-second digit count and zone spelling: FINDING — the mock
// mints millisecond+Z (`Date#toISOString()`), the real spine mints
// microsecond+offset (`datetime.now(timezone.utc).isoformat()`). Both are valid
// ISO-8601; this mask treats them as the same opaque-timestamp format class
// rather than silently "fixing" either side (see build report).
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
