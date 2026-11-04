import { Inject, Injectable } from '@nestjs/common';
import { compare, sub, sum, ZERO } from '../../common/money';
import { TenantDbService } from '../../database/prisma.module';
import type { AuthContext } from '../auth/auth.types';
import { ReportsService } from '../finance/reports.service';

const DAY = 86_400_000;
const userSelect = { firstName: true, lastName: true } as const;
const name = (u?: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
const OPEN = ['OPEN', 'ON_HOLD'] as const;

const fileSelect = {
  id: true, fileNumber: true, fileType: true, priority: true, status: true, expectedArrivalAt: true,
  client: { select: { id: true, name: true } }, currentStage: { select: { code: true, nameEn: true, nameAr: true } },
  assignee: { select: { user: { select: userSelect } } },
} as const;
const presentFile = (f: any, extra: Record<string, unknown> = {}) => ({
  id: f.id, fileNumber: f.fileNumber, fileType: f.fileType, priority: f.priority, status: f.status, expectedArrivalAt: f.expectedArrivalAt,
  client: f.client, stage: f.currentStage, assignee: name(f.assignee?.user), ...extra,
});

/**
 * Dashboard data (spec 14.8). Blocks that expose money or tasks appear only for callers who hold the
 * matching permission — the dashboard never shows more than the underlying pages would.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  // ═══════════════════════════ overview ═══════════════════════════

  async overview(auth: AuthContext) {
    const c = this.db.client;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const has = (p: string) => auth.permissions.has(p);

    const [byStatus, urgent, unassigned, openedThisMonth, closedThisMonth] = await Promise.all([
      c.clearanceFile.groupBy({ by: ['status'], _count: { _all: true } }),
      c.clearanceFile.count({ where: { status: { in: [...OPEN] }, priority: { in: ['URGENT', 'HIGH'] } } }),
      c.clearanceFile.count({ where: { status: 'OPEN', assignedTo: null } }),
      c.clearanceFile.count({ where: { openedAt: { gte: monthStart } } }),
      c.clearanceFile.count({ where: { status: 'CLOSED', closedAt: { gte: monthStart } } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
    const out: Record<string, unknown> = {
      generatedAt: now.toISOString(),
      files: { open: counts.OPEN ?? 0, onHold: counts.ON_HOLD ?? 0, closed: counts.CLOSED ?? 0, cancelled: counts.CANCELLED ?? 0, highPriority: urgent, unassigned, openedThisMonth, closedThisMonth },
    };

    if (has('tasks.view')) {
      const [mine, myOverdue, officeOverdue] = await Promise.all([
        c.task.count({ where: { assignedTo: auth.userId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
        c.task.count({ where: { assignedTo: auth.userId, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now } } }),
        c.task.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now } } }),
      ]);
      out.tasks = { myOpen: mine, myOverdue, officeOverdue };
    }
    if (has('documents.view')) {
      out.documents = { pendingReview: await c.document.count({ where: { status: 'PENDING_REVIEW', deletedAt: null, clearanceFile: { status: { in: [...OPEN] } } } }) };
    }
    if (has('reports.view') && has('invoices.view')) {
      const fin = await this.reports.financialSummary(auth.tenantId, {});
      const issued = await c.invoice.findMany({ where: { status: 'ISSUED', invoiceType: { not: 'ADVANCE' } }, select: { id: true, totalAmount: true, dueDate: true, currencyCode: true } });
      const allocs = issued.length ? await c.paymentAllocation.findMany({ where: { invoiceId: { in: issued.map((i) => i.id) }, reversedAt: null, payment: { status: 'POSTED' } }, select: { invoiceId: true, allocatedAmount: true } }) : [];
      const open = issued.map((i) => ({ ...i, outstanding: sub(i.totalAmount, sum(allocs.filter((a) => a.invoiceId === i.id).map((a) => a.allocatedAmount))) })).filter((i) => compare(i.outstanding, ZERO) > 0);
      const overdue = open.filter((i) => i.dueDate && i.dueDate < now);
      const byCur = (rows: typeof open) => { const m: Record<string, string> = {}; for (const cur of new Set(rows.map((r) => r.currencyCode))) m[cur] = sum(rows.filter((r) => r.currencyCode === cur).map((r) => r.outstanding)); return m; };
      out.finance = {
        baseCurrency: fin.baseCurrency, receivables: fin.position.receivables, clientAdvancesHeld: fin.position.clientAdvancesHeld,
        unrecoveredDisbursements: fin.position.unrecoveredDisbursements, cashAndBankBase: fin.position.cashAndBankBase,
        unpaidInvoices: { count: open.length, outstandingByCurrency: byCur(open) }, overdueInvoices: { count: overdue.length, outstandingByCurrency: byCur(overdue) },
      };
    }
    return out;
  }

  // ═══════════════════════════ statistics ═══════════════════════════

  async statistics() {
    const c = this.db.client;
    const yearAgo = new Date(); yearAgo.setUTCMonth(yearAgo.getUTCMonth() - 11, 1); yearAgo.setUTCHours(0, 0, 0, 0);
    const [byStatus, byType, byPriority, openByStage, workload, recent] = await Promise.all([
      c.clearanceFile.groupBy({ by: ['status'], _count: { _all: true } }),
      c.clearanceFile.groupBy({ by: ['fileType'], _count: { _all: true } }),
      c.clearanceFile.groupBy({ by: ['priority'], where: { status: { in: [...OPEN] } }, _count: { _all: true } }),
      c.clearanceFile.groupBy({ by: ['currentStageId'], where: { status: { in: [...OPEN] } }, _count: { _all: true } }),
      c.clearanceFile.groupBy({ by: ['assignedTo'], where: { status: { in: [...OPEN] } }, _count: { _all: true } }),
      c.clearanceFile.findMany({ where: { OR: [{ openedAt: { gte: yearAgo } }, { closedAt: { gte: yearAgo } }] }, select: { openedAt: true, closedAt: true, status: true }, take: 20_000 }),
    ]);
    const stageIds = openByStage.map((r) => r.currentStageId).filter((x): x is string => !!x);
    const stages = stageIds.length ? await c.workflowStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, code: true, nameEn: true, nameAr: true } }) : [];
    const userIds = workload.map((w) => w.assignedTo).filter((x): x is string => !!x);
    const members = userIds.length ? await c.tenantUser.findMany({ where: { userId: { in: userIds } }, select: { userId: true, user: { select: userSelect } } }) : [];

    // last 12 months, oldest first, zero-filled
    const months: { month: string; opened: number; closed: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.UTC(yearAgo.getUTCFullYear(), yearAgo.getUTCMonth() + i, 1));
      months.push({ month: d.toISOString().slice(0, 7), opened: 0, closed: 0 });
    }
    const slot = (d: Date | null) => (d ? months.find((m) => m.month === d.toISOString().slice(0, 7)) : undefined);
    for (const f of recent) {
      const o = slot(f.openedAt); if (o) o.opened++;
      if (f.status === 'CLOSED') { const k = slot(f.closedAt); if (k) k.closed++; }
    }
    const closed = recent.filter((f) => f.status === 'CLOSED' && f.closedAt);
    const avg = closed.length ? Math.round((closed.reduce((s, f) => s + (f.closedAt!.getTime() - f.openedAt.getTime()) / DAY, 0) / closed.length) * 10) / 10 : null;
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byType: Object.fromEntries(byType.map((r) => [r.fileType, r._count._all])),
      openByPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r._count._all])),
      // import and export workflows have separate stage rows; stages that share a code are one line on the dashboard
      openByStage: mergeStages(openByStage.map((r) => ({ stage: stages.find((s) => s.id === r.currentStageId) ?? null, count: r._count._all }))),
      workload: workload.map((w) => ({ employee: name(members.find((m) => m.userId === w.assignedTo)?.user) ?? (w.assignedTo ? 'Former employee' : 'Unassigned'), openFiles: w._count._all })).sort((a, b) => b.openFiles - a.openFiles),
      monthly: months,
      averageDaysToClose: avg,
    };
  }

  // ═══════════════════════════ files needing attention ═══════════════════════════

  async pendingFiles(opts: { staleDays: number; arrivingWithinDays: number; limit: number }) {
    const c = this.db.client;
    const now = new Date();
    const open = { status: 'OPEN' as const };
    const lim = opts.limit;
    const soon = new Date(now.getTime() + opts.arrivingWithinDays * DAY);

    const arrivedFilter = { shipments: { none: { actualArrivalAt: { not: null } } } };
    const [overdueArrival, arrivingSoon, unassigned, highPriority] = await Promise.all([
      this.list({ ...open, expectedArrivalAt: { lt: now }, ...arrivedFilter }, lim, { expectedArrivalAt: 'asc' }, (f) => ({ daysLate: Math.floor((now.getTime() - f.expectedArrivalAt.getTime()) / DAY) })),
      this.list({ ...open, expectedArrivalAt: { gte: now, lte: soon } }, lim, { expectedArrivalAt: 'asc' }, (f) => ({ daysToArrival: Math.ceil((f.expectedArrivalAt.getTime() - now.getTime()) / DAY) })),
      this.list({ ...open, assignedTo: null }, lim, { createdAt: 'asc' }),
      this.list({ status: { in: [...OPEN] }, priority: { in: ['URGENT', 'HIGH'] } }, lim, { createdAt: 'asc' }),
    ]);

    // stale: no timeline activity for N days (or ever)
    const openFiles = await c.clearanceFile.findMany({ where: open, select: { ...fileSelect, createdAt: true }, take: 5000 });
    const latest = openFiles.length ? await c.fileActivity.groupBy({ by: ['clearanceFileId'], where: { clearanceFileId: { in: openFiles.map((f) => f.id) } }, _max: { createdAt: true } }) : [];
    const lastAt = new Map(latest.map((l) => [l.clearanceFileId, l._max.createdAt as Date | null]));
    const cutoff = new Date(now.getTime() - opts.staleDays * DAY);
    const staleAll = openFiles.map((f) => ({ f, last: lastAt.get(f.id) ?? f.createdAt })).filter((x) => x.last < cutoff).sort((a, b) => a.last.getTime() - b.last.getTime());

    // missing required documents (any required document of the file type with no usable copy)
    const [reqs, docs, types] = await Promise.all([
      c.documentRequirement.findMany({ where: { isRequired: true }, select: { fileType: true, documentTypeId: true } }),
      openFiles.length ? c.document.findMany({ where: { clearanceFileId: { in: openFiles.map((f) => f.id) }, deletedAt: null, status: { notIn: ['REJECTED', 'VOID'] } }, select: { clearanceFileId: true, documentTypeId: true } }) : [],
      c.documentType.findMany({ select: { id: true, nameEn: true, nameAr: true } }),
    ]);
    const typeName = new Map(types.map((t) => [t.id, t]));
    const have = new Map<string, Set<string>>();
    for (const d of docs) (have.get(d.clearanceFileId) ?? have.set(d.clearanceFileId, new Set()).get(d.clearanceFileId)!).add(d.documentTypeId);
    const missingAll = openFiles.map((f) => ({
      f, missing: [...new Set(reqs.filter((r) => r.fileType === f.fileType).map((r) => r.documentTypeId))].filter((t) => !have.get(f.id)?.has(t)),
    })).filter((x) => x.missing.length > 0).sort((a, b) => b.missing.length - a.missing.length);

    return {
      thresholds: { staleDays: opts.staleDays, arrivingWithinDays: opts.arrivingWithinDays },
      overdueArrival, arrivingSoon, unassigned, highPriority,
      stale: { total: staleAll.length, items: staleAll.slice(0, lim).map((x) => presentFile(x.f, { lastActivityAt: x.last, daysQuiet: Math.floor((now.getTime() - x.last.getTime()) / DAY) })) },
      missingDocuments: {
        total: missingAll.length,
        items: missingAll.slice(0, lim).map((x) => presentFile(x.f, { missing: x.missing.map((t) => ({ code: typeName.get(t)?.nameEn, nameEn: typeName.get(t)?.nameEn, nameAr: typeName.get(t)?.nameAr })) })),
      },
    };
  }

  private async list(where: any, limit: number, orderBy: any, extra?: (f: any) => Record<string, unknown>) {
    const [total, rows] = await Promise.all([
      this.db.client.clearanceFile.count({ where }),
      this.db.client.clearanceFile.findMany({ where, orderBy, take: limit, select: fileSelect }),
    ]);
    return { total, items: rows.map((f) => presentFile(f, extra?.(f))) };
  }

  // ═══════════════════════════ recent activity ═══════════════════════════

  async recentActivities(limit: number) {
    const rows = await this.db.client.fileActivity.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit,
      include: { clearanceFile: { select: { id: true, fileNumber: true, client: { select: { name: true } } } } },
    });
    const members = await this.db.client.tenantUser.findMany({ where: { userId: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { userId: true, user: { select: userSelect } } });
    const names = new Map(members.map((m) => [m.userId, name(m.user)]));
    return rows.map((r) => ({
      id: r.id, activityType: r.activityType, description: r.description, createdAt: r.createdAt, user: names.get(r.userId) ?? null,
      file: { id: r.clearanceFile.id, fileNumber: r.clearanceFile.fileNumber, client: r.clearanceFile.client.name },
    }));
  }
}

function mergeStages(rows: { stage: { id: string; code: string; nameEn: string; nameAr: string } | null; count: number }[]) {
  const byCode = new Map<string, { stage: { code: string; nameEn: string; nameAr: string } | null; count: number }>();
  for (const r of rows) {
    const key = r.stage?.code ?? '(none)';
    const cur = byCode.get(key);
    if (cur) cur.count += r.count;
    else byCode.set(key, { stage: r.stage ? { code: r.stage.code, nameEn: r.stage.nameEn, nameAr: r.stage.nameAr } : null, count: r.count });
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}
