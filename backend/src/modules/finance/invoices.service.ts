import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { add, compare, mul, sub, sum, ZERO, type DecimalString } from '../../common/money';
import { nextDocumentNumber } from '../../common/numbering';
import { DECIMAL_SORT_LOAD_CAP, decimalSort, orderBy, pageArgs, paginated, sortRowsByDecimal } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ActivityService } from '../clearance-files/activity.service';
import { FilesService } from '../clearance-files/files.service';
import { ACCOUNTS, AccountingService, type PostingLine } from './accounting.service';
import { FinanceSetupService } from './finance-setup.service';
import type {
  CreateInvoiceInput, invoiceListQuerySchema, InvoiceItemInput, issueInvoiceSchema, UpdateInvoiceInput,
} from './finance.schemas';
import { computeInvoiceTotals, DiscountTooLargeError, type TotalsInput } from './invoice-totals';
import { RatesService } from './rates.service';

const LIVE = ['DRAFT', 'ISSUED'] as const;
const INVOICE_SORT = ['issueDate', 'createdAt', 'invoiceNumber', 'totalAmount', 'dueDate'] as const;

interface NormalisedItem {
  description: string;
  categoryId: string | null;
  quantity: DecimalString;
  unitPrice: DecimalString;
  amount: DecimalString;
  expenseId: string | null;
  treatment: 'PASS_THROUGH' | 'OFFICE_REVENUE';
  taxable: boolean;
  /** the re-billed expense's recorded base value and rate: used to clear the disbursement exactly */
  expense?: { baseAmount: DecimalString; amount: DecimalString; rate: DecimalString; convention: any; currency: string };
}

