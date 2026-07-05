function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * True when the task has a real due date strictly before today and is not done.
 * A null/undefined due means no due date — never overdue.
 */
export function isOverdue(task) {
  return task.dueDate != null &&
    startOfDay(new Date(task.dueDate)) < startOfDay(new Date()) &&
    task.status !== 'done';
}

/**
 * Returns "TODAY HH:MM" (24-hour local) when createdAt is the same
 * local calendar day as now; null for older dates or missing values.
 */
export function createdAtLabel(createdAt) {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  const now = new Date();
  if (
    d.getFullYear() !== now.getFullYear() ||
    d.getMonth() !== now.getMonth() ||
    d.getDate() !== now.getDate()
  ) return null;
  return `TODAY ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
