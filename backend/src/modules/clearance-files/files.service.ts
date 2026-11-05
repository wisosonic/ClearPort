import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { sum } from '../../common/money';
import { fileNumberPrefix, nextDocumentNumber } from '../../common/numbering';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { normalizeContainerNumber } from '../../common/iso6346';
import { searchIds } from '../../common/search';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import { ActivityService } from './activity.service';
import type { CreateFileInput, FileListQuery, UpdateFileInput, timelineQuerySchema } from './files.schemas';

const FILE_SORT = ['openedAt', 'createdAt', 'fileNumber', 'expectedArrivalAt', 'priority', 'status'] as const;

const userSelect = { id: true, firstName: true, lastName: true } as const;
const stageSelect = { id: true, code: true, nameEn: true, nameAr: true, isTerminal: true } as const;

/** The calendar year in the office's timezone, so a file opened on 31 Dec in Beirut is numbered in that year. */
export function yearInTimezone(date: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(date));
  } catch {
    return date.getUTCFullYear();
  }
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────────── listing and search ─────────────────────────────

  async list(auth: AuthContext, q: FileListQuery) {
    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.fileType) where.fileType = q.fileType;
    if (q.priority) where.priority = q.priority;
    if (q.clientId) where.clientId = q.clientId;
    if (q.branchId) where.branchId = q.branchId;
    if (q.assignedTo === 'me') where.assignedTo = auth.userId;
    else if (q.assignedTo === 'unassigned') where.assignedTo = null;
    else if (q.assignedTo) where.assignedTo = q.assignedTo;
    if (q.stage) where.currentStage = { code: q.stage };
    if (q.openedFrom || q.openedTo) {
      where.openedAt = {
        ...(q.openedFrom && { gte: new Date(`${q.openedFrom}T00:00:00.000Z`) }),
        ...(q.openedTo && { lte: new Date(`${q.openedTo}T23:59:59.999Z`) }),
      };
    }
    if (q.search) where.id = { in: await this.searchFileIds(q.search) };

    const [rows, total] = await Promise.all([
      this.db.client.clearanceFile.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, FILE_SORT, { createdAt: 'desc' }), select: this.listSelect,
      }),
      this.db.client.clearanceFile.count({ where }),
    ]);
    return paginated(rows.map((r) => this.presentListItem(r)), q, total);
  }

  /**
   * One search box over everything staff remember a file by (spec 18.6): file number, customs
   * reference, client name/code, BL numbers, container number, invoice number.
   */
  private async searchFileIds(term: string): Promise<string[]> {
    const { tenantId } = requireTenant();
    const raw = this.db.client;
    const ids = new Set<string>();
    const find = (table: string, columns: string[], t = term) => searchIds(raw, { table, columns, term: t, tenantId });

    for (const id of await find('clearance_files', ['fileNumber', 'customsReference'])) ids.add(id);

    const clientIds = await find('clients', ['name', 'legalName', 'clientCode']);
    if (clientIds.length) {
      for (const f of await raw.clearanceFile.findMany({ where: { clientId: { in: clientIds } }, select: { id: true } })) ids.add(f.id);
    }

    const shipmentIds = new Set(await find('shipments', ['billOfLadingNumber', 'masterBlNumber', 'houseBlNumber', 'vesselName']));
    const containerIds = await find('containers', ['containerNumber'], normalizeContainerNumber(term) || term);
    if (containerIds.length) {
      for (const c of await raw.container.findMany({ where: { id: { in: containerIds } }, select: { shipmentId: true } })) {
        shipmentIds.add(c.shipmentId);
      }
    }
    if (shipmentIds.size) {
      for (const s of await raw.shipment.findMany({ where: { id: { in: [...shipmentIds] } }, select: { clearanceFileId: true } })) {
        ids.add(s.clearanceFileId);
      }
    }

    const invoiceIds = await find('invoices', ['invoiceNumber']);
    if (invoiceIds.length) {
      for (const i of await raw.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { clearanceFileId: true } })) {
        ids.add(i.clearanceFileId);
      }
    }
    return [...ids];
  }

  private readonly listSelect = {
    id: true, fileNumber: true, fileType: true, status: true, priority: true, openedAt: true,
    expectedArrivalAt: true, closedAt: true, customsReference: true, createdAt: true,
    client: { select: { id: true, clientCode: true, name: true } },
    branch: { select: { id: true, code: true, name: true } },
    currentStage: { select: stageSelect },
    assignee: { select: { user: { select: userSelect } } },
  } as const;

  private presentListItem(r: any) {
    const { assignee, ...rest } = r;
    return { ...rest, assignee: assignee?.user ?? null };
  }

  // ───────────────────────────── single file ─────────────────────────────

  async get(id: string) {
    const f = await this.db.client.clearanceFile.findUnique({
      where: { id },
      select: {
        ...this.listSelect, internalNotes: true, workflowTemplateId: true, updatedAt: true,
        workflowTemplate: { select: { id: true, name: true } },
        creator: { select: { user: { select: userSelect } } },
        shipments: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true, shipmentType: true, vesselName: true, voyageNumber: true, billOfLadingNumber: true,
            eta: true, _count: { select: { containers: true, goodsItems: true } },
          },
        },
      },
    });
    if (!f) throw notFound('CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    const { creator, ...rest } = f as any;
    return { ...this.presentListItem(rest), createdBy: creator?.user ?? null };
  }

  /** Raw row, for services that need to check state before changing something. */
  async require(id: string) {
    const f = await this.db.client.clearanceFile.findUnique({ where: { id } });
    if (!f) throw notFound('CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    return f;
  }

  /** Closed and cancelled files are read-only until reopened (Phase 4: POST .../reopen). */
  assertEditable(file: { status: string; fileNumber: string }) {
    if (file.status === 'CLOSED' || file.status === 'CANCELLED') {
      throw conflict('FILE_NOT_EDITABLE', `File ${file.fileNumber} is ${file.status.toLowerCase()} and cannot be changed`);
    }
  }

  // ───────────────────────────── create ─────────────────────────────

  async create(auth: AuthContext, input: CreateFileInput, meta: RequestMeta) {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId }, select: { timezone: true },
    });
    const opened = new Date();
    const year = yearInTimezone(opened, tenant.timezone);

    const created = await this.db.client.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id: input.clientId } });
      if (!client) throw unprocessable('CLIENT_NOT_FOUND', 'Client not found in your office');
      if (!client.isActive) throw unprocessable('CLIENT_INACTIVE', 'This client is inactive');
      if (input.branchId) await this.assertBranch(tx, input.branchId);
      if (input.assignedTo) await this.assertAssignee(tx, input.assignedTo);

      // The backend picks the workflow; it is never supplied by the client.
      const template = await tx.workflowTemplate.findFirst({
        where: { fileType: input.fileType, isActive: true },
        orderBy: { createdAt: 'asc' },
        include: { stages: { orderBy: { sequence: 'asc' }, take: 1 } },
      });
      const firstStage = template?.stages[0] ?? null;

      // Allocated inside this transaction: a failed creation does not burn a number.
      const fileNumber = await nextDocumentNumber(tx as any, auth.tenantId, fileNumberPrefix(input.fileType), year);

      const file = await tx.clearanceFile.create({
        data: {
          fileNumber, fileType: input.fileType, clientId: input.clientId, branchId: input.branchId ?? null,
          assignedTo: input.assignedTo ?? null, priority: input.priority,
          expectedArrivalAt: input.expectedArrivalAt ?? null, customsReference: input.customsReference ?? null,
          internalNotes: input.internalNotes ?? null, createdBy: auth.userId, openedAt: opened,
          workflowTemplateId: template?.id ?? null, currentStageId: firstStage?.id ?? null,
        } as any,
      });
      if (firstStage) {
        await tx.fileStatusHistory.create({
          data: { clearanceFileId: file.id, fromStageId: null, toStageId: firstStage.id, changedBy: auth.userId, reason: 'File created' } as any,
        });
      }
      await this.activity.log(file.id, auth.userId, 'FILE_CREATED', `File ${fileNumber} created for ${client.name}`, { fileNumber }, tx);
      if (input.assignedTo) await this.recordAssignment(tx, file, auth, input.assignedTo, null);
      return file;
    });

    const result = await this.get(created.id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_CREATED', entityType: 'ClearanceFile',
      entityId: created.id, after: { fileNumber: created.fileNumber, fileType: created.fileType, clientId: created.clientId },
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return result;
  }

  // ───────────────────────────── update / assign ─────────────────────────────

  async update(auth: AuthContext, id: string, input: UpdateFileInput, meta: RequestMeta) {
    const before = await this.require(id);
    this.assertEditable(before);
    const tx = this.db.client;

    if (input.clientId && input.clientId !== before.clientId) {
      const client = await tx.client.findUnique({ where: { id: input.clientId } });
      if (!client) throw unprocessable('CLIENT_NOT_FOUND', 'Client not found in your office');
      if (!client.isActive) throw unprocessable('CLIENT_INACTIVE', 'This client is inactive');
      // Money already recorded against the old client must not silently move to another one.
      const financial = (await tx.invoice.count({ where: { clearanceFileId: id } }))
        + (await tx.payment.count({ where: { clearanceFileId: id } }))
        + (await tx.expense.count({ where: { clearanceFileId: id } }));
      if (financial > 0) {
        throw conflict('FILE_HAS_FINANCIAL_RECORDS', 'The client cannot be changed once invoices, payments or expenses exist');
      }
    }
    if (input.branchId) await this.assertBranch(tx, input.branchId);

    await tx.clearanceFile.update({ where: { id }, data: input as any });
    const after = await this.require(id);

    const changed = (Object.keys(input) as (keyof UpdateFileInput)[]).filter(
      (k) => JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k]),
    );
    if (changed.includes('customsReference')) {
      await this.activity.log(id, auth.userId, 'CUSTOMS_REFERENCE_UPDATED',
        `Customs reference ${before.customsReference ? `changed from ${before.customsReference} to` : 'set to'} ${after.customsReference ?? '(cleared)'}`,
        { from: before.customsReference, to: after.customsReference });
    }
    const other = changed.filter((k) => k !== 'customsReference');
    if (other.length) await this.activity.log(id, auth.userId, 'FILE_UPDATED', `File details updated: ${other.join(', ')}`, { fields: other });

    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_UPDATED', entityType: 'ClearanceFile',
      entityId: id, before: pick(before, changed), after: pick(after, changed), ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  async assign(auth: AuthContext, id: string, userId: string | null, meta: RequestMeta) {
    const before = await this.require(id);
    this.assertEditable(before);
    if (before.assignedTo === userId) return this.get(id);
    if (userId) await this.assertAssignee(this.db.client, userId);

    await this.db.client.$transaction(async (tx) => {
      await tx.clearanceFile.update({ where: { id }, data: { assignedTo: userId } });
      await this.recordAssignment(tx, before, auth, userId, before.assignedTo);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_ASSIGNED', entityType: 'ClearanceFile',
      entityId: id, before: { assignedTo: before.assignedTo }, after: { assignedTo: userId }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  private async recordAssignment(tx: any, file: { id: string; fileNumber: string }, auth: AuthContext, to: string | null, from: string | null) {
    const names = new Map<string, string>();
    for (const uid of [to, from].filter(Boolean) as string[]) {
      const m = await tx.tenantUser.findFirst({ where: { userId: uid }, include: { user: { select: userSelect } } });
      if (m) names.set(uid, `${m.user.firstName} ${m.user.lastName}`);
    }
    const description = to
      ? `Assigned to ${names.get(to) ?? 'an employee'}${from ? ` (was ${names.get(from) ?? 'someone else'})` : ''}`
      : `Unassigned (was ${from ? names.get(from) ?? 'someone' : 'nobody'})`;
    await this.activity.log(file.id, auth.userId, 'EMPLOYEE_ASSIGNED', description, { from, to }, tx);
    if (to && to !== auth.userId) {
      await this.notifications.create(tx, {
        userId: to, type: 'FILE_ASSIGNED', title: `File ${file.fileNumber} assigned to you`,
        metadata: { clearanceFileId: file.id, fileNumber: file.fileNumber },
      });
    }
  }

  // ───────────────────────────── timeline and summary ─────────────────────────────

  async timeline(fileId: string, q: z.infer<typeof timelineQuerySchema>) {
    await this.require(fileId);
    const [rows, total] = await Promise.all([
      this.db.client.fileActivity.findMany({
        where: { clearanceFileId: fileId }, ...pageArgs(q), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.client.fileActivity.count({ where: { clearanceFileId: fileId } }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const members = await this.db.client.tenantUser.findMany({
      where: { userId: { in: userIds } }, select: { userId: true, user: { select: userSelect } },
    });
    const byId = new Map(members.map((m) => [m.userId, m.user]));
    return paginated(rows.map((r) => ({ ...r, user: byId.get(r.userId) ?? null })), q, total);
  }

  /** Operational summary. Financial figures arrive with the finance module (Phase 5). */
  async summary(fileId: string) {
    const file = await this.get(fileId);
    const c = this.db.client;
    const [shipments, containers, goods, documents, openTasks, shipmentRows, containerRows] = await Promise.all([
      c.shipment.count({ where: { clearanceFileId: fileId } }),
      c.container.count({ where: { shipment: { clearanceFileId: fileId } } }),
      c.goodsItem.findMany({ where: { shipment: { clearanceFileId: fileId } }, select: { lineTotal: true, currencyCode: true, grossWeight: true, netWeight: true } }),
      c.document.count({ where: { clearanceFileId: fileId, deletedAt: null } }),
      c.task.count({ where: { clearanceFileId: fileId, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      c.shipment.findMany({ where: { clearanceFileId: fileId }, select: { eta: true, actualArrivalAt: true } }),
      c.container.findMany({ where: { shipment: { clearanceFileId: fileId } }, select: { grossWeight: true, netWeight: true, packageCount: true } }),
    ]);

    const valueByCurrency: Record<string, string> = {};
    for (const cur of new Set(goods.filter((g) => g.lineTotal && g.currencyCode).map((g) => g.currencyCode!))) {
      valueByCurrency[cur] = sum(goods.filter((g) => g.currencyCode === cur && g.lineTotal).map((g) => g.lineTotal!));
    }
    const weight = (vals: (string | null)[]) =>
      vals.filter((v): v is string => !!v).reduce((a, v) => a.plus(v), new Decimal(0)).toFixed(3);
    const etas = shipmentRows.map((s) => s.eta).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());

    return {
      file: {
        id: file.id, fileNumber: file.fileNumber, fileType: file.fileType, status: file.status, priority: file.priority,
        client: file.client, currentStage: file.currentStage, assignee: file.assignee,
        expectedArrivalAt: file.expectedArrivalAt, customsReference: file.customsReference,
      },
      counts: { shipments, containers, goodsLines: goods.length, documents, openTasks },
      goodsValueByCurrency: valueByCurrency,
      totals: {
        containerGrossWeight: weight(containerRows.map((r) => r.grossWeight)),
        containerNetWeight: weight(containerRows.map((r) => r.netWeight)),
        goodsGrossWeight: weight(goods.map((g) => g.grossWeight)),
        goodsNetWeight: weight(goods.map((g) => g.netWeight)),
        packages: containerRows.reduce((a, r) => a + (r.packageCount ?? 0), 0),
      },
      nextEta: etas.find((d) => d.getTime() >= Date.now()) ?? etas[0] ?? null,
      allShipmentsArrived: shipmentRows.length > 0 && shipmentRows.every((s) => !!s.actualArrivalAt),
      financial: null as null, // Phase 5
    };
  }

  // ───────────────────────────── validation helpers ─────────────────────────────

  private async assertBranch(db: any, branchId: string) {
    const b = await db.branch.findUnique({ where: { id: branchId } });
    if (!b) throw unprocessable('BRANCH_NOT_FOUND', 'Branch not found in your office');
    if (!b.isActive) throw unprocessable('BRANCH_INACTIVE', 'This branch is inactive');
  }

  /** The assignee must be an ACTIVE member of this office (the composite FK only proves membership). */
  private async assertAssignee(db: any, userId: string) {
    const m = await db.tenantUser.findFirst({ where: { userId }, include: { user: { select: { isActive: true } } } });
    if (!m || !m.isActive || !m.user.isActive) {
      throw unprocessable('ASSIGNEE_NOT_FOUND', 'The assignee is not an active employee of your office');
    }
  }
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
