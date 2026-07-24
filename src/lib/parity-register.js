/**
 * THE TYPED EXEMPTION REGISTER — the single, exhaustive list of tolerated
 * mock-vs-real differences. No exemption may live anywhere else: the differ
 * (parity-differ.js) and the mask (parity-mask.js) CONSULT this module and
 * contain no inline equivalence logic of their own.
 *
 * Corrective history: PR #9 shipped two of these as ad-hoc equivalence
 * classes baked directly into the differ/serializer (a JSON/SSE media-type
 * set, a loosened ISO8601 regex). That decision was reserved for the
 * operator. This module is the pre-specified typed register those two
 * divergences are converted into, adjudicated per entry below. It is not a
 * revert — the mechanisms (mask-then-compare, media-type canonicalization)
 * are right; the shape (buried, untyped, unowned) was wrong.
 *
 * Each entry:
 *   - id           stable identifier (report/pin keying)
 *   - surface      the EXACT surface it applies to — a symbolic identifier,
 *                  never a wildcard/glob over paths
 *   - mock_expected / real_expected   EXACT values or exact format-ids: the
 *                  entry silences only THOSE specific values on THAT surface.
 *                  A different value on the same surface still reds.
 *   - disposition  RATIFIED_EQUIVALENT | KNOWN_DEBT (exactly one)
 *   - rationale    one line, why this is tolerated
 *   - finding_card_id   required (non-null) for KNOWN_DEBT, null for
 *                  RATIFIED_EQUIVALENT — enforced below, not just documented
 *   - check(a, b)  the ONLY equivalence logic for this surface; returns
 *                  true iff the observed (a, b) pair is exactly the
 *                  tolerated divergence this entry describes
 */

// ── ENTRY 1 support: timestamp instant-equivalence ──────────────────────────
//
// Generic ISO-8601 validity (date + time + optional fraction + Z-or-offset).
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// The two EXACT shapes this entry recognizes — nothing looser than this ever
// matches. Anything else (2-digit fractions, a Z-suffixed microsecond value,
// no fraction at all, ...) falls through as "entry does not apply" and reds
// on any raw divergence, exactly as if this entry did not exist.
const ISO8601_MS_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO8601_US_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}[+-]\d{2}:\d{2}$/;

function timestampFormatId(value) {
  if (typeof value !== 'string') return null;
  if (ISO8601_MS_Z_RE.test(value)) return 'iso8601_ms_z';
  if (ISO8601_US_OFFSET_RE.test(value)) return 'iso8601_us_offset';
  return null;
}

/** Both values must parse as valid ISO 8601 (checked independently of the
 * strict shape match above — this is the mask's own format-validity job,
 * duplicated here defensively) AND represent the SAME INSTANT after
 * normalization (Date.parse truncates to millisecond precision — the
 * precision ceiling of the mock's own ms+Z format, so "same instant" here
 * means "agree down to the coarser side's precision", not bit-exact). A
 * same-format pair at a DIFFERENT instant, or either side outside the two
 * exact shapes this entry names, is NOT this entry's business and falls
 * through to a red. */
