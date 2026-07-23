import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatModelLabel, provenanceChipTreatment } from './model-label.js';

/* ------------------------------------------------------------------ */
/* known Anthropic IDs → "<Family> <version>"                         */
/* ------------------------------------------------------------------ */

test('claude-sonnet-5 → Sonnet 5', () => {
  assert.equal(formatModelLabel('claude-sonnet-5'), 'Sonnet 5');
});

test('claude-opus-4-8 → Opus 4.8 (multi-segment version dot-joined)', () => {
  assert.equal(formatModelLabel('claude-opus-4-8'), 'Opus 4.8');
});

test('claude-haiku-4-5-20251001 → Haiku 4.5 (dated snapshot suffix stripped)', () => {
  assert.equal(formatModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
});

test('claude-fable-5 → Fable 5', () => {
  assert.equal(formatModelLabel('claude-fable-5'), 'Fable 5');
});

test('a known family with no version segments → just the family name', () => {
  assert.equal(formatModelLabel('claude-opus'), 'Opus');
});

/* ------------------------------------------------------------------ */
/* unknown / foreign IDs → bounded, word-boundary-safe fallback       */
/* ------------------------------------------------------------------ */

test('unrecognized vendor ID → title-cased, no truncation when short', () => {
  assert.equal(formatModelLabel('gpt-4-turbo'), 'Gpt 4 Turbo');
});

test('unrecognized long ID → ellipsized at a word boundary, never mid-word', () => {
  const label = formatModelLabel('gpt-4-turbo-preview-experimental');
  assert.ok(label.endsWith('…'), `expected an ellipsis, got "${label}"`);
  assert.ok(label.length <= 18, `expected label capped near 18 chars, got "${label}" (${label.length})`);
  // every word before the ellipsis must be a COMPLETE word from the source — no
  // mid-word cut like the raw-ID bug this replaces (e.g. "…-2025100…").
  const words = label.replace('…', '').trim().split(' ').filter(Boolean);
  const sourceWords = 'gpt 4 turbo preview experimental'.split(' ');
  for (const w of words) assert.ok(sourceWords.includes(w.toLowerCase()), `"${w}" is not a whole source word`);
});

test('a single pathologically long segment hard-truncates as a last resort (still bounded)', () => {
  const label = formatModelLabel('supercalifragilisticexpialidocious-model');
  assert.ok(label.endsWith('…'));
  assert.ok(label.length <= 18);
});

test('claude- prefix on an unrecognized family still strips the prefix', () => {
  assert.equal(formatModelLabel('claude-mystery-model-9'), 'Mystery Model 9');
});

/* ------------------------------------------------------------------ */
/* missing / empty → null (no chip content, caller decides no chip)   */
/* ------------------------------------------------------------------ */

test('null / undefined / empty / whitespace-only → null', () => {
  assert.equal(formatModelLabel(null), null);
  assert.equal(formatModelLabel(undefined), null);
  assert.equal(formatModelLabel(''), null);
  assert.equal(formatModelLabel('   '), null);
});

test('non-string input → null (never throws)', () => {
  assert.equal(formatModelLabel(123), null);
  assert.equal(formatModelLabel({ id: 'x' }), null);
});

/* ------------------------------------------------------------------ */
/* provenanceChipTreatment — vendor→color-key mapping for the chip    */
/* ------------------------------------------------------------------ */

test('an Anthropic-vendor ID gets the "anthropic" treatment', () => {
  assert.equal(provenanceChipTreatment('claude-sonnet-5'), 'anthropic');
  assert.equal(provenanceChipTreatment('claude-haiku-4-5-20251001'), 'anthropic');
  assert.equal(provenanceChipTreatment('anthropic.claude-3-5-sonnet'), 'anthropic');
  assert.equal(provenanceChipTreatment('anthropic/claude-3-5-sonnet'), 'anthropic');
});

test('an unrecognized/foreign vendor ID gets the "foreign" treatment', () => {
  assert.equal(provenanceChipTreatment('gpt-4-turbo'), 'foreign');
  assert.equal(provenanceChipTreatment('gemini-2.0-pro'), 'foreign');
  assert.equal(provenanceChipTreatment('some-unknown-caller-model'), 'foreign');
});

test('a missing model → null (no vendor to key a color off, no chip color decision made)', () => {
  assert.equal(provenanceChipTreatment(null), null);
  assert.equal(provenanceChipTreatment(undefined), null);
  assert.equal(provenanceChipTreatment(''), null);
  assert.equal(provenanceChipTreatment('   '), null);
});

test('non-string input → null (never throws)', () => {
  assert.equal(provenanceChipTreatment(123), null);
  assert.equal(provenanceChipTreatment({ id: 'x' }), null);
});
