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