function timestampsAreRatifiedEquivalent(a, b) {
  const fa = timestampFormatId(a);
  const fb = timestampFormatId(b);
  if (!fa || !fb) return false;
  const pair = new Set([fa, fb]);
  const expected = new Set(['iso8601_ms_z', 'iso8601_us_offset']);
  if (pair.size !== expected.size || ![...pair].every((x) => expected.has(x))) return false;
  if (!ISO8601_RE.test(a) || !ISO8601_RE.test(b)) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

// ── ENTRY 2 support: content-type transport-encoding tolerance ─────────────

function isJsonSseTransportPair(a, b) {
  const pair = new Set([a, b]);
  const expected = new Set(['application/json', 'text/event-stream']);
  return pair.size === expected.size && [...pair].every((x) => expected.has(x));
}

export const PARITY_REGISTER = Object.freeze([
  Object.freeze({
    id: 'timestamp-ms-z-vs-us-offset',
    surface: 'mask-format:iso8601-timestamp-instant',
    mock_expected: 'iso8601_ms_z',
    real_expected: 'iso8601_us_offset',
    disposition: 'RATIFIED_EQUIVALENT',
    rationale:
      'Mock mints millisecond+Z (Date#toISOString()); real mints microsecond+offset '
      + '(Python datetime.now(timezone.utc).isoformat()). Both are valid ISO-8601 '
      + 'denoting the SAME instant — type-assert-and-mask, not a loosened format '
      + 'check: a same-format OR cross-format pair at a DIFFERENT instant still reds.',
    finding_card_id: null,
    check: timestampsAreRatifiedEquivalent,
  }),
  Object.freeze({
    id: 'content-type-json-vs-sse',
    surface: 'content-type',
    mock_expected: 'application/json',
    real_expected: 'text/event-stream',
    disposition: 'KNOWN_DEBT',
    rationale:
      'Real spine defaults to SSE under MCP Streamable HTTP; the board mock forces '
      + 'JSON. Tolerated ONLY so the probe can run — if the mock never emits SSE, the '
      + "board's SSE parse path is exercised by no test, the exact tests-pass-locally-"
      + 'breaks-against-real class this probe exists to catch. This entry is not a '
      + 'ruling that the difference is fine; it is owned debt (see finding_card_id).',
    finding_card_id: 'e39995e1-4691-49c9-a91b-4475d6ec3bc7',
    check: isJsonSseTransportPair,
  }),
]);

// ── Register hygiene: invariants enforced at load, not just documented ─────

for (const entry of PARITY_REGISTER) {
  if (entry.disposition !== 'RATIFIED_EQUIVALENT' && entry.disposition !== 'KNOWN_DEBT') {
    throw new Error(`parity-register: entry "${entry.id}" has an unratified disposition "${entry.disposition}"`);
  }
  if (entry.disposition === 'KNOWN_DEBT' && !entry.finding_card_id) {
    throw new Error(`parity-register: entry "${entry.id}" is KNOWN_DEBT but carries no finding_card_id`);
  }
  if (entry.disposition === 'RATIFIED_EQUIVALENT' && entry.finding_card_id !== null) {
    throw new Error(`parity-register: entry "${entry.id}" is RATIFIED_EQUIVALENT but carries a non-null finding_card_id`);
  }
}

// ── Consultation: the ONLY way the differ/mask learn a divergence is tolerated ──

/** Returns the register entry (if any) whose check(a, b) recognizes this
 * exact observed pair as the tolerated divergence it describes. At most one
 * entry is expected to ever match a given (a, b) pair since each check() is
 * gated to its own exact values/format-ids. */
export function findRegisterMatch(register, a, b) {
  return register.find((entry) => entry.check(a, b)) || null;
}

// ── Staleness tracking: an entry that never adjudicates a real divergence
// across a full run is dead weight, never silently carried. ──────────────

const usage = new Map(PARITY_REGISTER.map((e) => [e.id, 0]));

/** Called by the differ exactly when a register entry's check() actually
 * matched a real (a !== b) divergence — proof the entry did work this run. */
export function recordDivergenceObserved(entryId) {
  usage.set(entryId, (usage.get(entryId) || 0) + 1);
}

export function resetRegisterUsage() {
  for (const entry of PARITY_REGISTER) usage.set(entry.id, 0);
}

export function usageCount(entryId) {
  return usage.get(entryId) || 0;
}

/** Entries with zero recorded matches across the run so far. */
export function getStaleEntries(register = PARITY_REGISTER) {
  return register.filter((entry) => usageCount(entry.id) === 0);
}

// ── Reporting: every probe run prints the register; KNOWN_DEBT prints loudly ──

export function formatRegisterReport(register = PARITY_REGISTER) {
  const lines = [`PARITY REGISTER — ${register.length} entries`];
  for (const entry of register) {
    lines.push(`  [${entry.disposition}] ${entry.id}`);
    lines.push(`    surface: ${entry.surface}`);
    lines.push(`    mock_expected: ${entry.mock_expected}  real_expected: ${entry.real_expected}`);
    lines.push(`    rationale: ${entry.rationale}`);
    if (entry.disposition === 'KNOWN_DEBT') {
      lines.push(`    *** KNOWN_DEBT — owned by finding_card_id: ${entry.finding_card_id} ***`);
    }
  }
  return lines.join('\n');
}

export function printRegisterReport(register = PARITY_REGISTER) {
  console.log(formatRegisterReport(register));
}
