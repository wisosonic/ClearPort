import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestDb } from './helpers';

/**
 * Guards against a real SQLite/Prisma trap: adding columns makes Prisma rebuild the table
 * (create new, copy, DROP old, rename) and DROP TABLE silently drops that table's triggers.
 * Every trigger ever created by a migration must still exist in the final database, unless a
 * later migration drops it on purpose with DROP TRIGGER.
 */
describe('migrations keep the integrity triggers', () => {
  let db: TestDb;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => db.cleanup());

  const migrationsDir = resolve(__dirname, '../prisma/migrations');
  const sqlFiles = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .map((d) => readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'));

  /** Names created minus names explicitly dropped, in migration order. */
  const expected = (() => {
    const names = new Set<string>();
    for (const sql of sqlFiles) {
      for (const m of sql.matchAll(/CREATE TRIGGER (\w+)/g)) names.add(m[1]);
      for (const m of sql.matchAll(/DROP TRIGGER (?:IF EXISTS )?(\w+)/g)) names.delete(m[1]);
    }
    return [...names].sort();
  })();

  it('declares a meaningful set of triggers', () => {
    expect(expected.length).toBeGreaterThanOrEqual(34); // 31 from integrity_triggers + 3 added in the finance migration
    expect(expected).toEqual(expect.arrayContaining(['invoices_no_delete', 'journal_entries_posted_immutable', 'payment_allocations_immutable']));
  });

  it('has every declared trigger present in the migrated database', async () => {
    const rows = await db.prisma.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'trigger'");
    const actual = rows.map((r) => r.name).sort();
    const missing = expected.filter((n) => !actual.includes(n));
    expect(missing, `triggers lost by a table rebuild: ${missing.join(', ')}`).toEqual([]);
    expect(actual.filter((n) => !expected.includes(n))).toEqual([]); // and nothing unexpected
  });

  it('does not create the same trigger twice in one migration', () => {
    for (const sql of sqlFiles) {
      const names = [...sql.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
