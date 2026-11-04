import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { forbidden } from '../../common/errors';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { dashboardQuerySchema, exportQuerySchema, opsReportQuerySchema, recentActivityQuerySchema } from '../finance/finance.schemas';
import { ReportsService } from '../finance/reports.service';
import { paginated } from '../../common/pagination';
import { DashboardService } from './dashboard.service';
import { ExportService } from './export.service';
import { OperationsReportsService } from './operations-reports.service';
import { PrintService } from './print.service';
import { sendPrinted } from './print.controller';
import type { ReportName } from './report-table';

type Q = z.infer<typeof opsReportQuerySchema>;
const pipe = () => new ZodPipe(opsReportQuerySchema);

/** The JSON form of a table: one page of rows plus report-wide totals and the columns a UI needs. */
function page(t: import('./report-table').ReportTable, q: Pick<Q, 'page' | 'limit'>) {
  const res = paginated(t.rows.slice((q.page - 1) * q.limit, q.page * q.limit), q, t.rows.length);
  Object.assign(res.meta, { report: t.name, title: t.title, columns: t.columns, totals: t.totals ?? null, ...t.meta });
  return res;
}

@Controller()
export class ReportsOpsController {
  constructor(
    @Inject(OperationsReportsService) private readonly ops: OperationsReportsService,
    @Inject(ExportService) private readonly exporter: ExportService,
    @Inject(DashboardService) private readonly dashboard: DashboardService,
    @Inject(PrintService) private readonly printer: PrintService,
    @Inject(ReportsService) private readonly finance: ReportsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── reports ─────────────────────────────

  @RequirePermissions('reports.view', 'clearance_files.view')
  @Get('reports/clearance-files')
  async clearanceFiles(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return page(await this.ops.build('clearance-files', auth, q), q);
  }

  @RequirePermissions('reports.view', 'invoices.view', 'payments.view')
  @Get('reports/client-balances')
  async clientBalances(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return page(await this.ops.build('client-balances', auth, q), q);
  }

  @RequirePermissions('reports.view', 'expenses.view')
  @Get('reports/expenses')
  async expenses(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return page(await this.ops.build('expenses', auth, q), q);
  }

  @RequirePermissions('reports.view')
  @Get('reports/revenue')
  async revenue(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return page(await this.ops.build('revenue', auth, q), q);
  }

  @RequirePermissions('reports.view', 'users.manage')
  @Get('reports/employee-performance')
  async employeePerformance(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return page(await this.ops.build('employee-performance', auth, q), q);
  }

  // ───────────────────────────── export ─────────────────────────────

  /** GET /reports/export?report=...&format=xlsx|csv&locale=en|ar plus the report's own filters. */
  @RequirePermissions('reports.export', 'reports.view')
  @Get('reports/export')
  async export(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(exportQuerySchema)) q: z.infer<typeof exportQuerySchema>, @ReqMeta() meta: RequestMeta, @Res() res: Response) {
    this.assertMayExport(auth, q.report);
    const table = await this.ops.build(q.report, auth, { ...q, page: 1, limit: 100 });
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { name: true } });
    if (q.format === 'pdf') {
      const printed = await this.printer.table(auth, table, q.locale, 'pdf');
      await this.audit.record({
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'REPORT_EXPORTED', entityType: 'Report', entityId: q.report,
        after: { format: 'pdf', locale: q.locale, rows: table.rows.length, from: q.from ?? null, to: q.to ?? null }, ip: meta.ip, userAgent: meta.userAgent,
      });
      return sendPrinted(res, printed, 'attachment');
    }
    const body = q.format === 'xlsx'
      ? await this.exporter.toXlsx(table, { locale: q.locale, officeName: tenant.name, generatedBy: auth.email })
      : this.exporter.toCsv(table, { locale: q.locale });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'REPORT_EXPORTED', entityType: 'Report', entityId: q.report,
      after: { format: q.format, locale: q.locale, rows: table.rows.length, from: q.from ?? null, to: q.to ?? null }, ip: meta.ip, userAgent: meta.userAgent,
    });
    const name = this.exporter.fileName(table, q.format);
    res.setHeader('Content-Type', q.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(body);
  }

  /** Each report needs the permissions of its page: an export must never reveal more than the report does. */
  private assertMayExport(auth: AuthContext, report: ReportName) {
    const need: Record<ReportName, string[]> = {
      'clearance-files': ['clearance_files.view'], 'client-balances': ['invoices.view', 'payments.view'], expenses: ['expenses.view'],
      revenue: [], 'employee-performance': ['users.manage'], profitability: [], 'financial-summary': [], 'trial-balance': ['accounting.view'],
    };
    const missing = need[report].filter((p) => !auth.permissions.has(p));
    if (missing.length) throw forbidden('PERMISSION_DENIED', 'You do not have permission to export this report');
  }

  // ───────────────────────────── dashboard ─────────────────────────────

  @RequirePermissions('clearance_files.view')
  @Get('dashboard/overview')
  overview(@CurrentAuth() auth: AuthContext) {
    return this.dashboard.overview(auth);
  }

  @RequirePermissions('clearance_files.view')
  @Get('dashboard/clearance-statistics')
  statistics() {
    return this.dashboard.statistics();
  }

  @RequirePermissions('clearance_files.view')
  @Get('dashboard/pending-files')
  pending(@Query(new ZodPipe(dashboardQuerySchema)) q: z.infer<typeof dashboardQuerySchema>) {
    return this.dashboard.pendingFiles(q);
  }

  @RequirePermissions('clearance_files.view')
  @Get('dashboard/recent-activities')
  recent(@Query(new ZodPipe(recentActivityQuerySchema)) q: z.infer<typeof recentActivityQuerySchema>) {
    return this.dashboard.recentActivities(q.limit);
  }

  /** The financial figures of the dashboard (same data as /reports/financial-summary). */
  @RequirePermissions('reports.view')
  @Get('dashboard/financial-summary')
  financialSummary(@CurrentAuth() auth: AuthContext, @Query(pipe()) q: Q) {
    return this.finance.financialSummary(auth.tenantId, q);
  }
}
