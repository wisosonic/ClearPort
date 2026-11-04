/**
 * Prisma's SQLite adapter reports every SQLITE_CONSTRAINT_* failure as a generic
 * "Foreign key constraint violated" (P2003). For failures raised by our integrity triggers
 * (RAISE(ABORT, '...')) the original message is preserved under
 * meta.driverAdapterError.cause.originalMessage. Services use this to translate a database
 * rule violation into a proper domain error (e.g. 409 POSTED_ENTRY_IMMUTABLE).
 */
export interface DbRuleViolation {
  code: string; // e.g. SQLITE_CONSTRAINT_TRIGGER
  message: string; // the text passed to RAISE(ABORT, ...)
}

export function dbRuleViolation(error: unknown): DbRuleViolation | undefined {
  const cause = (error as any)?.meta?.driverAdapterError?.cause;
  if (!cause || typeof cause.originalCode !== 'string') return undefined;
  if (!cause.originalCode.startsWith('SQLITE_CONSTRAINT_TRIGGER')) return undefined;
  return { code: cause.originalCode, message: String(cause.originalMessage ?? '') };
}

export const dbRuleMessage = (error: unknown): string | undefined => dbRuleViolation(error)?.message;
