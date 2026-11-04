import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { add, compare, sub, sum, ZERO, type DecimalString } from '../../common/money';
import { searchIds } from '../../common/search';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import type { AuthContext } from '../auth/auth.types';
import { ACCOUNTS, AccountingService, LEDGER_STATUSES } from '../finance/accounting.service';
import type { OpsReportQuery } from '../finance/finance.schemas';
import { ReportsService } from '../finance/reports.service';
import { RatesService } from '../finance/rates.service';
import { col, type ReportName, type ReportTable } from './report-table';

const MAX_ROWS = 10_000;
const DAY = 86_400_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const fullName = (u?: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
const range = (from?: string, to?: string) => ({
  from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
  to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
});
const days = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / DAY));
const pct = (num: DecimalString, den: DecimalString) => (compare(den, ZERO) <= 0 ? null : new Decimal(num).div(den).times(100).toDecimalPlaces(2).toFixed(2));

/**
 * The operational reports (spec 14.8). Each builder returns the SAME uniform table that the JSON API,
 * the Excel/CSV export and the PDFs render. Money in these reports is either labelled base currency
 * (ledger-derived) or kept in transaction currencies, and says which in `meta.basis`.
 */
@Injectable()
export class OperationsReportsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(AccountingService) private readonly accounting: AccountingService,
    @Inject(RatesService) private readonly rates: RatesService,
  ) {}

  /** Builds any report by name. Used by the JSON endpoints and by the export. */
  async build(name: ReportName, auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    switch (name) {
      case 'clearance-files': return this.clearanceFiles(q);
      case 'client-balances': return this.clientBalances(q);
      case 'expenses': return this.expenses(auth, q);
      case 'revenue': return this.revenue(auth, q);
      case 'employee-performance': return this.employeePerformance(auth, q);
      case 'profitability': return this.profitability(auth, q);
      case 'financial-summary': return this.financialSummary(auth, q);
      case 'trial-balance': return this.trialBalance(auth, q);
    }
  }

  // ═══════════════════════════ clearance files ═══════════════════════════

  async clearanceFiles(q: OpsReportQuery): Promise<ReportTable> {
    const where: any = {};
    if (q.clientId) where.clientId = q.clientId;
    if (q.fileType) where.fileType = q.fileType;
    if (q.status) where.status = q.status;
    if (q.assignedTo) where.assignedTo = q.assignedTo;
    if (q.branchId) where.branchId = q.branchId;
    const r = range(q.from, q.to);
    if (r.from || r.to) where.openedAt = { ...(r.from && { gte: r.from }), ...(r.to && { lte: r.to }) };
    if (q.search) where.id = { in: await searchIds(this.db.client, { table: 'clearance_files', columns: ['fileNumber', 'customsReference'], term: q.search, tenantId: await this.tenantId() }) };

    const files = await this.db.client.clearanceFile.findMany({
      where, take: MAX_ROWS, orderBy: { openedAt: 'desc' },
      select: {
        fileNumber: true, fileType: true, status: true, priority: true, openedAt: true, expectedArrivalAt: true, closedAt: true, customsReference: true,
        client: { select: { name: true } }, branch: { select: { name: true } }, currentStage: { select: { nameEn: true, nameAr: true } },
        assignee: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    const now = new Date();
    const rows = files.map((f) => ({
      fileNumber: f.fileNumber, fileType: f.fileType, status: f.status, priority: f.priority, client: f.client.name, branch: f.branch?.name ?? null,
      assignee: fullName(f.assignee?.user), stage: f.currentStage?.nameEn ?? null, stageAr: f.currentStage?.nameAr ?? null,
      openedAt: iso(f.openedAt), expectedArrivalAt: iso(f.expectedArrivalAt), closedAt: iso(f.closedAt), customsReference: f.customsReference,
      daysOpen: days(f.openedAt, f.closedAt ?? now),
    }));
    const count = (k: 'status' | 'fileType') => rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r[k]]: (a[r[k]] ?? 0) + 1 }), {});
    const closed = rows.filter((r) => r.status === 'CLOSED');
    return {
      name: 'clearance-files', title: { en: 'Clearance files', ar: 'ملفات التخليص' },
      columns: [
        col('fileNumber', 'File number', 'رقم الملف'), col('fileType', 'Type', 'النوع'), col('status', 'Status', 'الحالة'), col('priority', 'Priority', 'الأولوية'),
        col('client', 'Client', 'العميل'), col('branch', 'Branch', 'الفرع'), col('assignee', 'Assigned to', 'المكلّف'), col('stage', 'Stage', 'المرحلة'),
        col('openedAt', 'Opened', 'تاريخ الفتح', 'date'), col('expectedArrivalAt', 'Expected arrival', 'الوصول المتوقع', 'date'),
        col('closedAt', 'Closed', 'تاريخ الإقفال', 'date'), col('daysOpen', 'Days open', 'الأيام', 'int'), col('customsReference', 'Customs reference', 'المرجع الجمركي'),
      ],
      rows, totals: { fileNumber: rows.length },
      meta: {
        basis: 'COUNTS', from: q.from ?? null, to: q.to ?? null, byStatus: count('status'), byType: count('fileType'),
        averageDaysToClose: closed.length ? Math.round((closed.reduce((s, r) => s + r.daysOpen, 0) / closed.length) * 10) / 10 : null,
      },
    };
  }

  // ═══════════════════════════ client balances ═══════════════════════════

  /**
   * One row per client and currency, in TRANSACTION currency (never converted). Same definitions as the
   * client balance endpoint: outstanding = invoiced - allocated; unapplied credit = received - refunded -
   * applied; net = outstanding - credit (positive: the client owes the office).
   */
  async clientBalances(q: OpsReportQuery): Promise<ReportTable> {
    const clientWhere: any = {};
    if (q.clientId) clientWhere.id = q.clientId;
    if (q.search) clientWhere.id = { in: await searchIds(this.db.client, { table: 'clients', columns: ['name', 'clientCode'], term: q.search, tenantId: await this.tenantId() }) };
    const clients = await this.db.client.client.findMany({ where: clientWhere, select: { id: true, clientCode: true, name: true, creditLimit: true } });
    const ids = clients.map((c) => c.id);
    const [invoices, payments, allocs] = ids.length ? await Promise.all([
      this.db.client.invoice.findMany({ where: { clientId: { in: ids }, status: 'ISSUED', invoiceType: { not: 'ADVANCE' } }, select: { id: true, clientId: true, currencyCode: true, totalAmount: true, dueDate: true } }),
      this.db.client.payment.findMany({ where: { clientId: { in: ids }, status: 'POSTED' }, select: { clientId: true, currencyCode: true, amount: true, paymentType: true } }),
      this.db.client.paymentAllocation.findMany({
        where: { reversedAt: null, payment: { clientId: { in: ids }, status: 'POSTED' }, invoice: { status: 'ISSUED', invoiceType: { not: 'ADVANCE' } } },
        select: { invoiceId: true, allocatedAmount: true, paymentAmount: true, payment: { select: { clientId: true, currencyCode: true } } },
      }),
    ]) : [[], [], []];
    const paidByInvoice = new Map<string, DecimalString>();
    for (const a of allocs) paidByInvoice.set(a.invoiceId, add(paidByInvoice.get(a.invoiceId) ?? ZERO, a.allocatedAmount));
    const receipt = (t: string) => t === 'CLIENT_PAYMENT' || t === 'CLIENT_ADVANCE';
    const now = Date.now();

    const rows: Record<string, any>[] = [];
    for (const c of clients) {
      const mine = { inv: invoices.filter((i) => i.clientId === c.id), pay: payments.filter((p) => p.clientId === c.id), al: allocs.filter((a) => a.payment.clientId === c.id) };
      const currencies = new Set([...mine.inv.map((i) => i.currencyCode), ...mine.pay.map((p) => p.currencyCode)]);
      for (const cur of [...currencies].sort()) {
        const invoiced = sum(mine.inv.filter((i) => i.currencyCode === cur).map((i) => i.totalAmount));
        const received = sum(mine.pay.filter((p) => p.currencyCode === cur && receipt(p.paymentType)).map((p) => p.amount));
        const refunded = sum(mine.pay.filter((p) => p.currencyCode === cur && !receipt(p.paymentType)).map((p) => p.amount));
        const allocated = sum(mine.inv.filter((i) => i.currencyCode === cur).map((i) => paidByInvoice.get(i.id) ?? ZERO));
        const applied = sum(mine.al.filter((a) => a.payment.currencyCode === cur).map((a) => a.paymentAmount));
        const outstanding = sub(invoiced, allocated);
        const credit = sub(sub(received, refunded), applied);
        const overdue = sum(mine.inv.filter((i) => i.currencyCode === cur && i.dueDate && i.dueDate.getTime() < now).map((i) => sub(i.totalAmount, paidByInvoice.get(i.id) ?? ZERO)).filter((o) => compare(o, ZERO) > 0));
        const net = sub(outstanding, credit);
        if (q.onlyOpen === 'true' && compare(outstanding, ZERO) === 0 && compare(credit, ZERO) === 0) continue;
        rows.push({ clientCode: c.clientCode, client: c.name, currency: cur, invoiced, received, refunded, outstanding, overdue, unappliedCredit: credit, netBalance: net, creditLimit: c.creditLimit });
      }
    }
    rows.sort((a, b) => compare(b.outstanding, a.outstanding) || a.client.localeCompare(b.client));
    const byCur = (key: string) => {
      const out: Record<string, DecimalString> = {};
      for (const cur of new Set(rows.map((r) => r.currency))) out[cur] = sum(rows.filter((r) => r.currency === cur).map((r) => r[key]));
      return out;
    };
    return {
      name: 'client-balances', title: { en: 'Client balances', ar: 'أرصدة العملاء' },
      columns: [
        col('clientCode', 'Code', 'الرمز'), col('client', 'Client', 'العميل'), col('currency', 'Currency', 'العملة'),
        col('invoiced', 'Invoiced', 'المفوتر', 'money'), col('received', 'Received', 'المقبوض', 'money'), col('refunded', 'Refunded', 'المردود', 'money'),
        col('outstanding', 'Outstanding', 'المستحق', 'money'), col('overdue', 'Overdue', 'المتأخر', 'money'),
        col('unappliedCredit', 'Credit held', 'رصيد دائن', 'money'), col('netBalance', 'Net balance', 'الرصيد الصافي', 'money'),
      ],
      rows,
      // totals are per currency: adding USD to LBP would be meaningless
      totals: undefined,
      meta: { basis: 'TRANSACTION_CURRENCY', totalsByCurrency: { outstanding: byCur('outstanding'), overdue: byCur('overdue'), unappliedCredit: byCur('unappliedCredit'), netBalance: byCur('netBalance') }, clients: new Set(rows.map((r) => r.clientCode)).size },
    };
  }

  // ═══════════════════════════ expenses ═══════════════════════════

  async expenses(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const where: any = { status: q.expenseStatus ?? 'APPROVED' };
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.vendorId) where.vendorId = q.vendorId;
    if (q.clearanceFileId) where.clearanceFileId = q.clearanceFileId;
    if (q.clientId) where.clearanceFile = { clientId: q.clientId };
    const r = range(q.from, q.to);
    if (r.from || r.to) where.expenseDate = { ...(r.from && { gte: r.from }), ...(r.to && { lte: r.to }) };
    const expenses = await this.db.client.expense.findMany({
      where, take: MAX_ROWS, orderBy: { expenseDate: 'desc' },
      include: { category: { select: { name: true, costTreatment: true } }, vendor: { select: { name: true } }, clearanceFile: { select: { fileNumber: true } } },
    });
    const baseCurrency = await this.rates.baseCurrency(auth.tenantId);
    const rows = expenses.map((e) => ({
      date: iso(e.expenseDate), fileNumber: e.clearanceFile?.fileNumber ?? null, category: e.category.name, treatment: e.category.costTreatment,
      vendor: e.vendor?.name ?? null, description: e.description, amount: e.amount, currency: e.currencyCode, exchangeRate: e.exchangeRate, baseAmount: e.baseAmount,
      status: e.status, paymentStatus: e.paymentStatus,
    }));
    const group = (key: 'category' | 'vendor') => {
      const out: Record<string, { count: number; baseTotal: DecimalString }> = {};
      for (const row of rows) {
        const k = (row[key] as string | null) ?? '(none)';
        out[k] = { count: (out[k]?.count ?? 0) + 1, baseTotal: add(out[k]?.baseTotal ?? ZERO, row.baseAmount) };
      }
      return out;
    };
    const byCurrency: Record<string, DecimalString> = {};
    for (const cur of new Set(rows.map((x) => x.currency))) byCurrency[cur] = sum(rows.filter((x) => x.currency === cur).map((x) => x.amount));
    return {
      name: 'expenses', title: { en: 'Expenses', ar: 'المصاريف' },
      columns: [
        col('date', 'Date', 'التاريخ', 'date'), col('fileNumber', 'File', 'الملف'), col('category', 'Category', 'الفئة'), col('vendor', 'Vendor', 'المورّد'),
        col('description', 'Description', 'البيان'), col('amount', 'Amount', 'المبلغ', 'money'), col('currency', 'Currency', 'العملة'),
        col('exchangeRate', 'Rate', 'السعر', 'money'), col('baseAmount', `Amount (${baseCurrency})`, `المبلغ (${baseCurrency})`, 'money'),
        col('treatment', 'Treatment', 'المعالجة'), col('paymentStatus', 'Payment', 'الدفع'),
      ],
      rows, totals: { baseAmount: sum(rows.map((x) => x.baseAmount)), description: `${rows.length}` },
      meta: { basis: 'BASE_CURRENCY', baseCurrency, from: q.from ?? null, to: q.to ?? null, status: where.status, byCategory: group('category'), byVendor: group('vendor'), transactionCurrencyTotals: byCurrency },
    };
  }

  // ═══════════════════════════ revenue ═══════════════════════════

  /** Service revenue from the LEDGER (4100), by month or by client. Tax and FX are shown beside it, never inside it. */
  async revenue(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const baseCurrency = await this.rates.baseCurrency(auth.tenantId);
    const r = range(q.from, q.to);
    const lines = await this.db.client.journalEntryLine.findMany({
      where: {
        account: { accountCode: { in: [ACCOUNTS.SERVICE_REVENUE, ACCOUNTS.TAXES_PAYABLE, ACCOUNTS.FX_GAIN_LOSS] } },
        journalEntry: { status: { in: [...LEDGER_STATUSES] }, ...((r.from || r.to) && { entryDate: { ...(r.from && { gte: r.from }), ...(r.to && { lte: r.to }) } }) },
        ...(q.clientId && { clearanceFile: { clientId: q.clientId } }),
      },
      select: { baseDebit: true, baseCredit: true, clearanceFileId: true, account: { select: { accountCode: true } }, journalEntry: { select: { entryDate: true } } },
    });
    const fileClient = new Map<string, { id: string; name: string }>();
    if (q.groupBy === 'client') {
      const fids = [...new Set(lines.map((l) => l.clearanceFileId).filter((x): x is string => !!x))];
      if (fids.length) for (const f of await this.db.client.clearanceFile.findMany({ where: { id: { in: fids } }, select: { id: true, client: { select: { id: true, name: true } } } })) fileClient.set(f.id, f.client);
    }
    const buckets = new Map<string, { label: string; revenue: DecimalString; tax: DecimalString; fx: DecimalString }>();
    for (const l of lines) {
      const key = q.groupBy === 'month' ? l.journalEntry.entryDate.toISOString().slice(0, 7) : (l.clearanceFileId && fileClient.get(l.clearanceFileId)?.name) || '(no client)';
      const b = buckets.get(key) ?? { label: key, revenue: ZERO, tax: ZERO, fx: ZERO };
      const code = l.account.accountCode;
      const credit = sub(l.baseCredit, l.baseDebit);
      if (code === ACCOUNTS.SERVICE_REVENUE) b.revenue = add(b.revenue, credit);
      else if (code === ACCOUNTS.TAXES_PAYABLE) b.tax = add(b.tax, credit);
      else b.fx = add(b.fx, credit);
      buckets.set(key, b);
    }
    const rows = [...buckets.values()].sort((a, b) => (q.groupBy === 'month' ? a.label.localeCompare(b.label) : compare(b.revenue, a.revenue))).map((b) => ({ group: b.label, revenue: b.revenue, taxCollected: b.tax, fxGainLoss: b.fx }));
    return {
      name: 'revenue', title: { en: 'Revenue', ar: 'الإيرادات' },
      columns: [
        col('group', q.groupBy === 'month' ? 'Month' : 'Client', q.groupBy === 'month' ? 'الشهر' : 'العميل'),
        col('revenue', `Service revenue (${baseCurrency})`, `إيرادات الخدمات (${baseCurrency})`, 'money'),
        col('taxCollected', `Tax collected (${baseCurrency})`, `الضريبة المحصّلة (${baseCurrency})`, 'money'),
        col('fxGainLoss', `FX gain / loss (${baseCurrency})`, `فروقات الصرف (${baseCurrency})`, 'money'),
      ],
      rows, totals: { group: '', revenue: sum(rows.map((x) => x.revenue)), taxCollected: sum(rows.map((x) => x.taxCollected)), fxGainLoss: sum(rows.map((x) => x.fxGainLoss)) },
      meta: { basis: 'BASE_CURRENCY', baseCurrency, from: q.from ?? null, to: q.to ?? null, groupBy: q.groupBy, note: 'Revenue is service fees only. Pass-through money, advances and tax are not revenue.' },
    };
  }

  // ═══════════════════════════ employee performance ═══════════════════════════

  async employeePerformance(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const baseCurrency = await this.rates.baseCurrency(auth.tenantId);
    const r = range(q.from, q.to);
    const inRange = (d: Date | null | undefined) => !!d && (!r.from || d >= r.from) && (!r.to || d <= r.to);
    const members = await this.db.client.tenantUser.findMany({
      where: q.assignedTo ? { userId: q.assignedTo } : {}, select: { userId: true, isActive: true, user: { select: { firstName: true, lastName: true } } },
    });
    const [files, tasks, docs, history] = await Promise.all([
      this.db.client.clearanceFile.findMany({ where: { assignedTo: { not: null } }, select: { id: true, assignedTo: true, status: true, openedAt: true, closedAt: true }, take: MAX_ROWS }),
      this.db.client.task.findMany({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'DONE'] } }, select: { assignedTo: true, status: true, dueAt: true, completedAt: true }, take: MAX_ROWS }),
      this.db.client.document.findMany({ where: { deletedAt: null }, select: { uploadedBy: true, uploadedAt: true }, take: MAX_ROWS }),
      this.db.client.fileStatusHistory.findMany({ select: { changedBy: true, changedAt: true }, take: MAX_ROWS }),
    ]);
    const ledger = await this.reports.byFile(files.map((f) => f.id), r);
    const now = new Date();
    const rows = members.map((m) => {
      const mine = files.filter((f) => f.assignedTo === m.userId);
      const closedIn = mine.filter((f) => f.status === 'CLOSED' && inRange(f.closedAt));
      const myTasks = tasks.filter((t) => t.assignedTo === m.userId);
      const doneIn = myTasks.filter((t) => t.status === 'DONE' && inRange(t.completedAt));
      const fig = mine.map((f) => this.reports.figures(ledger.get(f.id) ?? new Map()));
      const revenue = sum(fig.map((x) => x.serviceRevenue));
      const costs = sum(fig.map((x) => x.officeCosts));
      return {
        employee: fullName(m.user), active: m.isActive ? 'yes' : 'no',
        filesAssignedOpen: mine.filter((f) => f.status === 'OPEN' || f.status === 'ON_HOLD').length,
        filesOpenedInPeriod: mine.filter((f) => inRange(f.openedAt)).length, filesClosedInPeriod: closedIn.length,
        avgDaysToClose: closedIn.length ? Math.round((closedIn.reduce((s, f) => s + days(f.openedAt, f.closedAt!), 0) / closedIn.length) * 10) / 10 : null,
        tasksCompleted: doneIn.length, tasksOnTime: doneIn.filter((t) => !t.dueAt || t.completedAt! <= t.dueAt).length,
        tasksOverdueNow: myTasks.filter((t) => (t.status === 'OPEN' || t.status === 'IN_PROGRESS') && t.dueAt && t.dueAt < now).length,
        documentsUploaded: docs.filter((d) => d.uploadedBy === m.userId && inRange(d.uploadedAt)).length,
        stageChanges: history.filter((h) => h.changedBy === m.userId && inRange(h.changedAt)).length,
        serviceRevenue: revenue, profit: sub(revenue, costs),
      };
    }).sort((a, b) => b.filesClosedInPeriod - a.filesClosedInPeriod || compare(b.profit, a.profit));
    const total = (k: string) => rows.reduce((s, x: any) => s + (x[k] ?? 0), 0);
    return {
      name: 'employee-performance', title: { en: 'Employee performance', ar: 'أداء الموظفين' },
      columns: [
        col('employee', 'Employee', 'الموظف'), col('filesAssignedOpen', 'Open files', 'ملفات مفتوحة', 'int'), col('filesOpenedInPeriod', 'Opened', 'مفتوحة', 'int'),
        col('filesClosedInPeriod', 'Closed', 'مقفلة', 'int'), col('avgDaysToClose', 'Avg. days to close', 'متوسط أيام الإقفال', 'int'),
        col('tasksCompleted', 'Tasks done', 'مهام منجزة', 'int'), col('tasksOnTime', 'On time', 'ضمن المهلة', 'int'), col('tasksOverdueNow', 'Overdue now', 'متأخرة', 'int'),
        col('documentsUploaded', 'Documents', 'مستندات', 'int'), col('stageChanges', 'Stage changes', 'تغييرات المراحل', 'int'),
        col('serviceRevenue', `Revenue (${baseCurrency})`, `الإيراد (${baseCurrency})`, 'money'), col('profit', `Profit (${baseCurrency})`, `الربح (${baseCurrency})`, 'money'),
      ],
      rows,
      totals: { employee: '', filesAssignedOpen: total('filesAssignedOpen'), filesOpenedInPeriod: total('filesOpenedInPeriod'), filesClosedInPeriod: total('filesClosedInPeriod'), tasksCompleted: total('tasksCompleted'), documentsUploaded: total('documentsUploaded') },
      meta: { basis: 'BASE_CURRENCY', baseCurrency, from: q.from ?? null, to: q.to ?? null, note: 'Revenue and profit are those of the files currently assigned to the employee.' },
    };
  }

  // ═══════════════════════════ finance reports as tables (for export) ═══════════════════════════

  async profitability(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const res = await this.reports.profitability(auth.tenantId, { ...q, page: 1, limit: MAX_ROWS } as any);
    const bc = (res.meta as any).baseCurrency as string;
    return {
      name: 'profitability', title: { en: 'File profitability', ar: 'ربحية الملفات' },
      columns: [
        col('fileNumber', 'File', 'الملف'), col('client', 'Client', 'العميل'), col('status', 'Status', 'الحالة'),
        col('serviceRevenue', `Service revenue (${bc})`, `إيرادات الخدمات (${bc})`, 'money'), col('officeCosts', `Office costs (${bc})`, `تكاليف المكتب (${bc})`, 'money'),
        col('profit', `Profit (${bc})`, `الربح (${bc})`, 'money'), col('marginPercent', 'Margin %', 'الهامش %', 'percent'),
        col('unrecoveredDisbursements', `Unrecovered (${bc})`, `غير مستردّ (${bc})`, 'money'), col('fxGainLoss', `FX (${bc})`, `فروقات الصرف (${bc})`, 'money'),
      ],
      rows: res.items.map((i: any) => ({ ...i, client: i.client?.name })),
      totals: { fileNumber: '', ...((res.meta as any).totals as object) },
      meta: { basis: 'BASE_CURRENCY', baseCurrency: bc, from: q.from ?? null, to: q.to ?? null },
    };
  }

  async financialSummary(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const s = await this.reports.financialSummary(auth.tenantId, q);
    const bc = s.baseCurrency;
    const line = (key: string, en: string, ar: string, value: DecimalString) => ({ key, item: en, itemAr: ar, value });
    const rows = [
      line('receivables', 'Receivables', 'الذمم المدينة', s.position.receivables), line('clientAdvancesHeld', 'Client advances held', 'دفعات العملاء المقبوضة', s.position.clientAdvancesHeld),
      line('unrecoveredDisbursements', 'Unrecovered disbursements', 'مصاريف غير مستردّة', s.position.unrecoveredDisbursements), line('payables', 'Payables', 'الذمم الدائنة', s.position.payables),
      line('taxesPayable', 'Taxes payable', 'ضرائب مستحقة', s.position.taxesPayable), line('cashAndBankBase', 'Cash and bank', 'النقد والمصارف', s.position.cashAndBankBase),
      line('serviceRevenue', 'Service revenue (period)', 'إيرادات الخدمات (الفترة)', s.results.serviceRevenue), line('officeExpenses', 'Office expenses (period)', 'مصاريف المكتب (الفترة)', s.results.officeExpenses),
      line('operatingResult', 'Operating result (period)', 'النتيجة التشغيلية (الفترة)', s.results.operatingResult), line('fxGainLoss', 'FX gain / loss (period)', 'فروقات الصرف (الفترة)', s.results.fxGainLoss),
    ];
    return {
      name: 'financial-summary', title: { en: 'Financial summary', ar: 'الملخص المالي' },
      columns: [col('item', 'Item', 'البند'), col('value', `Amount (${bc})`, `المبلغ (${bc})`, 'money')],
      rows, meta: { basis: 'BASE_CURRENCY', baseCurrency: bc, from: q.from ?? null, to: q.to ?? null, transactionCurrency: s.transactionCurrency },
    };
  }

  async trialBalance(auth: AuthContext, q: OpsReportQuery): Promise<ReportTable> {
    const tb = await this.accounting.trialBalance(auth.tenantId, q.to);
    return {
      name: 'trial-balance', title: { en: 'Trial balance', ar: 'ميزان المراجعة' },
      columns: [
        col('accountCode', 'Account', 'الحساب'), col('name', 'Name', 'الاسم'), col('accountType', 'Type', 'النوع'),
        col('debit', `Debit (${tb.baseCurrency})`, `مدين (${tb.baseCurrency})`, 'money'), col('credit', `Credit (${tb.baseCurrency})`, `دائن (${tb.baseCurrency})`, 'money'),
        col('balance', `Balance (${tb.baseCurrency})`, `الرصيد (${tb.baseCurrency})`, 'money'),
      ],
      rows: tb.lines as any, totals: { accountCode: '', debit: tb.totals.debit, credit: tb.totals.credit },
      meta: { basis: 'BASE_CURRENCY', baseCurrency: tb.baseCurrency, asOf: tb.asOf, balanced: tb.balanced },
    };
  }

  private async tenantId() {
    return requireTenant().tenantId;
  }
}
