export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type Person = { id: string; firstName: string; lastName: string };

export interface Task {
  id: string; clearanceFileId: string | null; clearanceFile: { id: string; fileNumber: string } | null;
  assignedTo: string; title: string; description: string | null; priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status: TaskStatus; dueAt: string | null; completedAt: string | null;
  assignee: Person | null; createdByUser: Person | null; isOverdue: boolean;
}

/**
 * A task's due date is a whole day in the user's own time zone: it falls due at the END of that local day, so "due today"
 * is not overdue by lunchtime and the day shown is the day that was picked (UTC arithmetic would shift it for Lebanon).
 */
export function dueToIso(day: string): string | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}
/** The local calendar day of a due date, for a date input. */
export function isoToLocalDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
