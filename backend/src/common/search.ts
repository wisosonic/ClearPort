import type { PrismaClient } from '../generated/prisma/client';

type Raw = Pick<PrismaClient, '$queryRawUnsafe'>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MATCHES = 10_000;

export interface SearchOptions {
  /** Table and columns are INTERNAL constants, never user input (validated as identifiers anyway). */
  table: string;
  columns: readonly string[];
  /** The user's search text. Matched literally: % and _ are NOT wildcards. */
  term: string;
  /** Adds `tenantId = ?`. Omit for global tables, and scope through extraWhere instead. */
  tenantId?: string;
  /** Extra SQL condition with positional `?` params, e.g. `"clientId" = ?`. */
  extraWhere?: string;
  extraParams?: unknown[];
}

/**
 * Case-insensitive (ASCII) "contains" search that treats the term literally.
 *
 * Prisma's `contains` on SQLite does not escape `%` / `_`, so a user typing "%" would match
 * every row. Instead we find matching ids with `instr()` (a plain substring test, no wildcards)
 * using bound parameters, then the caller filters with `id: { in: ids }`.
 */
export async function searchIds(db: Raw, o: SearchOptions): Promise<string[]> {
  for (const ident of [o.table, ...o.columns]) {
    if (!IDENT.test(ident)) throw new Error(`Unsafe SQL identifier: ${ident}`);
  }
  const likeAny = o.columns.map((c) => `instr(lower(COALESCE("${c}", '')), lower(?)) > 0`).join(' OR ');
  const conditions = [`(${likeAny})`];
  const params: unknown[] = o.columns.map(() => o.term);
  if (o.tenantId !== undefined) {
    conditions.unshift('"tenantId" = ?');
    params.unshift(o.tenantId);
  }
  if (o.extraWhere) {
    conditions.push(`(${o.extraWhere})`);
    params.push(...(o.extraParams ?? []));
  }
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "${o.table}" WHERE ${conditions.join(' AND ')} LIMIT ${MAX_MATCHES}`,
    ...params,
  );
  return rows.map((r) => r.id);
}
