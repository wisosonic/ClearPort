/**
 * Prisma stores DateTime in SQLite as ISO-8601 TEXT, e.g. "2026-11-03T16:33:49.267+00:00".
 * Raw SQL that writes or compares dates must use the SAME format, otherwise string comparison and
 * Prisma's own parsing break. Always bind dates through this helper in $queryRaw / $executeRaw.
 */
export const sqlTime = (d: Date = new Date()): string => d.toISOString().replace('Z', '+00:00');
