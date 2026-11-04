import { expect } from 'vitest';
import { dbRuleMessage } from '../src/common/db-errors';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrismaClient, type PrismaClient } from '../src/database/client';
import { nextDocumentNumber } from '../src/common/numbering';
import { provisionTenantDefaults } from '../src/seed/tenant-defaults';

/** Asserts the operation is rejected by one of our integrity triggers with a matching message. */
export async function expectRule(operation: PromiseLike<unknown>, message: RegExp) {
  let error: unknown;
  try {
    await operation;
  } catch (e) {
    error = e;
  }
  expect(error, 'expected the database to reject this operation').toBeDefined();
  expect(dbRuleMessage(error), 'rejected, but not by an integrity trigger').toMatch(message);
}

export interface TestDb {
  prisma: PrismaClient;
  url: string;
  cleanup: () => Promise<void>;
}

/** A private, migrated + seeded database for one test file. */
export async function freshDb(): Promise<TestDb> {
  const template = process.env.CLEARPORT_TEMPLATE_DB;
  if (!template) throw new Error('CLEARPORT_TEMPLATE_DB not set — is globalSetup running?');
  const dir = mkdtempSync(join(tmpdir(), 'clearport-case-'));
  const file = join(dir, 'test.db');
  copyFileSync(template, file);
  const url = `file:${file.replace(/\\/g, '/')}`;
  const prisma = await createPrismaClient(url);
  return {
    prisma,
    url,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function makeTenant(prisma: PrismaClient, slug: string) {
  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: `Office ${slug}`, slug, defaultCurrency: 'USD' },
    });
    await provisionTenantDefaults(tx as unknown as PrismaClient, tenant.id);
    return tenant;
  });
}

export async function makeMember(prisma: PrismaClient, tenantId: string, email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: 'x', firstName: 'Test', lastName: 'User' },
  });
  await prisma.tenantUser.create({ data: { tenantId, userId: user.id } });
  return user;
}

export async function makeClient(prisma: PrismaClient, tenantId: string, clientCode: string) {
  return prisma.client.create({ data: { tenantId, clientCode, name: `Client ${clientCode}` } });
}

/** Creates a file the way the real service should: number allocated in the same transaction. */
export async function makeFile(
  prisma: PrismaClient,
  args: { tenantId: string; clientId: string; createdBy: string; assignedTo?: string },
) {
  return prisma.$transaction(async (tx) => {
    const fileNumber = await nextDocumentNumber(tx, args.tenantId, 'IMP');
    return tx.clearanceFile.create({
      data: {
        tenantId: args.tenantId, fileNumber, fileType: 'IMPORT', clientId: args.clientId,
        createdBy: args.createdBy, assignedTo: args.assignedTo ?? null,
      },
    });
  });
}

export async function accountByCode(prisma: PrismaClient, tenantId: string, accountCode: string) {
  return prisma.chartOfAccount.findFirstOrThrow({ where: { tenantId, accountCode } });
}
