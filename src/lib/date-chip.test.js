import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createdAtLabel, isOverdue } from './date-chip.js';

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

/* ------------------------------------------------------------------ */
/* isOverdue                                                           */
/* ------------------------------------------------------------------ */

test('isOverdue: null dueDate is never overdue', () => {
  assert.equal(isOverdue({ dueDate: null, status: 'todo' }), false);
  assert.equal(isOverdue({ dueDate: null, status: 'done' }), false);
});

test('isOverdue: undefined dueDate is never overdue', () => {
  assert.equal(isOverdue({ dueDate: undefined, status: 'todo' }), false);
});

test('isOverdue: past dueDate on non-done task is overdue', () => {
  assert.equal(isOverdue({ dueDate: '2020-01-01', status: 'todo' }), true);
  assert.equal(isOverdue({ dueDate: '2020-01-01', status: 'in-progress' }), true);
});

test('isOverdue: past dueDate on done task is NOT overdue', () => {
  assert.equal(isOverdue({ dueDate: '2020-01-01', status: 'done' }), false);
});

test('isOverdue: future dueDate is not overdue', () => {
  assert.equal(isOverdue({ dueDate: '2099-12-31', status: 'todo' }), false);
});
