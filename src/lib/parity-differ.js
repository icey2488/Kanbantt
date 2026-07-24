import { stableStringify, parseContentType, canonicalMediaType } from './parity-serializer.js';
import { applyMask } from './parity-mask.js';

/**
 * Full-surface diff (D2) between two StepResults ({ status, contentType, body })
 * for the SAME wire step. This module's only inputs are already-captured
 * StepResult values — never a live target, never a spawn/reset call. That is
 * D1's category split enforced structurally: this file cannot produce a
 * lifecycle action, and parity-lifecycle.js never returns a diffable shape.
 *
 * Scope note: mock-to-real WIRE PARITY only (this probe). Real-to-spec
 * conformance is a distinct axis owned by the spine's test_spec_divergences.py.
 */

/** Never throws. Returns { ok, violations }; callers (parity-assertions.js)
 * turn a non-empty violation list into a thrown red. */
export function diffStepResults(stepName, a, b) {
  const violations = [];

  if (a.status !== b.status) {
    violations.push({ kind: 'status', stepName, a: a.status, b: b.status });
  }

  const ctA = parseContentType(a.contentType);
  const ctB = parseContentType(b.contentType);
  const mtA = canonicalMediaType(ctA.mediaType);
  const mtB = canonicalMediaType(ctB.mediaType);
  if (mtA !== mtB) {
    violations.push({ kind: 'media-type', stepName, a: ctA.mediaType, b: ctB.mediaType });
  }
  // ctA.params / ctB.params are masked (ignored) per D2 — charset et al. must
  // never red (T6).

  const maskViolationsA = [];
  const maskViolationsB = [];
  const maskedA = applyMask(a.body, maskViolationsA);
  const maskedB = applyMask(b.body, maskViolationsB);
  for (const v of maskViolationsA) violations.push({ kind: 'mask-format', stepName, side: 'a', ...v });
  for (const v of maskViolationsB) violations.push({ kind: 'mask-format', stepName, side: 'b', ...v });

  const sa = stableStringify(maskedA);
  const sb = stableStringify(maskedB);
  if (sa !== sb) {
    violations.push({ kind: 'payload', stepName, a: sa, b: sb });
  }

  return { ok: violations.length === 0, violations };
}
