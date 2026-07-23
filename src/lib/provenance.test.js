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

test('agent mint with model alone renders (effort/job_id null)', () => {
  assert.deepEqual(readProvenance({ type: 'agent', id: 'a', model: 'claude-opus-4-8' }), {
    model: 'claude-opus-4-8', effort: null, actor: 'a', job_id: null,
  });
});

test('type-less created_by with model → null (type is the gate, not presence)', () => {
  // A foreign object lacking the identity discriminator is NOT agent-typed → render
  // nothing. The spine always stamps type; a shape without it is not a spine card.
  assert.equal(readProvenance({ model: 'claude-opus-4-8' }), null);
  assert.equal(hasProvenance({ model: 'claude-opus-4-8', effort: 'high' }), false);
});

test('effort alone renders (model null)', () => {
  assert.deepEqual(readProvenance({ type: 'agent', id: 'a', effort: 'high' }), {
    model: null, effort: 'high', actor: 'a', job_id: null,
  });
});

test('job_id / actor alone do NOT surface provenance (no chip content)', () => {
  assert.equal(readProvenance({ type: 'agent', id: 'a', job_id: 'j1' }), null);
});

// ── FINDING 1 "cyborg card": human-typed identity NEVER renders provenance ────
// The spine stamps identity from the authenticated credential (anti-spoof) but merges
// the client's descriptive sub-keys onto it. Today's only credential maps to the human
// operator, so a wire mint carrying {type:'agent', model:'x'} is stored as
// {type:'human', id:'operator', model:'x'}. That is an incoherent audit record — a
// human mint with a reasoning model — and MUST render nothing: no chip, no dialog block.
test('human-typed card carrying model/effort → NO chip, NO dialog (cyborg card)', () => {
  const cyborg = { type: 'human', id: 'operator', model: 'claude-sonnet-5', effort: 'high', job_id: 'j9' };
  assert.equal(readProvenance(cyborg), null); // both render sites gate on this → nothing renders
  assert.equal(hasProvenance(cyborg), false);
});

test('agent-typed card with model+effort still renders BOTH chip and dialog', () => {
  // The counterpart to the cyborg guard: a genuine agent mint is unaffected — the type
  // gate lets it through, and readProvenance returns the full block both sites render.
  const agent = { type: 'agent', id: 'claude-code', model: 'claude-sonnet-5', effort: 'high', job_id: 'j9' };
  assert.deepEqual(readProvenance(agent), {
    model: 'claude-sonnet-5', effort: 'high', actor: 'claude-code', job_id: 'j9',
  });
  assert.equal(hasProvenance(agent), true);
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
