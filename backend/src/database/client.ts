import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client';

export type { PrismaClient };

/**
 * Creates a Prisma client for the SQLite database file.
 * WAL mode and a busy timeout let readers run while one writer is active and make
 * concurrent writers wait instead of failing immediately. Prisma enables
 * `PRAGMA foreign_keys = ON`, which the composite tenant FKs rely on.
 */
export async function createPrismaClient(databaseUrl = process.env.DATABASE_URL ?? 'file:./dev.db') {
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  return prisma;
}
