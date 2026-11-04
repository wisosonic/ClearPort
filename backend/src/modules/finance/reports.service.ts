import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { notFound } from '../../common/errors';
import { add, compare, sub, sum, ZERO, type DecimalString } from '../../common/money';
import { paginated } from '../../common/pagination';
import { TenantDbService } from '../../database/prisma.module';
import { ACCOUNTS, AccountingService, LEDGER_STATUSES } from './accounting.service';
import type { ReportQuery } from './finance.schemas';
import { RatesService } from './rates.service';

type Pair = { debit: DecimalString; credit: DecimalString };
const LIVE = ['DRAFT', 'ISSUED'] as const;

const pct = (num: DecimalString, den: DecimalString): string | null =>
  compare(den, ZERO) <= 0 ? null : new Decimal(num).div(den).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/**
 * Financial reports (spec 14.7 / 14.8). EVERY figure here is derived from POSTED journal lines (plus the
 * business records for lists), so the reports reconcile to the books by construction.
 *
 * Profitability rule (agreed): profit = SERVICE REVENUE - OFFICE COSTS.
 *   - Pass-through money (duties, port fees ... re-billed at cost) is NOT revenue and NOT a cost; its
 *     unrecovered balance (disbursed - re-billed) is reported separately.
 *   - Client advances are a liability and never income.
 *   - Tax collected is owed to the state, not revenue.
 *   - Realized FX gains / losses are shown on their own line and excluded from profit.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(RatesService) private readonly rates: RatesService,
  ) {}

  // ═══════════════════════════ one file ═══════════════════════════

  async fileCosts(tenantId: string, fileId: string) {
    const file = await this.db.client.clearanceFile.findUnique({
      where: { id: fileId }, select: { id: true, fileNumber: true, status: true, client: { select: { id: true, name: true } } },
    });
    if (!file) throw notFound('CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    const baseCurrency = await this.rates.baseCurrency(tenantId);
    const ledger = await this.byFile([fileId], {});
    const figures = this.figures(ledger.get(fileId) ?? new Map());

    const [expenses, invoices] = await Promise.all([
      this.db.client.expense.findMany({
        where: { clearanceFileId: fileId, status: 'APPROVED' },
        include: { category: { select: { name: true, costTreatment: true } }, invoiceItems: { where: { invoice: { status: { in: [...LIVE] } } }, select: { invoice: { select: { status: true } } } } },
        orderBy: { expenseDate: 'asc' },
      }),
      this.db.client.invoice.findMany({ where: { clearanceFileId: fileId, status: 'ISSUED', invoiceType: { not: 'ADVANCE' } }, orderBy: { issueDate: 'asc' } }),
    ]);
    const allocs = invoices.length
      ? await this.db.client.paymentAllocation.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) }, reversedAt: null, payment: { status: 'POSTED' } }, select: { invoiceId: true, allocatedAmount: true } })
      : [];

    const expenseRows = expenses.map((e) => ({
      id: e.id, description: e.description, category: e.category.name, treatment: e.category.costTreatment,
      amount: e.amount, currencyCode: e.currencyCode, baseAmount: e.baseAmount, paymentStatus: e.paymentStatus,
      billed: e.invoiceItems.length > 0, // on any live invoice, draft or issued
      reBilled: e.invoiceItems.some((i: any) => i.invoice.status === 'ISSUED'), // on an ISSUED invoice: the money is claimed back
    }));
    const byTreatment = (t: string, billedFilter?: boolean) => expenseRows.filter((e) => e.treatment === t && (billedFilter === undefined || e.billed === billedFilter));
    const invoiceRows = invoices.map((i) => {
      const paid = sum(allocs.filter((a) => a.invoiceId === i.id).map((a) => a.allocatedAmount));
      return { id: i.id, invoiceNumber: i.invoiceNumber, invoiceType: i.invoiceType, currencyCode: i.currencyCode, total: i.totalAmount, baseTotal: i.baseTotalAmount, paid, outstanding: sub(i.totalAmount, paid) };
    });
    const perCurrency = (rows: { currencyCode: string; [k: string]: any }[], key: string) => {
      const out: Record<string, DecimalString> = {};
      for (const cur of new Set(rows.map((r) => r.currencyCode))) out[cur] = sum(rows.filter((r) => r.currencyCode === cur).map((r) => r[key]));
      return out;
    };

    return {
      file: { id: file.id, fileNumber: file.fileNumber, status: file.status, client: file.client },
      basis: 'BASE_CURRENCY' as const,
      baseCurrency,
      /** from the ledger: what the file really earned and cost the office */
      profitability: {
        serviceRevenue: figures.serviceRevenue,
        officeCosts: figures.officeCosts,
        profit: figures.profit,
        marginPercent: pct(figures.profit, figures.serviceRevenue),
        note: 'Profit = service revenue − office costs. Pass-through money, advances, tax and FX differences are excluded.',
      },
      passThrough: {
        // from the expense records; 'unrecovered' is the ledger's net balance and equals disbursed - reBilled
        disbursed: sum(byTreatment('PASS_THROUGH').map((e) => e.baseAmount)),
        reBilled: sum(expenseRows.filter((e) => e.treatment === 'PASS_THROUGH' && e.reBilled).map((e) => e.baseAmount)),
        unrecovered: figures.unrecovered,
        unbilledExpenses: byTreatment('PASS_THROUGH', false).map((e) => ({ id: e.id, description: e.description, amount: e.amount, currencyCode: e.currencyCode, baseAmount: e.baseAmount })),
      },
      taxCollected: figures.taxCollected,
      fxGainLoss: figures.fxGainLoss,
      receivables: { outstandingBase: figures.receivables },
      expenses: {
        passThrough: { baseTotal: sum(byTreatment('PASS_THROUGH').map((e) => e.baseAmount)), byCurrency: perCurrency(byTreatment('PASS_THROUGH'), 'amount') },
        office: { baseTotal: sum(byTreatment('OFFICE_EXPENSE').map((e) => e.baseAmount)), byCurrency: perCurrency(byTreatment('OFFICE_EXPENSE'), 'amount') },
        items: expenseRows,
      },
      invoices: {
        count: invoiceRows.length, invoicedByCurrency: perCurrency(invoiceRows, 'total'), paidByCurrency: perCurrency(invoiceRows, 'paid'),
        outstandingByCurrency: perCurrency(invoiceRows, 'outstanding'), items: invoiceRows,
      },
    };
  }

  // ═══════════════════════════ many files ═══════════════════════════

  async profitability(tenantId: string, q: ReportQuery) {
    const baseCurrency = await this.rates.baseCurrency(tenantId);
    const where: any = {};
    if (q.clientId) where.clientId = q.clientId;
    if (q.fileType) where.fileType = q.fileType;
    if (q.status) where.status = q.status;
    if (q.assignedTo) where.assignedTo = q.assignedTo;
    if (q.branchId) where.branchId = q.branchId;
    const files = await this.db.client.clearanceFile.findMany({
      where, take: 5000, orderBy: { createdAt: 'desc' },
      select: { id: true, fileNumber: true, fileType: true, status: true, client: { select: { id: true, name: true } }, assignee: { select: { user: { select: { id: true, firstName: true, lastName: true } } } } },
    });
    const range = { from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined, to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined };
    const ledger = await this.byFile(files.map((f) => f.id), range);

    const rows = files.map((f) => {
      const fig = this.figures(ledger.get(f.id) ?? new Map());
      return {
        id: f.id, fileNumber: f.fileNumber, fileType: f.fileType, status: f.status, client: f.client, assignee: f.assignee?.user ?? null,
        serviceRevenue: fig.serviceRevenue, officeCosts: fig.officeCosts, profit: fig.profit, marginPercent: pct(fig.profit, fig.serviceRevenue),
        unrecoveredDisbursements: fig.unrecovered, fxGainLoss: fig.fxGainLoss,
      };
    }).filter((r) => !(q.from || q.to) || [r.serviceRevenue, r.officeCosts, r.unrecoveredDisbursements, r.fxGainLoss].some((v) => compare(v, ZERO) !== 0));

    const totals = {
      files: rows.length,
      serviceRevenue: sum(rows.map((r) => r.serviceRevenue)), officeCosts: sum(rows.map((r) => r.officeCosts)), profit: sum(rows.map((r) => r.profit)),
      unrecoveredDisbursements: sum(rows.map((r) => r.unrecoveredDisbursements)), fxGainLoss: sum(rows.map((r) => r.fxGainLoss)),
    };
    // default order: most profitable first; fileNumber for ties
    rows.sort((a, b) => compare(b.profit, a.profit) || b.fileNumber.localeCompare(a.fileNumber));
    const page = rows.slice((q.page - 1) * q.limit, q.page * q.limit);
    const res = paginated(page, q, rows.length);
    // report-wide figures ride in meta: they cover ALL matching files, not only this page
    Object.assign(res.meta, { baseCurrency, basis: 'BASE_CURRENCY', totals: { ...totals, marginPercent: pct(totals.profit, totals.serviceRevenue) } });
    return res;
  }

  // ═══════════════════════════ whole office ═══════════════════════════

  async financialSummary(tenantId: string, q: Pick<ReportQuery, 'from' | 'to'>) {
    const baseCurrency = await this.rates.baseCurrency(tenantId);
    const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined;
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined;
    const codes = [ACCOUNTS.RECEIVABLES, ACCOUNTS.DISBURSEMENTS, ACCOUNTS.CLIENT_ADVANCES, ACCOUNTS.PAYABLES, ACCOUNTS.TAXES_PAYABLE, ACCOUNTS.SERVICE_REVENUE, ACCOUNTS.OFFICE_EXPENSES, ACCOUNTS.FX_GAIN_LOSS];
    // position = cumulative up to the end date; results = movements inside the period
    const position = await this.accounting.accountBalances(codes, { to });
    const period = await this.accounting.accountBalances(codes, { from, to });
    const bal = (m: typeof position, code: string) => m[code]?.balance ?? ZERO;

    const cash = await this.accounting.cashAccounts();
    const cashLedger = await this.db.client.journalEntryLine.findMany({
      where: { account: { cashAccounts: { some: {} } }, journalEntry: { status: { in: [...LEDGER_STATUSES] }, ...(to && { entryDate: { lte: to } }) } },
      select: { baseDebit: true, baseCredit: true },
    });
    const cashBase = sub(sum(cashLedger.map((l) => l.baseDebit)), sum(cashLedger.map((l) => l.baseCredit)));

    const dateFilter = (field: string) => (from || to) ? { [field]: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {};
    const [invoices, payments] = await Promise.all([
      this.db.client.invoice.findMany({ where: { status: 'ISSUED', invoiceType: { not: 'ADVANCE' }, ...dateFilter('issueDate') }, select: { currencyCode: true, totalAmount: true, baseTotalAmount: true } }),
      this.db.client.payment.findMany({ where: { status: 'POSTED', ...dateFilter('paymentDate') }, select: { paymentType: true, currencyCode: true, amount: true, baseAmount: true } }),
    ]);
    const byCur = (rows: any[], amountKey: string) => {
      const out: Record<string, DecimalString> = {};
      for (const c of new Set(rows.map((r) => r.currencyCode))) out[c] = sum(rows.filter((r) => r.currencyCode === c).map((r) => r[amountKey]));
      return out;
    };
    const received = payments.filter((p) => p.paymentType !== 'REFUND');
    const refunds = payments.filter((p) => p.paymentType === 'REFUND');

    const serviceRevenue = bal(period, ACCOUNTS.SERVICE_REVENUE);
    const officeExpenses = bal(period, ACCOUNTS.OFFICE_EXPENSES);
    return {
      baseCurrency, basis: 'BASE_CURRENCY' as const, from: q.from ?? null, to: q.to ?? null,
      /** the office's financial position at the end date (cumulative) */
      position: {
        receivables: bal(position, ACCOUNTS.RECEIVABLES), clientAdvancesHeld: bal(position, ACCOUNTS.CLIENT_ADVANCES),
        unrecoveredDisbursements: bal(position, ACCOUNTS.DISBURSEMENTS), payables: bal(position, ACCOUNTS.PAYABLES),
        taxesPayable: bal(position, ACCOUNTS.TAXES_PAYABLE), cashAndBankBase: cashBase,
        cashAccounts: cash.map((c) => ({ id: c.id, name: c.name, currencyCode: c.currencyCode, balance: c.balance })), // own currency, as of now
      },
      /** what happened inside the period */
      results: {
        serviceRevenue, officeExpenses, operatingResult: sub(serviceRevenue, officeExpenses), fxGainLoss: bal(period, ACCOUNTS.FX_GAIN_LOSS),
      },
      /** document totals in the ORIGINAL currencies (not converted) */
      transactionCurrency: {
        invoiced: byCur(invoices, 'totalAmount'), received: byCur(received, 'amount'), refunded: byCur(refunds, 'amount'),
      },
      /** the same documents valued in base currency at the rates they were booked with */
      documentsBase: {
        invoiced: sum(invoices.map((i) => i.baseTotalAmount ?? ZERO)), received: sum(received.map((p) => p.baseAmount)), refunded: sum(refunds.map((p) => p.baseAmount)),
        invoiceCount: invoices.length, paymentCount: received.length,
      },
    };
  }

  // ═══════════════════════════ shared ═══════════════════════════

  /** Posted-line totals per file and account code, for the accounts the reports use. */
  async byFile(fileIds: string[], range: { from?: Date; to?: Date }) {
    const out = new Map<string, Map<string, Pair>>();
    if (!fileIds.length) return out;
    const lines = await this.db.client.journalEntryLine.findMany({
      where: {
        clearanceFileId: { in: fileIds },
        account: { accountCode: { in: [ACCOUNTS.SERVICE_REVENUE, ACCOUNTS.OFFICE_EXPENSES, ACCOUNTS.DISBURSEMENTS, ACCOUNTS.FX_GAIN_LOSS, ACCOUNTS.TAXES_PAYABLE, ACCOUNTS.RECEIVABLES] } },
        journalEntry: { status: { in: [...LEDGER_STATUSES] }, ...((range.from || range.to) && { entryDate: { ...(range.from && { gte: range.from }), ...(range.to && { lte: range.to }) } }) },
      },
      select: { clearanceFileId: true, baseDebit: true, baseCredit: true, account: { select: { accountCode: true } } },
    });
    for (const l of lines) {
      const perFile = out.get(l.clearanceFileId!) ?? new Map<string, Pair>();
      const cur = perFile.get(l.account.accountCode) ?? { debit: ZERO, credit: ZERO };
      perFile.set(l.account.accountCode, { debit: add(cur.debit, l.baseDebit), credit: add(cur.credit, l.baseCredit) });
      out.set(l.clearanceFileId!, perFile);
    }
    return out;
  }

  figures(m: Map<string, Pair>) {
    const p = (code: string): Pair => m.get(code) ?? { debit: ZERO, credit: ZERO };
    const serviceRevenue = sub(p(ACCOUNTS.SERVICE_REVENUE).credit, p(ACCOUNTS.SERVICE_REVENUE).debit);
    const officeCosts = sub(p(ACCOUNTS.OFFICE_EXPENSES).debit, p(ACCOUNTS.OFFICE_EXPENSES).credit);
    return {
      serviceRevenue, officeCosts, profit: sub(serviceRevenue, officeCosts),
      // net balance of the disbursements account for this file (reversals net out)
      unrecovered: sub(p(ACCOUNTS.DISBURSEMENTS).debit, p(ACCOUNTS.DISBURSEMENTS).credit),
      fxGainLoss: sub(p(ACCOUNTS.FX_GAIN_LOSS).credit, p(ACCOUNTS.FX_GAIN_LOSS).debit),
      taxCollected: sub(p(ACCOUNTS.TAXES_PAYABLE).credit, p(ACCOUNTS.TAXES_PAYABLE).debit),
      receivables: sub(p(ACCOUNTS.RECEIVABLES).debit, p(ACCOUNTS.RECEIVABLES).credit),
    };
  }
}
