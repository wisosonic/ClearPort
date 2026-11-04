import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { DECIMAL_SORT_LOAD_CAP, decimalSort, orderBy, pageArgs, paginated, sortRowsByDecimal } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ActivityService } from '../clearance-files/activity.service';
import { FilesService } from '../clearance-files/files.service';
import { ACCOUNTS, AccountingService, type PostingLine } from './accounting.service';
import type {
  approveExpenseSchema, CreateExpenseInput, expenseListQuerySchema, payExpenseSchema, UpdateExpenseInput,
} from './finance.schemas';
import { RatesService } from './rates.service';

const EXPENSE_SORT = ['expenseDate', 'createdAt', 'amount', 'status'] as const;
const LIVE_INVOICE = ['DRAFT', 'ISSUED'] as const;

/**
 * Expenses (spec 6.5). Recording an expense is a DRAFT; APPROVING it records it in the books:
 *
 *   pass-through category   Dr 1300 Client disbursements receivable   (money paid for the client, to be re-billed)
 *   office-expense category Dr 5100 Office operating expenses
 *   paid immediately        Cr cash / bank account (must hold the expense's currency)
 *   not yet paid            Cr 2200 Accounts payable  (settled later with POST /expenses/:id/pay)
 *
 * Pass-through money never touches revenue or profit; it only becomes income-neutral when the
 * invoice re-bills it and clears 1300.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(RatesService) private readonly rates: RatesService,
  ) {}

  // ───────────────────────────── read ─────────────────────────────

  async list(q: z.infer<typeof expenseListQuerySchema>) {
    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.paymentStatus) where.paymentStatus = q.paymentStatus;
    if (q.clearanceFileId) where.clearanceFileId = q.clearanceFileId;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.from || q.to) {
      where.expenseDate = {
        ...(q.from && { gte: new Date(`${q.from}T00:00:00.000Z`) }),
        ...(q.to && { lte: new Date(`${q.to}T23:59:59.999Z`) }),
      };
    }
    if (q.billed === 'true') where.invoiceItems = { some: { invoice: { status: { in: [...LIVE_INVOICE] } } } };
    if (q.billed === 'false') where.invoiceItems = { none: { invoice: { status: { in: [...LIVE_INVOICE] } } } };
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'expenses', columns: ['description'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const byAmount = decimalSort(q.sort, ['amount']);
    if (byAmount) {
      const all = await this.db.client.expense.findMany({ where, include: this.include, take: DECIMAL_SORT_LOAD_CAP });
      const sorted = sortRowsByDecimal(all, byAmount.field, byAmount.dir);
      return paginated(sorted.slice((q.page - 1) * q.limit, q.page * q.limit).map((r) => this.present(r)), q, sorted.length);
    }
    const [rows, total] = await Promise.all([
      this.db.client.expense.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, EXPENSE_SORT.filter((x) => x !== 'amount'), { expenseDate: 'desc' }), include: this.include,
      }),
      this.db.client.expense.count({ where }),
    ]);
    return paginated(rows.map((r) => this.present(r)), q, total);
  }

  async get(id: string) {
    const e = await this.db.client.expense.findUnique({ where: { id }, include: this.include });
    if (!e) throw notFound('EXPENSE_NOT_FOUND', 'Expense not found');
    return this.present(e);
  }

  private readonly include: any = {
    category: { select: { id: true, name: true, categoryType: true, costTreatment: true } },
    vendor: { select: { id: true, name: true } },
    clearanceFile: { select: { id: true, fileNumber: true } },
    cashAccount: { select: { id: true, name: true } },
    invoiceItems: { where: { invoice: { status: { in: [...LIVE_INVOICE] } } }, select: { invoice: { select: { id: true, invoiceNumber: true, status: true } } } },
  };

  private present(e: any) {
    const { invoiceItems, ...rest } = e;
    const invoice = invoiceItems?.[0]?.invoice ?? null;
    return { ...rest, billedOn: invoice, isBilled: !!invoice };
  }

  // ───────────────────────────── create / update ─────────────────────────────

  async create(auth: AuthContext, input: CreateExpenseInput, meta: RequestMeta) {
    const category = await this.requireCategory(input.categoryId);
    if (category.costTreatment === 'PASS_THROUGH' && !input.clearanceFileId) {
      throw unprocessable('FILE_REQUIRED_FOR_PASS_THROUGH', 'A pass-through expense is paid for a client, so it must be linked to a clearance file');
    }
    if (input.clearanceFileId) this.files.assertEditable(await this.files.require(input.clearanceFileId));
    if (input.vendorId) await this.assertVendor(input.vendorId);
    await this.rates.assertCurrency(input.currencyCode);

    const expenseDate = input.expenseDate ?? new Date();
    const r = await this.rates.resolve(auth.tenantId, input.currencyCode, expenseDate, input);
    const expense = await this.db.client.expense.create({
      data: {
        clearanceFileId: input.clearanceFileId ?? null, categoryId: input.categoryId, vendorId: input.vendorId ?? null,
        description: input.description, amount: input.amount, currencyCode: input.currencyCode,
        exchangeRate: r.rate, rateConvention: r.convention, rateSource: r.source, baseAmount: this.rates.toBase(input.amount, r),
        expenseDate, paidBy: category.costTreatment === 'PASS_THROUGH' ? 'ON_BEHALF_OF_CLIENT' : 'OFFICE',
        paymentStatus: 'UNPAID', status: 'DRAFT', recordedBy: auth.userId,
      } as any,
    });
    if (expense.clearanceFileId) {
      await this.activity.log(expense.clearanceFileId, auth.userId, 'EXPENSE_RECORDED',
        `Expense recorded: ${expense.description} (${expense.amount} ${expense.currencyCode})`, { expenseId: expense.id });
    }
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXPENSE_RECORDED', entityType: 'Expense', entityId: expense.id,
      after: expense, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(expense.id);
  }

  async update(auth: AuthContext, id: string, input: UpdateExpenseInput, meta: RequestMeta) {
    const before = await this.require(id);
    if (before.status !== 'DRAFT') throw conflict('EXPENSE_NOT_EDITABLE', 'Only a draft expense can be edited; cancel an approved one and record it again');
    const merged = { ...before, ...input } as typeof before;
    const category = await this.requireCategory(merged.categoryId);
    if (category.costTreatment === 'PASS_THROUGH' && !merged.clearanceFileId) {
      throw unprocessable('FILE_REQUIRED_FOR_PASS_THROUGH', 'A pass-through expense must be linked to a clearance file');
    }
    if (input.clearanceFileId) this.files.assertEditable(await this.files.require(input.clearanceFileId));
    if (input.vendorId) await this.assertVendor(input.vendorId);
    if (input.currencyCode) await this.rates.assertCurrency(input.currencyCode);

    const data: Record<string, unknown> = { ...input };
    delete data.exchangeRate; delete data.rateConvention; delete data.rateSource;
    // Keep the recorded rate unless something that determines it changed; the base amount always follows the amount.
    const rateInputsChanged = input.currencyCode !== undefined || input.expenseDate !== undefined || input.exchangeRate !== undefined;
    if (rateInputsChanged) {
      const r = await this.rates.resolve(auth.tenantId, merged.currencyCode, merged.expenseDate, input);
      Object.assign(data, { exchangeRate: r.rate, rateConvention: r.convention, rateSource: r.source, baseAmount: this.rates.toBase(merged.amount, r) });
    } else if (input.amount !== undefined) {
      data.baseAmount = this.rates.toBase(merged.amount, { rate: before.exchangeRate, convention: before.rateConvention });
    }
    if (input.categoryId) data.paidBy = category.costTreatment === 'PASS_THROUGH' ? 'ON_BEHALF_OF_CLIENT' : 'OFFICE';
    await this.db.client.expense.update({ where: { id }, data: data as any });
    const after = await this.get(id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXPENSE_UPDATED', entityType: 'Expense', entityId: id,
      before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  // ───────────────────────────── approve / pay / cancel ─────────────────────────────

  async approve(auth: AuthContext, id: string, input: z.infer<typeof approveExpenseSchema>, meta: RequestMeta) {
    const e = await this.require(id);
    if (e.status !== 'DRAFT') throw conflict('EXPENSE_NOT_DRAFT', `This expense is already ${e.status.toLowerCase()}`);
    if (e.clearanceFileId) this.files.assertEditable(await this.files.require(e.clearanceFileId));
    const category = await this.requireCategory(e.categoryId, true);
    const paidAt = input.paidAt ?? new Date();

    const debitAccount = category.costTreatment === 'PASS_THROUGH' ? ACCOUNTS.DISBURSEMENTS : ACCOUNTS.OFFICE_EXPENSES;
    const cash = input.cashAccountId ? await this.accounting.requireCashAccount(input.cashAccountId, e.currencyCode) : null;
    const base = { currency: e.currencyCode, amount: e.amount, rate: e.exchangeRate, convention: e.rateConvention as any, base: e.baseAmount, clearanceFileId: e.clearanceFileId };
    // Paid at once: the cash leaves at the expense's recorded rate, so the two sides are identical.
    const lines: PostingLine[] = [
      { account: debitAccount, side: 'DEBIT', ...base },
      { account: cash ? cash.ledger.accountCode : ACCOUNTS.PAYABLES, side: 'CREDIT', ...base },
    ];

    await this.db.client.$transaction(async (tx) => {
      const claimed = await tx.expense.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'APPROVED', approvedBy: auth.userId, approvedAt: new Date(),
          ...(cash ? { paymentStatus: 'PAID', cashAccountId: cash.id, paidAt } : {}),
        },
      });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The expense was changed by someone else; reload and try again');
      await this.accounting.post(tx, {
        entryDate: e.expenseDate, description: `Expense: ${e.description}`, sourceType: 'EXPENSE', sourceId: id, createdBy: auth.userId, lines,
      });
      if (e.clearanceFileId) {
        await this.activity.log(e.clearanceFileId, auth.userId, 'EXPENSE_APPROVED',
          `Expense approved: ${e.description} (${e.amount} ${e.currencyCode})${cash ? ` — paid from ${cash.name}` : ' — payable'}`, { expenseId: id }, tx);
      }
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXPENSE_APPROVED', entityType: 'Expense', entityId: id,
      before: { status: 'DRAFT' }, after: { status: 'APPROVED', paid: !!cash, treatment: category.costTreatment }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  /** Settles an approved, unpaid expense from a cash account. A change in the rate since approval becomes a realized FX difference. */
  async pay(auth: AuthContext, id: string, input: z.infer<typeof payExpenseSchema>, meta: RequestMeta) {
    const e = await this.require(id);
    if (e.status !== 'APPROVED') throw conflict('EXPENSE_NOT_APPROVED', 'Only an approved expense can be paid');
    if (e.paymentStatus === 'PAID') throw conflict('EXPENSE_ALREADY_PAID', 'This expense is already paid');
    const cash = await this.accounting.requireCashAccount(input.cashAccountId, e.currencyCode);
    const paidAt = input.paidAt ?? new Date();
    const baseCurrency = await this.rates.baseCurrency(auth.tenantId);
    const payRate = await this.rates.resolve(auth.tenantId, e.currencyCode, paidAt);

    // The payable is cleared at its carrying (approval-time) value; cash leaves at today's value.
    const lines = this.accounting.withFxPlug([
      { account: ACCOUNTS.PAYABLES, side: 'DEBIT', currency: e.currencyCode, amount: e.amount, rate: e.exchangeRate, convention: e.rateConvention as any, base: e.baseAmount, clearanceFileId: e.clearanceFileId },
      { account: cash.ledger.accountCode, side: 'CREDIT', currency: e.currencyCode, amount: e.amount, rate: payRate.rate, convention: payRate.convention, base: this.rates.toBase(e.amount, payRate), clearanceFileId: e.clearanceFileId },
    ], baseCurrency, e.clearanceFileId);

    await this.db.client.$transaction(async (tx) => {
      const claimed = await tx.expense.updateMany({ where: { id, status: 'APPROVED', paymentStatus: 'UNPAID' }, data: { paymentStatus: 'PAID', cashAccountId: cash.id, paidAt } });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The expense was changed by someone else; reload and try again');
      await this.accounting.post(tx, { entryDate: paidAt, description: `Payment of expense: ${e.description}`, sourceType: 'EXPENSE', sourceId: id, createdBy: auth.userId, lines });
      if (e.clearanceFileId) {
        await this.activity.log(e.clearanceFileId, auth.userId, 'EXPENSE_PAID', `Expense paid from ${cash.name}: ${e.description}`, { expenseId: id }, tx);
      }
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXPENSE_PAID', entityType: 'Expense', entityId: id,
      after: { cashAccountId: cash.id, paidAt }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  /** Cancels an expense. An approved one is reversed in the books (never edited or deleted); one already re-billed to a client must be un-billed first. */
  async cancel(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const e = await this.require(id);
    if (e.status === 'CANCELLED') throw conflict('EXPENSE_ALREADY_CANCELLED', 'This expense is already cancelled');
    if (e.status === 'APPROVED') {
      const billed = await this.db.client.invoiceItem.findFirst({ where: { expenseId: id, invoice: { status: { in: [...LIVE_INVOICE] } } }, include: { invoice: { select: { invoiceNumber: true } } } });
      if (billed) throw conflict('EXPENSE_ALREADY_BILLED', `This expense is on invoice ${billed.invoice.invoiceNumber}; cancel or edit that invoice first`);
      if (e.clearanceFileId) this.files.assertEditable(await this.files.require(e.clearanceFileId));
    }
    await this.db.client.$transaction(async (tx) => {
      if (e.status === 'APPROVED') await this.accounting.reverseBySource(tx, 'EXPENSE', id, { reason: `Expense cancelled: ${reason}`, userId: auth.userId });
      await tx.expense.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      if (e.clearanceFileId) await this.activity.log(e.clearanceFileId, auth.userId, 'EXPENSE_CANCELLED', `Expense cancelled: ${e.description} — ${reason}`, { expenseId: id }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXPENSE_CANCELLED', entityType: 'Expense', entityId: id,
      before: { status: e.status }, after: { status: 'CANCELLED', reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async require(id: string) {
    const e = await this.db.client.expense.findUnique({ where: { id } });
    if (!e) throw notFound('EXPENSE_NOT_FOUND', 'Expense not found');
    return e;
  }

  private async requireCategory(id: string, allowInactive = false) {
    const c = await this.db.client.financialCategory.findUnique({ where: { id } });
    if (!c || (!c.isActive && !allowInactive)) throw unprocessable('CATEGORY_NOT_FOUND', 'Category not found or inactive');
    if (c.costTreatment === 'OFFICE_REVENUE') {
      throw unprocessable('CATEGORY_NOT_FOR_EXPENSES', `"${c.name}" is a fee the office earns, not a cost; choose a cost category`);
    }
    return c;
  }

  private async assertVendor(vendorId: string) {
    if (!(await this.db.client.businessParty.findUnique({ where: { id: vendorId } }))) {
      throw unprocessable('VENDOR_NOT_FOUND', 'Vendor not found in your office');
    }
  }
}