/**
 * Invoices (spec 6.4). Lifecycle: DRAFT (editable, no number, no accounting) → ISSUED (numbered,
 * frozen, posted to the ledger) → CANCELLED (reversed). Paid / outstanding amounts are NEVER stored:
 * they are derived from payment allocations on every read.
 *
 * Posting at issue (non-advance invoices), currency C:
 *   Dr 1200 Accounts receivable      total
 *   Cr 4100 Service revenue          service fees after discount
 *   Cr 2300 Taxes payable            tax
 *   Cr 1300 Client disbursements     each re-billed expense, at the base value it was booked with
 *
 * ADVANCE invoices are requests for funds, not sales: they get a number but post nothing; money
 * the client sends against them is received as an advance (a liability) like any other receipt.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(FinanceSetupService) private readonly setup: FinanceSetupService,
  ) {}

  // ═══════════════════════════ read ═══════════════════════════

  async list(q: z.infer<typeof invoiceListQuerySchema>, forFileId?: string) {
    const where: any = {};
    const fileId = forFileId ?? q.clearanceFileId;
    if (fileId) where.clearanceFileId = fileId;
    if (q.status) where.status = q.status;
    if (q.invoiceType) where.invoiceType = q.invoiceType;
    if (q.clientId) where.clientId = q.clientId;
    if (q.from || q.to) {
      where.issueDate = {
        ...(q.from && { gte: new Date(`${q.from}T00:00:00.000Z`) }),
        ...(q.to && { lte: new Date(`${q.to}T23:59:59.999Z`) }),
      };
    }
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'invoices', columns: ['invoiceNumber'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const byTotal = decimalSort(q.sort, ['totalAmount']);
    const sort = orderBy(q.sort, INVOICE_SORT.filter((x) => x !== 'totalAmount'), { createdAt: 'desc' });
    const needsDerived = q.unpaid !== undefined || q.overdue !== undefined;
    if (byTotal && !needsDerived) {
      const all = await this.db.client.invoice.findMany({ where, include: this.listInclude, take: DECIMAL_SORT_LOAD_CAP });
      const sorted = sortRowsByDecimal(all, byTotal.field, byTotal.dir);
      return paginated(await this.attachDerived(sorted.slice((q.page - 1) * q.limit, q.page * q.limit)), q, sorted.length);
    }
    if (needsDerived) {
      where.status = q.status ?? 'ISSUED';
      const all = await this.db.client.invoice.findMany({ where, orderBy: sort, include: this.listInclude, take: DECIMAL_SORT_LOAD_CAP });
      const withDerived = byTotal ? sortRowsByDecimal(await this.attachDerived(all), byTotal.field, byTotal.dir) : await this.attachDerived(all);
      const now = Date.now();
      const filtered = withDerived.filter((i) => {
        const unpaid = compare(i.outstandingAmount, ZERO) > 0 && i.invoiceType !== 'ADVANCE';
        if (q.unpaid === 'true' && !unpaid) return false;
        if (q.unpaid === 'false' && unpaid) return false;
        if (q.overdue === 'true' && !(unpaid && i.dueDate && i.dueDate.getTime() < now)) return false;
        if (q.overdue === 'false' && unpaid && i.dueDate && i.dueDate.getTime() < now) return false;
        return true;
      });
      const page = filtered.slice((q.page - 1) * q.limit, q.page * q.limit);
      return paginated(page, q, filtered.length);
    }
    const [rows, total] = await Promise.all([
      this.db.client.invoice.findMany({ where, ...pageArgs(q), orderBy: sort, include: this.listInclude }),
      this.db.client.invoice.count({ where }),
    ]);
    return paginated(await this.attachDerived(rows), q, total);
  }

  async get(id: string) {
    const inv = await this.db.client.invoice.findUnique({
      where: { id },
      include: {
        ...this.listInclude,
        items: { orderBy: { id: 'asc' }, include: { category: { select: { id: true, name: true, costTreatment: true } }, expense: { select: { id: true, description: true } } } },
        allocations: { orderBy: { createdAt: 'asc' }, include: { payment: { select: { id: true, paymentNumber: true, paymentDate: true, currencyCode: true, status: true } } } },
      },
    });
    if (!inv) throw notFound('INVOICE_NOT_FOUND', 'Invoice not found');
    const [withDerived] = await this.attachDerived([inv]);
    return withDerived;
  }

  private readonly listInclude: any = {
    client: { select: { id: true, clientCode: true, name: true } },
    clearanceFile: { select: { id: true, fileNumber: true } },
  };

  /** paidAmount / outstandingAmount / paymentStatus — derived from allocations, never stored (spec 6.4). */
  private async attachDerived<T extends { id: string; totalAmount: string; status: string; dueDate: Date | null }>(invoices: T[]) {
    const ids = invoices.map((i) => i.id);
    const allocs = ids.length
      ? await this.db.client.paymentAllocation.findMany({
        where: { invoiceId: { in: ids }, reversedAt: null, payment: { status: 'POSTED' } }, select: { invoiceId: true, allocatedAmount: true },
      })
      : [];
    // an ADVANCE invoice is answered by advance payments received against it (no allocation, no ledger effect)
    const advancePays = ids.length
      ? await this.db.client.payment.findMany({ where: { advanceInvoiceId: { in: ids }, status: 'POSTED' }, select: { advanceInvoiceId: true, amount: true } })
      : [];
    return invoices.map((i) => {
      const paid = sum([
        ...allocs.filter((a) => a.invoiceId === i.id).map((a) => a.allocatedAmount),
        ...advancePays.filter((p) => p.advanceInvoiceId === i.id).map((p) => p.amount),
      ]);
      const outstanding = i.status === 'ISSUED' ? sub(i.totalAmount, paid) : i.status === 'DRAFT' ? i.totalAmount : ZERO;
      const paymentStatus = i.status !== 'ISSUED' ? null : compare(outstanding, ZERO) <= 0 ? 'PAID' : compare(paid, ZERO) > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
      return {
        ...i, paidAmount: paid, outstandingAmount: outstanding, paymentStatus,
        isOverdue: paymentStatus !== null && paymentStatus !== 'PAID' && !!i.dueDate && i.dueDate.getTime() < Date.now() && (i as any).invoiceType !== 'ADVANCE',
      };
    });
  }

  // ═══════════════════════════ draft ═══════════════════════════

  async create(auth: AuthContext, input: CreateInvoiceInput, meta: RequestMeta) {
    const file = await this.files.require(input.clearanceFileId);
    this.files.assertEditable(file);
    const currency = input.currencyCode ?? (await this.rates.baseCurrency(auth.tenantId));
    await this.rates.assertCurrency(currency);
    const items = await this.normaliseItems(file.id, currency, input.items, input.invoiceType);
    const totals = await this.totals(items, input.discount, input.invoiceType);

    const invoice = await this.db.client.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          clearanceFileId: file.id, clientId: file.clientId, invoiceNumber: `DRAFT-${randomBytes(4).toString('hex').toUpperCase()}`,
          invoiceType: input.invoiceType, currencyCode: currency, dueDate: input.dueDate ?? null, status: 'DRAFT',
          subtotal: totals.subtotal, discount: totals.discount, taxAmount: totals.taxAmount, totalAmount: totals.total, createdBy: auth.userId,
        } as any,
      });
      await this.writeItems(tx, inv.id, items, totals);
      await this.activity.log(file.id, auth.userId, 'INVOICE_DRAFTED', `Draft ${input.invoiceType.toLowerCase()} invoice created (${totals.total} ${currency})`, { invoiceId: inv.id }, tx);
      return inv;
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'INVOICE_DRAFTED', entityType: 'Invoice', entityId: invoice.id,
      after: { clearanceFileId: file.id, total: totals.total, currency }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(invoice.id);
  }

  async update(auth: AuthContext, id: string, input: UpdateInvoiceInput, meta: RequestMeta) {
    const before = await this.require(id);
    if (before.status !== 'DRAFT') throw conflict('INVOICE_NOT_EDITABLE', 'Only a draft invoice can be edited; cancel an issued one and create a new invoice');
    this.files.assertEditable(await this.files.require(before.clearanceFileId));

    const type = input.invoiceType ?? before.invoiceType;
    const currency = input.currencyCode ?? before.currencyCode;
    if (input.currencyCode) await this.rates.assertCurrency(currency);
    const itemInputs = input.items ?? (await this.currentItemInputs(id));
    const discount = input.discount ?? before.discount;
    const items = await this.normaliseItems(before.clearanceFileId, currency, itemInputs, type, id);
    const totals = await this.totals(items, discount, type);

    await this.db.client.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await this.writeItems(tx, id, items, totals);
      await tx.invoice.update({
        where: { id },
        data: {
          invoiceType: type, currencyCode: currency, ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
          subtotal: totals.subtotal, discount: totals.discount, taxAmount: totals.taxAmount, totalAmount: totals.total,
        },
      });
    });
    const after = await this.get(id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'INVOICE_DRAFT_UPDATED', entityType: 'Invoice', entityId: id,
      before: { total: before.totalAmount, currency: before.currencyCode }, after: { total: after.totalAmount, currency: after.currencyCode }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  // ═══════════════════════════ issue ═══════════════════════════

  async issue(auth: AuthContext, id: string, input: z.infer<typeof issueInvoiceSchema>, meta: RequestMeta) {
    const inv = await this.require(id);
    if (inv.status !== 'DRAFT') throw conflict('INVOICE_NOT_DRAFT', `This invoice is already ${inv.status.toLowerCase()}`);
    const file = await this.files.require(inv.clearanceFileId);
    this.files.assertEditable(file);
    const client = await this.db.client.client.findUniqueOrThrow({ where: { id: inv.clientId } });

    // Everything is re-validated at issue time: an expense may have been cancelled or re-billed since the draft.
    const itemInputs = await this.currentItemInputs(id);
    const items = await this.normaliseItems(inv.clearanceFileId, inv.currencyCode, itemInputs, inv.invoiceType, id);
    const totals = await this.totals(items, inv.discount, inv.invoiceType);
    if (compare(totals.total, ZERO) <= 0) throw unprocessable('INVOICE_TOTAL_ZERO', 'An invoice with a zero total cannot be issued');

    const issueDate = input.issueDate ?? new Date();
    const dueDate = input.dueDate ?? inv.dueDate ?? new Date(issueDate.getTime() + client.paymentTermsDays * 86_400_000);
    const r = await this.rates.resolve(auth.tenantId, inv.currencyCode, issueDate, input);
    const posts = inv.invoiceType !== 'ADVANCE';

    // Component bases. The receivable is the SUM of its parts, so the entry balances exactly with no rounding noise.
    const revenueBase = this.rates.toBase(totals.revenue, r);
    const taxBase = compare(totals.taxAmount, ZERO) > 0 ? this.rates.toBase(totals.taxAmount, r) : ZERO;
    const passItems = items.filter((i) => i.treatment === 'PASS_THROUGH');
    const passBase = sum(passItems.map((i) => i.expense!.baseAmount));
    const receivableBase = posts ? add(add(revenueBase, taxBase), passBase) : this.rates.toBase(totals.total, r);

    const lines: PostingLine[] = [];
    if (posts) {
      const common = { currency: inv.currencyCode, clearanceFileId: inv.clearanceFileId };
      lines.push({ account: ACCOUNTS.RECEIVABLES, side: 'DEBIT', amount: totals.total, rate: r.rate, convention: r.convention, base: receivableBase, ...common });
      if (compare(totals.revenue, ZERO) > 0) lines.push({ account: ACCOUNTS.SERVICE_REVENUE, side: 'CREDIT', amount: totals.revenue, rate: r.rate, convention: r.convention, base: revenueBase, ...common });
      if (compare(totals.taxAmount, ZERO) > 0) lines.push({ account: ACCOUNTS.TAXES_PAYABLE, side: 'CREDIT', amount: totals.taxAmount, rate: r.rate, convention: r.convention, base: taxBase, ...common });
      for (const it of passItems) {
        lines.push({ account: ACCOUNTS.DISBURSEMENTS, side: 'CREDIT', amount: it.amount, rate: it.expense!.rate, convention: it.expense!.convention, base: it.expense!.baseAmount, ...common });
      }
    }

    const issued = await this.db.client.$transaction(async (tx) => {
      const invoiceNumber = await nextDocumentNumber(tx, auth.tenantId, 'INV', issueDate.getUTCFullYear());
      // Refresh the stored lines with the final tax figures WHILE STILL A DRAFT: the lines of an issued
      // invoice are frozen by the database. If a concurrent issue wins, this whole transaction rolls back.
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await this.writeItems(tx, id, items, totals);
      const claimed = await tx.invoice.updateMany({
        where: { id, status: 'DRAFT' },
        data: {
          invoiceNumber, status: 'ISSUED', issueDate, dueDate, issuedAt: new Date(),
          subtotal: totals.subtotal, discount: totals.discount, taxAmount: totals.taxAmount, totalAmount: totals.total,
          exchangeRate: r.rate, rateConvention: r.convention, rateSource: r.source, baseTotalAmount: receivableBase,
        },
      });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The invoice was changed by someone else; reload and try again');
      if (posts) {
        await this.accounting.post(tx, {
          entryDate: issueDate, description: `Invoice ${invoiceNumber}`, sourceType: 'INVOICE', sourceId: id, createdBy: auth.userId, lines,
        });
      }
      await this.activity.log(inv.clearanceFileId, auth.userId, 'INVOICE_ISSUED',
        `Invoice ${invoiceNumber} issued: ${totals.total} ${inv.currencyCode}`, { invoiceId: id, invoiceNumber }, tx);
      return invoiceNumber;
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: id,
      after: { invoiceNumber: issued, total: totals.total, currency: inv.currencyCode, rate: r.rate, rateConvention: r.convention, baseTotal: receivableBase, posted: posts },
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ═══════════════════════════ cancel ═══════════════════════════

  async cancel(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const inv = await this.require(id);
    if (inv.status === 'CANCELLED') throw conflict('INVOICE_ALREADY_CANCELLED', 'This invoice is already cancelled');
    if (inv.status === 'ISSUED') {
      const live = await this.db.client.paymentAllocation.findMany({
        where: { invoiceId: id, reversedAt: null }, include: { payment: { select: { paymentNumber: true } } },
      });
      if (live.length) {
        throw conflict('INVOICE_HAS_ALLOCATIONS', 'Reverse the payment allocations on this invoice before cancelling it',
          live.map((a) => ({ paymentNumber: a.payment.paymentNumber, allocatedAmount: a.allocatedAmount })));
      }
      this.files.assertEditable(await this.files.require(inv.clearanceFileId));
    }
    await this.db.client.$transaction(async (tx) => {
      if (inv.status === 'ISSUED') await this.accounting.reverseBySource(tx, 'INVOICE', id, { reason: `Invoice ${inv.invoiceNumber} cancelled: ${reason}`, userId: auth.userId });
      await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.activity.log(inv.clearanceFileId, auth.userId, 'INVOICE_CANCELLED', `Invoice ${inv.invoiceNumber} cancelled — ${reason}`, { invoiceId: id }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'INVOICE_CANCELLED', entityType: 'Invoice', entityId: id,
      before: { status: inv.status, invoiceNumber: inv.invoiceNumber }, after: { status: 'CANCELLED', reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ═══════════════════════════ items and totals ═══════════════════════════

  /**
   * Turns the user's lines into validated, priced lines.
   *  - a line that re-bills an expense is a pass-through line at cost (quantity 1, unit price = expense amount)
   *  - a pass-through category WITHOUT an expense is refused (it would credit disbursements that were never debited)
   *  - cost-only categories are refused; service-fee lines need description, category and unit price
   */
  private async normaliseItems(fileId: string, currency: string, inputs: InvoiceItemInput[], type: string, excludeInvoiceId?: string): Promise<NormalisedItem[]> {
    const seen = new Set<string>();
    const out: NormalisedItem[] = [];
    for (const [i, it] of inputs.entries()) {
      const at = [{ path: `items.${i}` }];
      if (it.expenseId) {
        if (type === 'ADVANCE') throw unprocessable('ADVANCE_CANNOT_REBILL', 'An advance invoice is a request for funds and cannot re-bill expenses', at);
        if (seen.has(it.expenseId)) throw unprocessable('EXPENSE_DUPLICATED', 'The same expense appears twice on this invoice', at);
        seen.add(it.expenseId);
        const e = await this.db.client.expense.findUnique({ where: { id: it.expenseId }, include: { category: true } });
        if (!e) throw unprocessable('EXPENSE_NOT_FOUND', 'Expense not found in your office', at);
        if (e.clearanceFileId !== fileId) throw unprocessable('EXPENSE_FILE_MISMATCH', 'That expense belongs to a different clearance file', at);
        if (e.status !== 'APPROVED') throw unprocessable('EXPENSE_NOT_APPROVED', 'Only an approved expense can be re-billed', at);
        if (e.category.costTreatment !== 'PASS_THROUGH' || !e.category.isBillableToClient) throw unprocessable('EXPENSE_NOT_BILLABLE', 'That expense is not billable to the client', at);
        if (e.currencyCode !== currency) throw unprocessable('EXPENSE_CURRENCY_MISMATCH', `The expense is in ${e.currencyCode}; this invoice is in ${currency}`, at);
        if (it.categoryId && it.categoryId !== e.categoryId) throw unprocessable('EXPENSE_CATEGORY_MISMATCH', 'The line category must match the expense category', at);
        const other = await this.db.client.invoiceItem.findFirst({
          where: { expenseId: e.id, invoice: { status: { in: [...LIVE] }, ...(excludeInvoiceId && { id: { not: excludeInvoiceId } }) } },
          include: { invoice: { select: { invoiceNumber: true, status: true } } },
        });
        if (other) throw conflict('EXPENSE_ALREADY_BILLED', `This expense is already on ${other.invoice.status === 'DRAFT' ? 'a draft' : 'invoice'} ${other.invoice.invoiceNumber}`, at);
        out.push({
          description: it.description ?? e.description, categoryId: e.categoryId, quantity: '1.0000', unitPrice: e.amount, amount: e.amount,
          expenseId: e.id, treatment: 'PASS_THROUGH', taxable: e.category.isTaxable,
          expense: { baseAmount: e.baseAmount, amount: e.amount, rate: e.exchangeRate, convention: e.rateConvention, currency: e.currencyCode },
        });
        continue;
      }

      if (!it.description) throw unprocessable('ITEM_DESCRIPTION_REQUIRED', 'Each line needs a description', at);
      if (it.unitPrice === undefined) throw unprocessable('ITEM_PRICE_REQUIRED', 'Each line needs a unit price', at);
      const quantity = it.quantity ?? '1.0000';
      const amount = mul(quantity, it.unitPrice);
      if (type === 'ADVANCE') {
        out.push({ description: it.description, categoryId: it.categoryId ?? null, quantity, unitPrice: it.unitPrice, amount, expenseId: null, treatment: 'OFFICE_REVENUE', taxable: false });
        continue;
      }
      if (!it.categoryId) throw unprocessable('ITEM_CATEGORY_REQUIRED', 'Each line needs a category', at);
      const cat = await this.db.client.financialCategory.findUnique({ where: { id: it.categoryId } });
      if (!cat || !cat.isActive) throw unprocessable('CATEGORY_NOT_FOUND', 'Category not found or inactive', at);
      if (cat.costTreatment === 'PASS_THROUGH') {
        throw unprocessable('PASS_THROUGH_NEEDS_EXPENSE', `"${cat.name}" is billed at cost: record and approve the expense, then re-bill it by expenseId`, at);
      }
      if (cat.costTreatment !== 'OFFICE_REVENUE' || !cat.isBillableToClient) {
        throw unprocessable('CATEGORY_NOT_BILLABLE', `"${cat.name}" cannot be billed to a client`, at);
      }
      out.push({ description: it.description, categoryId: cat.id, quantity, unitPrice: it.unitPrice, amount, expenseId: null, treatment: 'OFFICE_REVENUE', taxable: cat.isTaxable });
    }
    return out;
  }

  private async totals(items: NormalisedItem[], discount: DecimalString, type: string) {
    if (type === 'ADVANCE' && compare(discount, ZERO) !== 0) throw unprocessable('ADVANCE_NO_DISCOUNT', 'An advance invoice cannot carry a discount');
    const rate = type === 'ADVANCE' ? null : await this.setup.activeRate();
    try {
      return computeInvoiceTotals(items as TotalsInput[], discount, rate);
    } catch (e) {
      if (e instanceof DiscountTooLargeError) throw unprocessable('DISCOUNT_TOO_LARGE', `The discount cannot exceed the service-fee total (${e.maxDiscount})`, [{ maxDiscount: e.maxDiscount }]);
      throw e;
    }
  }

  private async writeItems(tx: any, invoiceId: string, items: NormalisedItem[], totals: ReturnType<typeof computeInvoiceTotals>) {
    for (const [i, it] of items.entries()) {
      await tx.invoiceItem.create({
        data: {
          // Time-ordered id: the line's position is its first 8 hex digits, so ordering by id returns lines in the order entered.
          id: `${i.toString(16).padStart(8, '0')}${randomUUID().slice(8)}`,
          invoiceId, description: it.description, categoryId: it.categoryId, quantity: it.quantity, unitPrice: it.unitPrice,
          amount: it.amount, taxRate: totals.items[i].taxRate, taxAmount: totals.items[i].taxAmount, expenseId: it.expenseId,
        },
      });
    }
  }

  private async currentItemInputs(invoiceId: string): Promise<InvoiceItemInput[]> {
    const rows = await this.db.client.invoiceItem.findMany({ where: { invoiceId }, orderBy: { id: 'asc' } });
    return rows.map((r) => (r.expenseId
      ? { expenseId: r.expenseId, description: r.description }
      : { description: r.description, categoryId: r.categoryId ?? undefined, quantity: r.quantity, unitPrice: r.unitPrice }));
  }

  private async require(id: string) {
    const inv = await this.db.client.invoice.findUnique({ where: { id } });
    if (!inv) throw notFound('INVOICE_NOT_FOUND', 'Invoice not found');
    return inv;
  }
}
