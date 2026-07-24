import { stableStringify, parseContentType } from './parity-serializer.js';
import { applyMask, findTimestampDivergences } from './parity-mask.js';
import { PARITY_REGISTER, findRegisterMatch, recordDivergenceObserved } from './parity-register.js';

/**
 * Full-surface diff (D2) between two StepResults ({ status, contentType, body })
 * for the SAME wire step. This module's only inputs are already-captured
 * StepResult values — never a live target, never a spawn/reset call. That is
 * D1's category split enforced structurally: this file cannot produce a
 * lifecycle action, and parity-lifecycle.js never returns a diffable shape.
 *
 * Scope note: mock-to-real WIRE PARITY only (this probe). Real-to-spec
 * conformance is a distinct axis owned by the spine's test_spec_divergences.py.
 *
 * EQUIVALENCE CLASSES: this module contains NONE of its own. Every tolerated
 * mock-vs-real difference (media-type transport choice, timestamp format) is
 * adjudicated by consulting parity-register.js — the single typed register —
 * never by inline logic here.
 */

/** Never throws. Returns { ok, violations }; callers (parity-assertions.js)
 * turn a non-empty violation list into a thrown red. `register` defaults to
 * the ratified PARITY_REGISTER; tests pass a filtered register to prove an
 * entry's removal reds exactly the divergence it used to tolerate. */
export function diffStepResults(stepName, a, b, { register = PARITY_REGISTER } = {}) {
  const violations = [];

  if (a.status !== b.status) {
    violations.push({ kind: 'status', stepName, a: a.status, b: b.status });
  }

  const ctA = parseContentType(a.contentType);
  const ctB = parseContentType(b.contentType);
  if (ctA.mediaType !== ctB.mediaType) {
    const match = findRegisterMatch(register, ctA.mediaType, ctB.mediaType);
    if (match) {
      recordDivergenceObserved(match.id);
    } else {
      violations.push({ kind: 'media-type', stepName, a: ctA.mediaType, b: ctB.mediaType });
    }
  }
  // ctA.params / ctB.params are ignored per D2 — charset et al. must never red (T6a).

  const maskViolationsA = [];
  const maskViolationsB = [];
  const maskedA = applyMask(a.body, maskViolationsA);
  const maskedB = applyMask(b.body, maskViolationsB);
  for (const v of maskViolationsA) violations.push({ kind: 'mask-format', stepName, side: 'a', ...v });
  for (const v of maskViolationsB) violations.push({ kind: 'mask-format', stepName, side: 'b', ...v });

  // Paired timestamp check (register-consulted): applyMask alone collapses
  // any two format-valid timestamps to the same opaque token, which would
  // silently hide an instant mismatch. Consult the register on every raw
  // divergence found; unmatched divergences red exactly like any other field.
  for (const d of findTimestampDivergences(a.body, b.body)) {
    const match = findRegisterMatch(register, d.a, d.b);
    if (match) {
      recordDivergenceObserved(match.id);
    } else {
      violations.push({ kind: 'timestamp-instant', stepName, path: d.path, key: d.key, a: d.a, b: d.b });
    }
  }

  const sa = stableStringify(maskedA);
  const sb = stableStringify(maskedB);
  if (sa !== sb) {
    violations.push({ kind: 'payload', stepName, a: sa, b: sb });
  }

  return { ok: violations.length === 0, violations };
}
