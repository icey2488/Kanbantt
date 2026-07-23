import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProvenance, hasProvenance } from './provenance.js';

// ── absent / non-provenance shapes → null (render nothing) ────────────────────
test('null / undefined created_by → null', () => {
  assert.equal(readProvenance(null), null);
  assert.equal(readProvenance(undefined), null);
  assert.equal(hasProvenance(null), false);
});

test('bare string actor (LocalProvider legacy stamp) → null', () => {
  assert.equal(readProvenance('tester'), null);
});

test('identity-only { type, id } (human or plain agent) → null', () => {
  assert.equal(readProvenance({ type: 'human', id: 'operator' }), null);
  assert.equal(readProvenance({ type: 'agent', id: 'claude-code' }), null);
});

test('array is not a provenance object → null (never throws)', () => {
  assert.equal(readProvenance(['model', 'x']), null);
});

// ── agent mint WITH provenance → extracted, read-only ─────────────────────────
test('full provenance is extracted', () => {
  const p = readProvenance({
    type: 'agent', id: 'claude-code',
    model: 'claude-sonnet-5', effort: 'medium', job_id: 'job-7',
  });
  assert.deepEqual(p, {
    model: 'claude-sonnet-5', effort: 'medium', actor: 'claude-code', job_id: 'job-7',
  });
  assert.equal(hasProvenance({ type: 'agent', id: 'a', model: 'm' }), true);
});

test('model alone renders (effort/job_id/actor null)', () => {
  assert.deepEqual(readProvenance({ model: 'claude-opus-4-8' }), {
    model: 'claude-opus-4-8', effort: null, actor: null, job_id: null,
  });
});

test('effort alone renders (model null)', () => {
  assert.deepEqual(readProvenance({ type: 'agent', id: 'a', effort: 'high' }), {
    model: null, effort: 'high', actor: 'a', job_id: null,
  });
});

test('job_id / actor alone do NOT surface provenance (no chip content)', () => {
  assert.equal(readProvenance({ type: 'agent', id: 'a', job_id: 'j1' }), null);
});

// ── MCP interop: unknown keys tolerated, junk values ignored ──────────────────
test('unknown foreign keys are ignored, provenance still read', () => {
  const p = readProvenance({
    type: 'agent', id: 'other-agent', model: 'their-model',
    vendor_trace: { span: 'abc' }, cost_cents: 3,
  });
  assert.deepEqual(p, { model: 'their-model', effort: null, actor: 'other-agent', job_id: null });
});

test('non-string / empty model+effort → null (never a blank chip)', () => {
  assert.equal(readProvenance({ type: 'agent', id: 'a', model: 123, effort: '' }), null);
  assert.equal(readProvenance({ type: 'agent', id: 'a', model: '   ' }), null);
});
