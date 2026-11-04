import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { compare, sub, sum, ZERO, type DecimalString } from '../../common/money';
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
import type { AllocationInput, CreatePaymentInput, paymentListQuerySchema } from './finance.schemas';
import { RatesService } from './rates.service';

const PAYMENT_SORT = ['paymentDate', 'createdAt', 'amount', 'paymentNumber'] as const;
const RECEIPT_TYPES = ['CLIENT_PAYMENT', 'CLIENT_ADVANCE'];
const OUT_TYPES = ['REFUND', 'REIMBURSEMENT'];

/**
 * Payments and allocations (spec 6.3 / 6.4).
 *
 *   Receive money (payment or advance)  Dr cash / bank       Cr 2100 Client advances  (a LIABILITY: held for the client)
 *   Allocate to an invoice              Dr 2100 Client adv.  Cr 1200 Receivables      (+ FX difference, if any)
 *   Refund unapplied credit             Dr 2100 Client adv.  Cr cash / bank
 *
 * So money received is NEVER revenue; revenue is recognised only when an invoice is issued. 2100 is
 * the unapplied credit and 1200 the open invoices, exactly as the client balance reports them.
 *
 * Allocations may cross currencies: the payment is converted at the payment date's rate (or the
 * caller states the invoice amount). Any difference between what the payment is worth and the
 * invoice's carrying value becomes a realized FX gain / loss (4300), so every entry balances exactly.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(RatesService) private readonly rates: RatesService,
  ) {}

  // ═══════════════════════════ read ═══════════════════════════

  async list(q: z.infer<typeof paymentListQuerySchema>) {
    const where: any = {};
    if (q.clientId) where.clientId = q.clientId;
    if (q.clearanceFileId) where.clearanceFileId = q.clearanceFileId;
    if (q.paymentType) where.paymentType = q.paymentType;
    if (q.status) where.status = q.status;
    if (q.cashAccountId) where.cashAccountId = q.cashAccountId;
    if (q.from || q.to) {
      where.paymentDate = {
        ...(q.from && { gte: new Date(`${q.from}T00:00:00.000Z`) }),
        ...(q.to && { lte: new Date(`${q.to}T23:59:59.999Z`) }),
      };
    }
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'payments', columns: ['paymentNumber', 'referenceNumber'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const byAmount = decimalSort(q.sort, ['amount']);
    const sort = orderBy(q.sort, PAYMENT_SORT.filter((x) => x !== 'amount'), { paymentDate: 'desc' });
    if (byAmount && q.unallocated === undefined) {
      const all = await this.db.client.payment.findMany({ where, include: this.include, take: DECIMAL_SORT_LOAD_CAP });
      const sorted = sortRowsByDecimal(all, byAmount.field, byAmount.dir);
      return paginated(await this.attachDerived(sorted.slice((q.page - 1) * q.limit, q.page * q.limit)), q, sorted.length);
    }
    if (q.unallocated !== undefined) {
      where.paymentType = where.paymentType ?? { in: RECEIPT_TYPES };
      where.status = 'POSTED';
      const all = await this.db.client.payment.findMany({ where, orderBy: sort, include: this.include, take: DECIMAL_SORT_LOAD_CAP });
      const derived = byAmount ? sortRowsByDecimal(await this.attachDerived(all), byAmount.field, byAmount.dir) : await this.attachDerived(all);
      const filtered = derived.filter((p) => (compare(p.unallocatedAmount, ZERO) > 0) === (q.unallocated === 'true'));
      return paginated(filtered.slice((q.page - 1) * q.limit, q.page * q.limit), q, filtered.length);
    }
    const [rows, total] = await Promise.all([
      this.db.client.payment.findMany({ where, ...pageArgs(q), orderBy: sort, include: this.include }),
      this.db.client.payment.count({ where }),
    ]);
    return paginated(await this.attachDerived(rows), q, total);
  }

  async get(id: string) {
    const p = await this.db.client.payment.findUnique({
      where: { id },
      include: {
        ...this.include,
        allocations: { orderBy: { createdAt: 'asc' }, include: { invoice: { select: { id: true, invoiceNumber: true, currencyCode: true, invoiceType: true } } } },
      },
    });
    if (!p) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    const [d] = await this.attachDerived([p]);
    return d;
  }

  private readonly include: any = {
    client: { select: { id: true, clientCode: true, name: true } },
    cashAccount: { select: { id: true, name: true } },
  };

  /** unallocatedAmount is derived (never stored): what is still held for the client from this receipt. */
  private async attachDerived<T extends { id: string; amount: string; paymentType: string; status: string }>(payments: T[]) {
    const ids = payments.map((p) => p.id);
    const allocs = ids.length
      ? await this.db.client.paymentAllocation.findMany({ where: { paymentId: { in: ids }, reversedAt: null }, select: { paymentId: true, paymentAmount: true } })
      : [];
    return payments.map((p) => {
      const allocated = sum(allocs.filter((a) => a.paymentId === p.id).map((a) => a.paymentAmount));
      const isReceipt = RECEIPT_TYPES.includes(p.paymentType);
      return {
        ...p, allocatedAmount: allocated,
        unallocatedAmount: isReceipt && p.status === 'POSTED' ? sub(p.amount, allocated) : ZERO,
      };
    });
  }

  /** Credit held for a client in one currency: received - refunded - applied to invoices (all in the PAYMENT currency). */
  async clientCredit(clientId: string, currency: string): Promise<DecimalString> {
    const [payments, allocs] = await Promise.all([
      this.db.client.payment.findMany({ where: { clientId, currencyCode: currency, status: 'POSTED', paymentType: { in: [...RECEIPT_TYPES, ...OUT_TYPES] as any } }, select: { amount: true, paymentType: true } }),
      this.db.client.paymentAllocation.findMany({ where: { reversedAt: null, payment: { clientId, currencyCode: currency, status: 'POSTED' } }, select: { paymentAmount: true } }),
    ]);
    const received = sum(payments.filter((p) => RECEIPT_TYPES.includes(p.paymentType)).map((p) => p.amount));
    const out = sum(payments.filter((p) => OUT_TYPES.includes(p.paymentType)).map((p) => p.amount));
    return sub(sub(received, out), sum(allocs.map((a) => a.paymentAmount)));
  }

  // ═══════════════════════════ receive / refund ═══════════════════════════

  async create(auth: AuthContext, input: CreatePaymentInput, meta: RequestMeta) {
    const client = await this.db.client.client.findUnique({ where: { id: input.clientId } });
    if (!client) throw unprocessable('CLIENT_NOT_FOUND', 'Client not found in your office');
    if (input.clearanceFileId) {
      const file = await this.files.require(input.clearanceFileId);
      if (file.clientId !== client.id) throw unprocessable('FILE_CLIENT_MISMATCH', 'That clearance file belongs to a different client');
    }
    const method = await this.db.client.paymentMethod.findUnique({ where: { code: input.paymentMethod } });
    if (!method || !method.isActive) throw unprocessable('PAYMENT_METHOD_NOT_FOUND', `Unknown payment method ${input.paymentMethod}`);
    await this.rates.assertCurrency(input.currencyCode);
    const cash = await this.accounting.requireCashAccount(input.cashAccountId, input.currencyCode);
    const paymentDate = input.paymentDate ?? new Date();
    const r = await this.rates.resolve(auth.tenantId, input.currencyCode, paymentDate, input);
    const baseAmount = this.rates.toBase(input.amount, r);
    const isReceipt = input.paymentType !== 'REFUND';
    if (!isReceipt && input.allocations?.length) throw unprocessable('REFUND_CANNOT_ALLOCATE', 'A refund cannot be allocated to invoices');

    if (!isReceipt) {
      const available = await this.clientCredit(client.id, input.currencyCode);
      if (compare(input.amount, available) > 0) {
        throw unprocessable('INSUFFICIENT_CREDIT', `The client has only ${available} ${input.currencyCode} of unapplied credit to refund`, [{ available, currency: input.currencyCode }]);
      }
    }

    const common = { currency: input.currencyCode, amount: input.amount, rate: r.rate, convention: r.convention, base: baseAmount, clearanceFileId: input.clearanceFileId ?? null };
    const lines: PostingLine[] = isReceipt
      ? [{ account: cash.ledger.accountCode, side: 'DEBIT', ...common }, { account: ACCOUNTS.CLIENT_ADVANCES, side: 'CREDIT', ...common }]
      : [{ account: ACCOUNTS.CLIENT_ADVANCES, side: 'DEBIT', ...common }, { account: cash.ledger.accountCode, side: 'CREDIT', ...common }];

    const id = await this.db.client.$transaction(async (tx) => {
      const paymentNumber = await nextDocumentNumber(tx, auth.tenantId, 'PAY', paymentDate.getUTCFullYear());
      const payment = await tx.payment.create({
        data: {
          clientId: client.id, clearanceFileId: input.clearanceFileId ?? null, paymentNumber, paymentType: input.paymentType, amount: input.amount,
          currencyCode: input.currencyCode, exchangeRate: r.rate, rateConvention: r.convention, rateSource: r.source, baseAmount,
          paymentMethod: input.paymentMethod, cashAccountId: cash.id, referenceNumber: input.referenceNumber ?? null, paymentDate,
          receivedBy: auth.userId, status: 'POSTED',
        } as any,
      });
      await this.accounting.post(tx, {
        entryDate: paymentDate, description: `${isReceipt ? 'Payment received' : 'Refund paid'} ${paymentNumber} — ${client.name}`,
        sourceType: 'PAYMENT', sourceId: payment.id, createdBy: auth.userId, lines,
      });
      if (input.clearanceFileId) {
        await this.activity.log(input.clearanceFileId, auth.userId, isReceipt ? 'PAYMENT_RECEIVED' : 'REFUND_PAID',
          `${isReceipt ? 'Payment received' : 'Refund paid'} ${paymentNumber}: ${input.amount} ${input.currencyCode}`, { paymentId: payment.id }, tx);
      }
      if (input.allocations?.length) await this.allocateInTx(tx, auth, payment, input.allocations);
      return payment.id;
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: isReceipt ? 'PAYMENT_RECEIVED' : 'REFUND_PAID', entityType: 'Payment', entityId: id,
      after: { type: input.paymentType, amount: input.amount, currency: input.currencyCode, rate: r.rate, baseAmount, clientId: client.id }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ═══════════════════════════ allocate ═══════════════════════════

  async allocate(auth: AuthContext, paymentId: string, allocations: AllocationInput[], meta: RequestMeta) {
    await this.db.client.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
      await this.allocateInTx(tx, auth, payment, allocations);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'PAYMENT_ALLOCATED', entityType: 'Payment', entityId: paymentId,
      after: { allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(paymentId);
  }

  private async allocateInTx(tx: any, auth: AuthContext, payment: any, inputs: AllocationInput[]) {
    if (payment.status !== 'POSTED') throw conflict('PAYMENT_NOT_POSTED', `A ${payment.status.toLowerCase()} payment cannot be allocated`);
    if (!RECEIPT_TYPES.includes(payment.paymentType)) throw unprocessable('NOT_A_RECEIPT', 'Only money received from a client can be allocated to invoices');
    const baseCurrency = await this.rates.baseCurrency(auth.tenantId);
    const payRate = { rate: payment.exchangeRate as string, convention: payment.rateConvention as any };

    for (const [i, a] of inputs.entries()) {
      const at = [{ path: `allocations.${i}` }];
      const invoice = await tx.invoice.findUnique({ where: { id: a.invoiceId } });
      if (!invoice) throw unprocessable('INVOICE_NOT_FOUND', 'Invoice not found in your office', at);
      if (invoice.clientId !== payment.clientId) throw unprocessable('CLIENT_MISMATCH', 'The invoice belongs to a different client than the payment', at);
      if (invoice.status !== 'ISSUED') throw unprocessable('INVOICE_NOT_ISSUED', `Only an issued invoice can be paid (this one is ${invoice.status.toLowerCase()})`, at);
      if (invoice.invoiceType === 'ADVANCE') {
        throw unprocessable('ADVANCE_INVOICE_NOT_ALLOCATABLE', 'An advance invoice is a request for funds. Record the money as an advance; it is held for the client and applied to the final invoice', at);
      }
      this.files.assertEditable(await this.files.require(invoice.clearanceFileId));

      // what the payment still has, and what the invoice still needs (live allocations only)
      const used = await tx.paymentAllocation.findMany({ where: { paymentId: payment.id, reversedAt: null }, select: { paymentAmount: true, paymentBaseAmount: true } });
      const remainingPay = sub(payment.amount, sum(used.map((u: any) => u.paymentAmount)));
      const remainingPayBase = sub(payment.baseAmount, sum(used.map((u: any) => u.paymentBaseAmount)));
      if (compare(a.amount, remainingPay) > 0) {
        throw unprocessable('PAYMENT_BALANCE_EXCEEDED', `Only ${remainingPay} ${payment.currencyCode} of this payment is still unallocated`, [{ ...at[0], unallocated: remainingPay }]);
      }
      const onInvoice = await tx.paymentAllocation.findMany({ where: { invoiceId: invoice.id, reversedAt: null, payment: { status: 'POSTED' } }, select: { allocatedAmount: true, invoiceBaseAmount: true } });
      const outstanding = sub(invoice.totalAmount, sum(onInvoice.map((u: any) => u.allocatedAmount)));
      const outstandingBase = sub(invoice.baseTotalAmount, sum(onInvoice.map((u: any) => u.invoiceBaseAmount)));

      // how much of the invoice this settles, in the invoice's currency
      const sameCurrency = payment.currencyCode === invoice.currencyCode;
      let invoiceAmount: DecimalString;
      if (sameCurrency) {
        if (a.invoiceAmount !== undefined && compare(a.invoiceAmount, a.amount) !== 0) {
          throw unprocessable('INVOICE_AMOUNT_MISMATCH', 'Payment and invoice are in the same currency, so invoiceAmount must equal amount', at);
        }
        invoiceAmount = a.amount;
      } else if (a.invoiceAmount !== undefined) {
        invoiceAmount = a.invoiceAmount;
      } else {
        // converted at the payment date's market rate: payment -> base -> invoice currency
        const invRateAtPayment = await this.rates.resolve(auth.tenantId, invoice.currencyCode, payment.paymentDate);
        invoiceAmount = this.rates.fromBase(this.rates.toBase(a.amount, payRate), invRateAtPayment);
      }
      if (compare(invoiceAmount, ZERO) <= 0) throw unprocessable('ALLOCATION_TOO_SMALL', 'That amount converts to zero in the invoice currency', at);
      if (compare(invoiceAmount, outstanding) > 0) {
        throw unprocessable('OVER_ALLOCATION', `Invoice ${invoice.invoiceNumber} has only ${outstanding} ${invoice.currencyCode} outstanding`, [{ ...at[0], outstanding, invoiceAmount }]);
      }

      // Base values. The allocation that exhausts a payment / closes an invoice takes the exact remainder, so
      // nothing is ever left behind on 2100 or 1200 by rounding.
      const exhaustsPayment = compare(a.amount, remainingPay) === 0;
      const closesInvoice = compare(invoiceAmount, outstanding) === 0;
      const paymentBase = exhaustsPayment ? remainingPayBase : this.rates.toBase(a.amount, payRate);
      const invoiceBase = closesInvoice ? outstandingBase : this.rates.toBase(invoiceAmount, { rate: invoice.exchangeRate, convention: invoice.rateConvention });
      if (compare(paymentBase, ZERO) <= 0 || compare(invoiceBase, ZERO) <= 0) {
        throw unprocessable('ALLOCATION_TOO_SMALL', 'That allocation is too small to record', at);
      }

      const allocation = await tx.paymentAllocation.create({
        data: {
          paymentId: payment.id, invoiceId: invoice.id, allocatedAmount: invoiceAmount, currencyCode: invoice.currencyCode,
          paymentAmount: a.amount, paymentBaseAmount: paymentBase, invoiceBaseAmount: invoiceBase, createdBy: auth.userId,
        },
      });
      const lines = this.accounting.withFxPlug([
        { account: ACCOUNTS.CLIENT_ADVANCES, side: 'DEBIT', currency: payment.currencyCode, amount: a.amount, rate: payment.exchangeRate, convention: payment.rateConvention, base: paymentBase, clearanceFileId: invoice.clearanceFileId },
        { account: ACCOUNTS.RECEIVABLES, side: 'CREDIT', currency: invoice.currencyCode, amount: invoiceAmount, rate: invoice.exchangeRate, convention: invoice.rateConvention, base: invoiceBase, clearanceFileId: invoice.clearanceFileId },
      ], baseCurrency, invoice.clearanceFileId);
      await this.accounting.post(tx, {
        entryDate: payment.paymentDate, description: `Allocation of ${payment.paymentNumber} to invoice ${invoice.invoiceNumber}`,
        sourceType: 'ALLOCATION', sourceId: allocation.id, createdBy: auth.userId, lines,
      });
      await this.activity.log(invoice.clearanceFileId, auth.userId, 'PAYMENT_ALLOCATED',
        `${payment.paymentNumber} applied to invoice ${invoice.invoiceNumber}: ${invoiceAmount} ${invoice.currencyCode}${closesInvoice ? ' (paid in full)' : ''}`,
        { paymentId: payment.id, invoiceId: invoice.id, allocationId: allocation.id }, tx);
    }
  }

  /** Undoes one allocation. The row is kept (marked reversed) and its ledger entry is reversed, never deleted. */
  async reverseAllocation(auth: AuthContext, paymentId: string, allocationId: string, reason: string, meta: RequestMeta) {
    const alloc = await this.db.client.paymentAllocation.findFirst({ where: { id: allocationId, paymentId }, include: { invoice: true, payment: true } });
    if (!alloc) throw notFound('ALLOCATION_NOT_FOUND', 'Allocation not found');
    if (alloc.reversedAt) throw conflict('ALLOCATION_ALREADY_REVERSED', 'This allocation was already reversed');
    this.files.assertEditable(await this.files.require(alloc.invoice.clearanceFileId));
    await this.db.client.$transaction(async (tx) => {
      await this.accounting.reverseBySource(tx, 'ALLOCATION', allocationId, { reason: `Allocation reversed: ${reason}`, userId: auth.userId });
      await tx.paymentAllocation.update({ where: { id: allocationId }, data: { reversedAt: new Date(), reversalReason: reason } });
      await this.activity.log(alloc.invoice.clearanceFileId, auth.userId, 'ALLOCATION_REVERSED',
        `Allocation of ${alloc.payment.paymentNumber} to invoice ${alloc.invoice.invoiceNumber} reversed — ${reason}`, { allocationId }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ALLOCATION_REVERSED', entityType: 'PaymentAllocation', entityId: allocationId,
      before: { invoiceId: alloc.invoiceId, amount: alloc.allocatedAmount }, after: { reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(paymentId);
  }

  // ═══════════════════════════ cancel ═══════════════════════════

  async cancel(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const p = await this.db.client.payment.findUnique({ where: { id } });
    if (!p) throw notFound('PAYMENT_NOT_FOUND', 'Payment not found');
    if (p.status === 'CANCELLED') throw conflict('PAYMENT_ALREADY_CANCELLED', 'This payment is already cancelled');
    const live = await this.db.client.paymentAllocation.findMany({ where: { paymentId: id, reversedAt: null }, include: { invoice: { select: { invoiceNumber: true } } } });
    if (live.length) {
      throw conflict('PAYMENT_HAS_ALLOCATIONS', 'Reverse the allocations of this payment before cancelling it',
        live.map((a) => ({ invoiceNumber: a.invoice.invoiceNumber, allocatedAmount: a.allocatedAmount })));
    }
    if (p.clearanceFileId) this.files.assertEditable(await this.files.require(p.clearanceFileId));
    await this.db.client.$transaction(async (tx) => {
      await this.accounting.reverseBySource(tx, 'PAYMENT', id, { reason: `Payment ${p.paymentNumber} cancelled: ${reason}`, userId: auth.userId });
      await tx.payment.update({ where: { id }, data: { status: 'CANCELLED' } });
      if (p.clearanceFileId) await this.activity.log(p.clearanceFileId, auth.userId, 'PAYMENT_CANCELLED', `Payment ${p.paymentNumber} cancelled — ${reason}`, { paymentId: id }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'PAYMENT_CANCELLED', entityType: 'Payment', entityId: id,
      before: { status: p.status, paymentNumber: p.paymentNumber }, after: { status: 'CANCELLED', reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }
}
