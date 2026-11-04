import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountByCode, freshDb, makeClient, makeFile, makeMember, makeTenant, type TestDb } from './helpers';

/**
 * Cross-tenant references must be rejected by the DATABASE (composite foreign keys), not just
 * by application code. Each case tries to attach tenant B's row to tenant A's record.
 */
describe('tenant-safe relationships', () => {
  let db: TestDb;
  let A: Awaited<ReturnType<typeof setupTenant>>;
  let B: Awaited<ReturnType<typeof setupTenant>>;

  async function setupTenant(slug: string) {
    const { prisma } = db;
    const tenant = await makeTenant(prisma, slug);
    const user = await makeMember(prisma, tenant.id, `${slug}@example.com`);
    const client = await makeClient(prisma, tenant.id, 'C001');
    const file = await makeFile(prisma, { tenantId: tenant.id, clientId: client.id, createdBy: user.id });
    const shipment = await prisma.shipment.create({ data: { tenantId: tenant.id, clearanceFileId: file.id } });
    const stage = await prisma.workflowStage.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const cash = await prisma.cashAccount.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const account = await accountByCode(prisma, tenant.id, '1010');
    const category = await prisma.financialCategory.findFirstOrThrow({ where: { tenantId: tenant.id } });
    return { tenant, user, client, file, shipment, stage, cash, account, category };
  }

  beforeAll(async () => {
    db = await freshDb();
    A = await setupTenant('office-a');
    B = await setupTenant('office-b');
  });
  afterAll(async () => db.cleanup());

  it('allows the same relationships inside one tenant (sanity check)', async () => {
    const file = await makeFile(db.prisma, { tenantId: A.tenant.id, clientId: A.client.id, createdBy: A.user.id });
    expect(file.tenantId).toBe(A.tenant.id);
  });

  it('rejects a clearance file that uses another tenant\'s client', async () => {
    await expect(
      makeFile(db.prisma, { tenantId: B.tenant.id, clientId: A.client.id, createdBy: B.user.id }),
    ).rejects.toThrow();
  });

  it('rejects assigning a file to a user who is not a member of the tenant', async () => {
    await expect(
      makeFile(db.prisma, {
        tenantId: A.tenant.id, clientId: A.client.id, createdBy: A.user.id, assignedTo: B.user.id,
      }),
    ).rejects.toThrow();
  });

  it('rejects creating a file as a user from another tenant', async () => {
    await expect(
      makeFile(db.prisma, { tenantId: A.tenant.id, clientId: A.client.id, createdBy: B.user.id }),
    ).rejects.toThrow();
  });

  it('rejects a shipment attached to another tenant\'s file', async () => {
    await expect(
      db.prisma.shipment.create({ data: { tenantId: B.tenant.id, clearanceFileId: A.file.id } }),
    ).rejects.toThrow();
  });

  it('rejects a container attached to another tenant\'s shipment', async () => {
    await expect(
      db.prisma.container.create({
        data: { tenantId: B.tenant.id, shipmentId: A.shipment.id, containerNumber: 'MSKU1234565' },
      }),
    ).rejects.toThrow();
  });

  it('rejects setting another tenant\'s workflow stage as the current stage', async () => {
    await expect(
      db.prisma.clearanceFile.update({
        where: { id: A.file.id },
        data: { currentStageId: B.stage.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects an invoice for another tenant\'s client or file', async () => {
    const base = {
      invoiceNumber: 'INV-X', currencyCode: 'USD', subtotal: '10.0000', totalAmount: '10.0000',
      createdBy: A.user.id,
    };
    await expect(
      db.prisma.invoice.create({
        data: { ...base, tenantId: A.tenant.id, clearanceFileId: A.file.id, clientId: B.client.id },
      }),
    ).rejects.toThrow();
    await expect(
      db.prisma.invoice.create({
        data: { ...base, tenantId: A.tenant.id, clearanceFileId: B.file.id, clientId: A.client.id },
      }),
    ).rejects.toThrow();
  });

  it('rejects a payment into another tenant\'s cash account', async () => {
    await expect(
      db.prisma.payment.create({
        data: {
          tenantId: A.tenant.id, paymentNumber: 'PAY-X', paymentType: 'CLIENT_ADVANCE', amount: '500.0000',
          currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '500.0000', paymentMethod: 'CASH',
          cashAccountId: B.cash.id, paymentDate: new Date(), receivedBy: A.user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects an expense using another tenant\'s category', async () => {
    await expect(
      db.prisma.expense.create({
        data: {
          tenantId: A.tenant.id, categoryId: B.category.id, description: 'x', amount: '1.0000',
          currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '1.0000',
          expenseDate: new Date(), recordedBy: A.user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects journal lines that post to another tenant\'s account', async () => {
    const entry = await db.prisma.journalEntry.create({
      data: {
        tenantId: A.tenant.id, entryNumber: 'JE-X', entryDate: new Date(), description: 'x',
        createdBy: A.user.id,
      },
    });
    await expect(
      db.prisma.journalEntryLine.create({
        data: {
          tenantId: A.tenant.id, journalEntryId: entry.id, accountId: B.account.id, debit: '1.0000',
          currencyCode: 'USD', exchangeRate: '1.0000000000', baseDebit: '1.0000',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a document that points at another tenant\'s file', async () => {
    const docType = await db.prisma.documentType.findFirstOrThrow({ where: { tenantId: null } });
    await expect(
      db.prisma.document.create({
        data: {
          tenantId: B.tenant.id, clearanceFileId: A.file.id, documentTypeId: docType.id,
          originalFilename: 'a.pdf', storageKey: 'k', mimeType: 'application/pdf', fileSize: 10n,
          checksum: 'abc', uploadedBy: B.user.id,
        },
      }),
    ).rejects.toThrow();
  });

  it('keeps client codes unique per tenant but reusable across tenants', async () => {
    // both tenants already have C001
    await expect(makeClient(db.prisma, A.tenant.id, 'C001')).rejects.toThrow();
    await expect(makeClient(db.prisma, B.tenant.id, 'C002')).resolves.toBeDefined();
    await expect(makeClient(db.prisma, A.tenant.id, 'C002')).resolves.toBeDefined();
  });

  it('keeps file numbers independent per tenant (both start at 00001)', async () => {
    expect(A.file.fileNumber).toMatch(/^IMP-\d{4}-00001$/);
    expect(B.file.fileNumber).toMatch(/^IMP-\d{4}-00001$/);
  });
});
