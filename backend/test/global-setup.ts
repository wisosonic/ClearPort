import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPrismaClient } from '../src/database/client';
import { seedReferenceData } from '../src/seed/reference-data';

/**
 * Builds one template database by running the real migrations (including the integrity
 * triggers) and seeding reference data. Each test file copies it, so tests exercise the
 * actual production schema, not a `db push` approximation.
 */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'clearport-test-'));
  const template = join(dir, 'template.db');
  const url = `file:${template.replace(/\\/g, '/')}`;

  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  const prisma = await createPrismaClient(url);
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = DELETE'); // single file so it can be copied
  await seedReferenceData(prisma);
  await prisma.$disconnect();

  process.env.CLEARPORT_TEMPLATE_DB = template;

  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
