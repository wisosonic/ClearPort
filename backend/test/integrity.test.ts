import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountByCode, expectRule, freshDb, makeClient, makeFile, makeMember, makeTenant, type TestDb } from './helpers';

/** Database-level backstops from the integrity_triggers migration. */
describe('financial and data integrity rules', () => {
  let db: TestDb;
  let tenantId: string;
  let userId: string;
  let clientId: string;
  let fileId: string;

  beforeAll(async () => {
    db = await freshDb();
    tenantId = (await makeTenant(db.prisma, 'fin')).id;
    userId = (await makeMember(db.prisma, tenantId, 'fin@example.com')).id;
    clientId = (await makeClient(db.prisma, tenantId, 'F1')).id;
    fileId = (await makeFile(db.prisma, { tenantId, clientId, createdBy: userId })).id;
  });
  afterAll(async () => db.cleanup());

  async function draftEntry(entryNumber: string, lines: { code: string; debit?: string; credit?: string }[]) {
    const entry = await db.prisma.journalEntry.create({
      data: { tenantId, entryNumber, entryDate: new Date(), description: 'test', createdBy: userId },
    });
    for (const l of lines) {
      const acc = await accountByCode(db.prisma, tenantId, l.code);
      await db.prisma.journalEntryLine.create({
        data: {
          tenantId, journalEntryId: entry.id, accountId: acc.id, currencyCode: 'USD',
          exchangeRate: '1.0000000000', debit: l.debit ?? '0', credit: l.credit ?? '0',
          baseDebit: l.debit ?? '0', baseCredit: l.credit ?? '0', clearanceFileId: fileId,
        },
      });
    }
    return entry;
  }

  describe('journal entries', () => {
    it('posts a balanced client-advance entry (Dr Cash 1,000 / Cr Client advances 1,000)', async () => {
      const e = await draftEntry('JE-1', [
        { code: '1010', debit: '1000.0000' },
        { code: '2100', credit: '1000.0000' },
      ]);
      const posted = await db.prisma.journalEntry.update({
        where: { id: e.id }, data: { status: 'POSTED', postedAt: new Date() },
      });
      expect(posted.status).toBe('POSTED');
    });

    it('refuses to post an unbalanced entry', async () => {
      const e = await draftEntry('JE-2', [
        { code: '1010', debit: '1000.0000' },
        { code: '2100', credit: '999.9999' },
      ]);
      await expectRule(
        db.prisma.journalEntry.update({ where: { id: e.id }, data: { status: 'POSTED', postedAt: new Date() } }),
      /not balanced/i);
    });

    it('refuses to post an entry with fewer than two lines', async () => {
      const e = await draftEntry('JE-3', [{ code: '1010', debit: '5.0000' }]);
      await expectRule(
        db.prisma.journalEntry.update({ where: { id: e.id }, data: { status: 'POSTED', postedAt: new Date() } }),
      /at least two lines/i);
    });

    it('makes posted entries immutable (header, lines, delete)', async () => {
      const e = await db.prisma.journalEntry.findFirstOrThrow({ where: { tenantId, entryNumber: 'JE-1' } });
      await expectRule(
        db.prisma.journalEntry.update({ where: { id: e.id }, data: { description: 'tampered' } }),
      /immutable/i);
      const line = await db.prisma.journalEntryLine.findFirstOrThrow({ where: { journalEntryId: e.id } });
      await expectRule(
        db.prisma.journalEntryLine.update({ where: { id: line.id }, data: { debit: '1.0000' } }),
      /posted/i);
      await expectRule(db.prisma.journalEntryLine.delete({ where: { id: line.id } }), /posted/i);
      await expectRule(
        accountByCode(db.prisma, tenantId, '1010').then((acc) =>
          db.prisma.journalEntryLine.create({
            data: {
              tenantId, journalEntryId: e.id, accountId: acc.id, currencyCode: 'USD',
              exchangeRate: '1.0000000000', debit: '1.0000', baseDebit: '1.0000',
            },
          }),
        ),
      /posted/i);
      await expectRule(db.prisma.journalEntry.delete({ where: { id: e.id } }), /cannot be deleted/i);
    });

    it('corrects a posted entry only through a reversal entry', async () => {
      const original = await db.prisma.journalEntry.findFirstOrThrow({ where: { tenantId, entryNumber: 'JE-1' } });
      const reversal = await draftEntry('JE-1-REV', [
        { code: '1010', credit: '1000.0000' },
        { code: '2100', debit: '1000.0000' },
      ]);
      await db.prisma.journalEntry.update({
        where: { id: reversal.id }, data: { reversalOfId: original.id, sourceType: 'REVERSAL' },
      });
      await db.prisma.journalEntry.update({ where: { id: reversal.id }, data: { status: 'POSTED', postedAt: new Date() } });
      const reversed = await db.prisma.journalEntry.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
      expect(reversed.status).toBe('REVERSED');
      await expectRule(
        db.prisma.journalEntry.update({ where: { id: original.id }, data: { status: 'POSTED' } }),
      /immutable/i);
    });

    it('rejects negative or two-sided journal lines', async () => {
      const e = await db.prisma.journalEntry.create({
        data: { tenantId, entryNumber: 'JE-BAD', entryDate: new Date(), description: 'x', createdBy: userId },
      });
      const acc = await accountByCode(db.prisma, tenantId, '1010');
      const base = { tenantId, journalEntryId: e.id, accountId: acc.id, currencyCode: 'USD', exchangeRate: '1.0000000000' };
      await expectRule(
        db.prisma.journalEntryLine.create({ data: { ...base, debit: '-5.0000', baseDebit: '-5.0000' } }),
      /non-negative/i);
      await expectRule(
        db.prisma.journalEntryLine.create({
          data: { ...base, debit: '5.0000', credit: '5.0000', baseDebit: '5.0000', baseCredit: '5.0000' },
        }),
      /one-sided/i);
    });
  });

  describe('invoices, payments, expenses', () => {
    async function newInvoice(invoiceNumber: string) {
      return db.prisma.invoice.create({
        data: {
          tenantId, clearanceFileId: fileId, clientId, invoiceNumber, currencyCode: 'USD',
          subtotal: '300.0000', totalAmount: '300.0000', createdBy: userId,
        },
      });
    }

    it('lets a draft invoice change but freezes money fields once issued', async () => {
      const inv = await newInvoice('INV-1');
      await db.prisma.invoice.update({ where: { id: inv.id }, data: { totalAmount: '350.0000', subtotal: '350.0000' } });
      await db.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'ISSUED', issuedAt: new Date() } });
      await expectRule(
        db.prisma.invoice.update({ where: { id: inv.id }, data: { totalAmount: '1.0000' } }),
      /frozen/i);
    });

    it('never physically deletes invoices, payments, allocations or expenses', async () => {
      const inv = await newInvoice('INV-2');
      await expectRule(db.prisma.invoice.delete({ where: { id: inv.id } }), /cannot be deleted/i);
    });

    it('cancels instead of deleting, and a cancelled invoice cannot be reopened', async () => {
      const inv = await newInvoice('INV-3');
      await db.prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'issued in error' },
      });
      await expectRule(
        db.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'DRAFT' } }),
      /reopened|frozen/i);
    });

    it('freezes items of an issued invoice', async () => {
      const inv = await newInvoice('INV-4');
      const item = await db.prisma.invoiceItem.create({
        data: { tenantId, invoiceId: inv.id, description: 'Service fee', quantity: '1', unitPrice: '300', amount: '300' },
      });
      await db.prisma.invoice.update({ where: { id: inv.id }, data: { status: 'ISSUED', issuedAt: new Date() } });
      await expectRule(
        db.prisma.invoiceItem.update({ where: { id: item.id }, data: { amount: '1' } }),
      /issued invoice/i);
      await expectRule(db.prisma.invoiceItem.delete({ where: { id: item.id } }), /issued invoice/i);
    });

    it('supports one payment allocated across several invoices, and never deletes allocations', async () => {
      const i1 = await newInvoice('INV-5');
      const i2 = await newInvoice('INV-6');
      const cash = await db.prisma.cashAccount.findFirstOrThrow({ where: { tenantId, currencyCode: 'USD' } });
      const payment = await db.prisma.payment.create({
        data: {
          tenantId, clientId, paymentNumber: 'PAY-1', paymentType: 'CLIENT_PAYMENT', amount: '500.0000',
          currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '500.0000', paymentMethod: 'CASH',
          cashAccountId: cash.id, paymentDate: new Date(), receivedBy: userId, status: 'POSTED',
        },
      });
      const a1 = await db.prisma.paymentAllocation.create({
        data: { tenantId, paymentId: payment.id, invoiceId: i1.id, allocatedAmount: '300.0000', currencyCode: 'USD' },
      });
      await db.prisma.paymentAllocation.create({
        data: { tenantId, paymentId: payment.id, invoiceId: i2.id, allocatedAmount: '200.0000', currencyCode: 'USD' },
      });
      expect(await db.prisma.paymentAllocation.count({ where: { paymentId: payment.id } })).toBe(2);
      await expectRule(db.prisma.paymentAllocation.delete({ where: { id: a1.id } }), /cannot be deleted/i);
    });

    it('freezes the amount and historical exchange rate of a posted payment', async () => {
      const p = await db.prisma.payment.findFirstOrThrow({ where: { tenantId, paymentNumber: 'PAY-1' } });
      await expectRule(
        db.prisma.payment.update({ where: { id: p.id }, data: { exchangeRate: '2.0000000000' } }),
      /frozen/i);
      await expectRule(db.prisma.payment.delete({ where: { id: p.id } }), /cannot be deleted/i);
    });

    it('freezes the amount of an approved expense', async () => {
      const category = await db.prisma.financialCategory.findFirstOrThrow({ where: { tenantId } });
      const exp = await db.prisma.expense.create({
        data: {
          tenantId, clearanceFileId: fileId, categoryId: category.id, description: 'Port fee',
          amount: '120.0000', currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '120.0000',
          expenseDate: new Date(), recordedBy: userId, status: 'APPROVED',
        },
      });
      await expectRule(
        db.prisma.expense.update({ where: { id: exp.id }, data: { amount: '1.0000' } }),
      /frozen/i);
      await expectRule(db.prisma.expense.delete({ where: { id: exp.id } }), /cannot be deleted/i);
    });
  });

  describe('append-only data and system rows', () => {
    it('keeps exchange rates append-only so historical rates are never overwritten', async () => {
      const row = await db.prisma.exchangeRate.create({
        data: {
          tenantId, fromCurrency: 'USD', toCurrency: 'LBP', rate: '89500.0000000000',
          effectiveAt: new Date('2026-11-03T00:00:00Z'), source: 'manual', createdBy: userId,
        },
      });
      await expectRule(
        db.prisma.exchangeRate.update({ where: { id: row.id }, data: { rate: '1.0000000000' } }),
      /append-only/i);
      await expectRule(db.prisma.exchangeRate.delete({ where: { id: row.id } }), /append-only/i);
    });

    it('keeps audit logs and status history append-only', async () => {
      const log = await db.prisma.auditLog.create({
        data: { tenantId, actorUserId: userId, action: 'TEST', entityType: 'ClearanceFile', entityId: fileId },
      });
      await expectRule(db.prisma.auditLog.update({ where: { id: log.id }, data: { action: 'X' } }), /append-only/i);
      await expectRule(db.prisma.auditLog.delete({ where: { id: log.id } }), /append-only/i);
    });

    it('prevents duplicate system roles and document types (NULL tenant)', async () => {
      await expectRule(
        db.prisma.role.create({ data: { tenantId: null, code: 'OWNER', name: 'Dup', isSystem: true } }),
      /duplicate system role/i);
      await expectRule(
        db.prisma.documentType.create({ data: { tenantId: null, code: 'PACKING_LIST', nameEn: 'x', nameAr: 'x' } }),
      /duplicate system document type/i);
    });

    it('seeds system roles with the expected permissions', async () => {
      const viewer = await db.prisma.role.findFirstOrThrow({
        where: { tenantId: null, code: 'VIEWER' }, include: { permissions: { include: { permission: true } } },
      });
      expect(viewer.permissions.every((p) => p.permission.code.endsWith('.view'))).toBe(true);
      const accountant = await db.prisma.role.findFirstOrThrow({
        where: { tenantId: null, code: 'ACCOUNTANT' }, include: { permissions: { include: { permission: true } } },
      });
      const codes = accountant.permissions.map((p) => p.permission.code);
      expect(codes).toContain('accounting.post');
      expect(codes).not.toContain('users.manage');
    });
  });

  describe('default workflow seeding', () => {
    it('creates import, export and general templates with ordered stages', async () => {
      const templates = await db.prisma.workflowTemplate.findMany({
        where: { tenantId }, include: { stages: { orderBy: { sequence: 'asc' } } },
      });
      expect(templates.map((t) => t.fileType).sort()).toEqual(['EXPORT', 'IMPORT', 'OTHER']);
      const imp = templates.find((t) => t.fileType === 'IMPORT')!;
      expect(imp.stages).toHaveLength(8);
      expect(imp.stages[0].code).toBe('NEW_FILE');
      expect(imp.stages[7].isTerminal).toBe(true);
    });

    it('gates the declaration stage on required documents', async () => {
      const t = await db.prisma.workflowTransition.findFirstOrThrow({
        where: {
          tenantId, template: { fileType: 'IMPORT' },
          fromStage: { code: 'PRE_CLEARANCE' }, toStage: { code: 'DECLARATION_SUBMITTED' },
        },
      });
      expect(t.requiresDocumentCheck).toBe(true);
      expect(t.requiredPermission).toBe('clearance_files.transition');
    });

    it('requires a reason to move a file backwards, and never leaves the terminal stage', async () => {
      const back = await db.prisma.workflowTransition.findFirstOrThrow({
        where: {
          tenantId, template: { fileType: 'IMPORT' },
          fromStage: { code: 'DECLARATION_SUBMITTED' }, toStage: { code: 'PRE_CLEARANCE' },
        },
      });
      expect(back.requiresReason).toBe(true);
      const outOfTerminal = await db.prisma.workflowTransition.count({
        where: { tenantId, fromStage: { isTerminal: true } },
      });
      expect(outOfTerminal).toBe(0); // reopening goes through POST /clearance-files/:id/reopen
    });
  });
});
