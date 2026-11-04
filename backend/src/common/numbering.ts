import type { PrismaClient } from '../generated/prisma/client';
import { sqlTime } from './sql-time';

/** Anything that can run $queryRaw — the root client or an interactive-transaction client. */
type Queryable = Pick<PrismaClient, '$queryRaw'>;

export type NumberDocType = 'IMP' | 'EXP' | 'OTH' | 'INV' | 'PAY' | 'JE' | (string & {});

/**
 * Atomically allocates the next number for (tenant, docType, year).
 *
 * Never MAX()+1. A single INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement is atomic
 * in SQLite: it takes the database write lock, increments and returns in one step, so two
 * concurrent callers can never receive the same value. If the caller is inside a transaction
 * and rolls back, the increment rolls back with it (no gaps from failed creations).
 */
export async function allocateSequenceValue(
  db: Queryable,
  tenantId: string,
  docType: NumberDocType,
  year: number,
): Promise<number> {
  const id = crypto.randomUUID();
  const now = sqlTime();
  const rows = await db.$queryRaw<{ lastValue: number | bigint }[]>`
    INSERT INTO number_sequences (id, tenantId, docType, year, lastValue, updatedAt)
    VALUES (${id}, ${tenantId}, ${docType}, ${year}, 1, ${now})
    ON CONFLICT (tenantId, docType, year)
    DO UPDATE SET lastValue = lastValue + 1, updatedAt = ${now}
    RETURNING lastValue`;
  return Number(rows[0].lastValue);
}

export function formatNumber(docType: NumberDocType, year: number, value: number, pad = 5): string {
  return `${docType}-${year}-${String(value).padStart(pad, '0')}`;
}

/** Example: IMP-2026-00001 */
export async function nextDocumentNumber(
  db: Queryable,
  tenantId: string,
  docType: NumberDocType,
  year = new Date().getUTCFullYear(),
): Promise<string> {
  const value = await allocateSequenceValue(db, tenantId, docType, year);
  return formatNumber(docType, year, value);
}

export const fileNumberPrefix = (fileType: 'IMPORT' | 'EXPORT' | 'OTHER'): NumberDocType =>
  fileType === 'IMPORT' ? 'IMP' : fileType === 'EXPORT' ? 'EXP' : 'OTH';
