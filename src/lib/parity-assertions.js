import { diffStepResults } from './parity-differ.js';
import { stableStringify } from './parity-serializer.js';
import { applyMask } from './parity-mask.js';

/**
 * D4 — TWO ASSERTION CLASSES, both required. A parity probe cannot detect a bug
 * both targets share: two identically-wrong targets diff green forever (e.g.
 * both silently truncate an at-limit payload and both return 200).
 * Self-consistency is the only assertion class that catches a shared bug — it
 * never compares target-to-target, only a target against its OWN prior write.
 */

/** PARITY: target A vs target B for the SAME wire step. Throws with every
 * violation listed (never just the first) when they diverge. */
export function assertParity(stepName, resultA, resultB) {
  const { ok, violations } = diffStepResults(stepName, resultA, resultB);
  if (!ok) {
    throw new Error(
      `parity violation on "${stepName}":\n${violations.map((v) => JSON.stringify(v)).join('\n')}`
    );
  }
}

/** SELF-CONSISTENCY: send X to ONE target, read it back FROM THAT SAME TARGET,
 * assert the value survived byte-exact — asserted per target INDEPENDENTLY of
 * what the other target does. `fields` is the list of non-volatile keys to
 * compare from `sent` (what the caller asked to be written) against
 * `readBack` (what that same target returned after the write); volatile /
 * server-minted fields (id, version, timestamps) are excluded by the caller,
 * never compared here, since they are never expected to equal the input. */
export function assertSelfConsistent(stepName, sent, readBack, fields) {
  const violations = [];
  for (const field of fields) {
    const a = stableStringify(applyMask({ [field]: sent[field] }));
    const b = stableStringify(applyMask({ [field]: readBack[field] }));
    if (a !== b) violations.push({ field, sent: sent[field], readBack: readBack[field] });
  }
  if (violations.length) {
    throw new Error(
      `self-consistency violation on "${stepName}":\n${violations.map((v) => JSON.stringify(v)).join('\n')}`
    );
  }
}
