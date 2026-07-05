import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createdAtLabel } from './date-chip.js';

test('today → TODAY HH:MM in 24-hour local time', () => {
  const now = new Date();
  const label = createdAtLabel(now.toISOString());
  const expected = `TODAY ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  assert.equal(label, expected);
});

test('yesterday → null', () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  assert.equal(createdAtLabel(d.toISOString()), null);
});

test('one week ago → null', () => {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  assert.equal(createdAtLabel(d.toISOString()), null);
});

test('null input → null', () => {
  assert.equal(createdAtLabel(null), null);
});

test('undefined input → null', () => {
  assert.equal(createdAtLabel(undefined), null);
});

test('midnight boundary: 23:59:59 yesterday → null', () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(23, 59, 59, 999);
  assert.equal(createdAtLabel(d.toISOString()), null);
});

test('midnight boundary: 00:00 today → TODAY 00:00', () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  assert.equal(createdAtLabel(d.toISOString()), 'TODAY 00:00');
});
