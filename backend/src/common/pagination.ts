import { z } from 'zod';
import Decimal from 'decimal.js';
import { Paginated } from './envelope.interceptor';

/** Standard list query: ?page=1&limit=20&search=...&sort=field:asc */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  sort: z.string().regex(/^[A-Za-z]+:(asc|desc)$/).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const pageArgs = (q: Pick<ListQuery, 'page' | 'limit'>) => ({
  skip: (q.page - 1) * q.limit,
  take: q.limit,
});

/** Parses "field:dir" against an allow-list so users can never sort by arbitrary columns. */
export function orderBy<T extends string>(
  sort: string | undefined,
  allowed: readonly T[],
  fallback: Record<string, 'asc' | 'desc'>,
): Record<string, 'asc' | 'desc'> {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':') as [T, 'asc' | 'desc'];
  return allowed.includes(field) ? { [field]: dir } : fallback;
}

export const paginated = <T>(items: T[], q: Pick<ListQuery, 'page' | 'limit'>, total: number) =>
  new Paginated(items, { page: q.page, limit: q.limit, total });

/**
 * Money columns are stored as TEXT decimals, so a database ORDER BY sorts them as strings
 * ("900.0000" would come after "89500000.0000"). When a list is sorted by such a column, load the
 * matching rows and sort them numerically here (offices are small; callers cap the load).
 */
export function decimalSort(sort: string | undefined, decimalFields: readonly string[]): { field: string; dir: 'asc' | 'desc' } | null {
  if (!sort) return null;
  const [field, dir] = sort.split(':');
  return decimalFields.includes(field) && (dir === 'asc' || dir === 'desc') ? { field, dir } : null;
}

export function sortRowsByDecimal<T extends Record<string, any>>(rows: T[], field: string, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * new Decimal(a[field]).comparedTo(new Decimal(b[field])));
}

export const DECIMAL_SORT_LOAD_CAP = 5000;
