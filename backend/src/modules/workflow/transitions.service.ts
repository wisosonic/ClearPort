import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, DomainError, notFound, unprocessable } from '../../common/errors';
import { sub, sum } from '../../common/money';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ActivityService } from '../clearance-files/activity.service';
import { FilesService } from '../clearance-files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RequirementsService } from '../documents/requirements.service';
import type { closeSchema, TransitionInput } from './workflow.schemas';

export interface Blocker {
  code: string;
  message: string;
  details?: unknown;
}

const stageSelect = { id: true, code: true, nameEn: true, nameAr: true, sequence: true, isTerminal: true } as const;
const OPEN_TASK = ['OPEN', 'IN_PROGRESS'] as const;
const userSelect = { id: true, firstName: true, lastName: true } as const;

/** HTTP status for the first blocking reason. */
const BLOCKER_STATUS: Record<string, number> = {
  FILE_NOT_ACTIVE: 409, NO_WORKFLOW: 409, NOT_AT_TERMINAL_STAGE: 409,
  PERMISSION_DENIED: 403, APPROVAL_REQUIRED: 403,
};

/**
 * The workflow engine (spec 5.2). A file never has a freely editable status: it moves only along
 * configured transitions, and the BACKEND decides whether a move is allowed. The same rule
 * evaluation powers `GET .../transitions` (what the UI offers, and why something is blocked) and the
 * enforcement in `transition()`, so the two can never disagree.
 */
@Injectable()
export class TransitionsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(RequirementsService) private readonly requirements: RequirementsService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────────── what can I do next? ─────────────────────────────

  async available(auth: AuthContext, fileId: string) {
    const file = await this.loadFile(fileId);
    if (!file.currentStageId || !file.workflowTemplateId) {
      return { currentStage: null, status: file.status, transitions: [] };
    }
    const transitions = await this.outgoing(file);
    const rows = [];
    for (const t of transitions) {
      const blockers = await this.blockers(auth, file, t);
      rows.push({
        transitionId: t.id, toStage: t.toStage, requiredPermission: t.requiredPermission ?? 'clearance_files.transition',
        requiresReason: t.requiresReason, requiresApproval: t.requiresApproval,
        requiresDocumentCheck: t.requiresDocumentCheck, requiredTaskCheck: t.requiredTaskCheck,
        allowed: blockers.length === 0, blockers,
      });
    }
    return { currentStage: file.currentStage, status: file.status, transitions: rows };
  }

  // ───────────────────────────── move a file ─────────────────────────────

  async transition(auth: AuthContext, fileId: string, input: TransitionInput, meta: RequestMeta) {
    const file = await this.loadFile(fileId);
    // Say WHY first: a closed file has no outgoing transitions, but "file is closed" is the useful answer.
    if (file.status !== 'OPEN') {
      throw new DomainError('FILE_NOT_ACTIVE', `The file is ${file.status.toLowerCase()} and cannot change stage`, 409);
    }
    if (!file.currentStageId || !file.workflowTemplateId) {
      throw new DomainError('NO_WORKFLOW', 'This file has no workflow stage; it cannot be moved', 409);
    }
    const outgoing = await this.outgoing(file);
    const chosen = outgoing.find((t) => (input.toStageId ? t.toStageId === input.toStageId : t.toStage.code === input.toStageCode));
    if (!chosen) {
      throw new DomainError('TRANSITION_NOT_ALLOWED',
        `This file cannot move from "${file.currentStage!.nameEn}" to the requested stage`, 409,
        outgoing.map((t) => ({ allowedTo: t.toStage.code, nameEn: t.toStage.nameEn })));
    }

    const blockers = await this.blockers(auth, file, chosen);
    if (blockers.length > 0) throw this.blockedError(blockers);
    if (chosen.requiresReason && (!input.reason || input.reason.length < 3)) {
      throw unprocessable('REASON_REQUIRED', 'This transition requires a reason', [{ path: 'reason' }]);
    }

    const from = file.currentStage!;
    const to = chosen.toStage;
    await this.db.client.$transaction(async (tx) => {
      // Atomic claim: if another request moved the file meanwhile, this one fails cleanly.
      const claimed = await tx.clearanceFile.updateMany({
        where: { id: fileId, currentStageId: from.id, status: 'OPEN' }, data: { currentStageId: to.id },
      });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The file was changed by someone else; reload and try again');
      await tx.fileStatusHistory.create({
        data: { clearanceFileId: fileId, fromStageId: from.id, toStageId: to.id, changedBy: auth.userId, reason: input.reason ?? null } as any,
      });
      await this.activity.log(fileId, auth.userId, 'STAGE_CHANGED',
        `Stage changed from ${from.nameEn} to ${to.nameEn}${input.reason ? ` — ${input.reason}` : ''}`,
        { fromStageId: from.id, toStageId: to.id, from: from.code, to: to.code, reason: input.reason ?? null }, tx);
      if (file.assignedTo && file.assignedTo !== auth.userId) {
        await this.notifications.create(tx, {
          userId: file.assignedTo, type: 'FILE_STAGE_CHANGED', title: `File ${file.fileNumber} moved to ${to.nameEn}`,
          metadata: { clearanceFileId: fileId, fileNumber: file.fileNumber, toStage: to.code },
        });
      }
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_STAGE_CHANGED', entityType: 'ClearanceFile',
      entityId: fileId, before: { stage: from.code }, after: { stage: to.code, reason: input.reason ?? null }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.files.get(fileId);
  }

  // ───────────────────────────── close / reopen ─────────────────────────────

  /** Operational and (basic) financial pre-close checks; used by `close()` and exposed to the UI. */
  async closureCheck(fileId: string) {
    const file = await this.loadFile(fileId);
    const blockers: Blocker[] = [];
    const warnings: Blocker[] = [];

    if (file.status !== 'OPEN') {
      blockers.push({ code: 'FILE_NOT_ACTIVE', message: `The file is ${file.status.toLowerCase()}` });
      return { canClose: false, blockers, warnings };
    }
    if (!file.currentStage?.isTerminal) {
      blockers.push({ code: 'NOT_AT_TERMINAL_STAGE', message: 'Move the file to its final stage before closing it' });
    } else {
      const missing = await this.requirements.missingBefore(fileId, file.currentStage);
      if (missing.length) blockers.push(this.missingDocs(missing));
    }
    const openTasks = await this.openTasks(fileId);
    if (openTasks.length) blockers.push({ code: 'OPEN_TASKS_REMAIN', message: `${openTasks.length} task(s) are still open`, details: openTasks });

    const invoices = await this.db.client.invoice.findMany({ where: { clearanceFileId: fileId, status: { in: ['DRAFT', 'ISSUED'] } } });
    const drafts = invoices.filter((i) => i.status === 'DRAFT');
    if (drafts.length) {
      blockers.push({ code: 'DRAFT_INVOICES_EXIST', message: 'Issue or cancel the draft invoices first', details: drafts.map((d) => ({ invoiceNumber: d.invoiceNumber })) });
    }
    // An advance invoice is a request for funds, not a receivable, so it never counts as outstanding.
    const issued = invoices.filter((i) => i.status === 'ISSUED' && i.invoiceType !== 'ADVANCE');
    if (issued.length) {
      const allocations = await this.db.client.paymentAllocation.findMany({
        where: { invoiceId: { in: issued.map((i) => i.id) }, reversedAt: null, payment: { status: 'POSTED' } },
      });
      const unpaid = issued.map((i) => {
        const paid = sum(allocations.filter((a) => a.invoiceId === i.id).map((a) => a.allocatedAmount));
        return { invoiceNumber: i.invoiceNumber, currency: i.currencyCode, total: i.totalAmount, paid, outstanding: sub(i.totalAmount, paid) };
      }).filter((r) => Number(r.outstanding) > 0);
      if (unpaid.length) {
        warnings.push({ code: 'OUTSTANDING_BALANCE', message: 'Some issued invoices are not fully paid', details: unpaid });
      }
    }
    return { canClose: blockers.length === 0, blockers, warnings };
  }

  async close(auth: AuthContext, fileId: string, input: z.infer<typeof closeSchema>, meta: RequestMeta) {
    const check = await this.closureCheck(fileId);
    if (check.blockers.length) throw this.blockedError(check.blockers);
    if (check.warnings.length && !input.acknowledgeOutstanding) {
      throw new DomainError('OUTSTANDING_BALANCE',
        'Issued invoices are not fully paid. Send acknowledgeOutstanding: true to close the file anyway.', 409, check.warnings);
    }
    const file = await this.loadFile(fileId);
    await this.db.client.$transaction(async (tx) => {
      const claimed = await tx.clearanceFile.updateMany({ where: { id: fileId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The file was changed by someone else; reload and try again');
      await this.activity.log(fileId, auth.userId, 'FILE_CLOSED',
        `File closed${input.note ? ` — ${input.note}` : ''}${check.warnings.length ? ' (with an outstanding balance acknowledged)' : ''}`,
        { note: input.note ?? null, acknowledgedOutstanding: check.warnings.length > 0 }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_CLOSED', entityType: 'ClearanceFile',
      entityId: fileId, before: { status: 'OPEN' }, after: { status: 'CLOSED', note: input.note ?? null, outstanding: check.warnings.flatMap((w) => w.details as unknown[]) },
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.files.get(file.id);
  }

  /** Reopening goes back to the stage the file came from, and always needs a reason. */
  async reopen(auth: AuthContext, fileId: string, reason: string, meta: RequestMeta) {
    const file = await this.loadFile(fileId);
    if (file.status !== 'CLOSED') {
      throw conflict('FILE_NOT_CLOSED', file.status === 'CANCELLED' ? 'A cancelled file cannot be reopened' : 'Only a closed file can be reopened');
    }
    const terminal = file.currentStage;
    let target = null as null | { id: string; code: string; nameEn: string };
    const lastEntry = await this.db.client.fileStatusHistory.findFirst({
      where: { clearanceFileId: fileId, toStageId: terminal?.id, fromStageId: { not: null } }, orderBy: { changedAt: 'desc' },
    });
    if (lastEntry?.fromStageId) {
      target = await this.db.client.workflowStage.findUnique({ where: { id: lastEntry.fromStageId }, select: { id: true, code: true, nameEn: true } });
    }
    if (!target && terminal && file.workflowTemplateId) {
      target = await this.db.client.workflowStage.findFirst({
        where: { workflowTemplateId: file.workflowTemplateId, sequence: { lt: terminal.sequence } },
        orderBy: { sequence: 'desc' }, select: { id: true, code: true, nameEn: true },
      });
    }

    await this.db.client.$transaction(async (tx) => {
      const claimed = await tx.clearanceFile.updateMany({
        where: { id: fileId, status: 'CLOSED' },
        data: { status: 'OPEN', closedAt: null, ...(target ? { currentStageId: target.id } : {}) },
      });
      if (claimed.count !== 1) throw conflict('CONCURRENT_MODIFICATION', 'The file was changed by someone else; reload and try again');
      if (target && terminal) {
        await tx.fileStatusHistory.create({
          data: { clearanceFileId: fileId, fromStageId: terminal.id, toStageId: target.id, changedBy: auth.userId, reason: `Reopened: ${reason}` } as any,
        });
      }
      await this.activity.log(fileId, auth.userId, 'FILE_REOPENED',
        `File reopened${target ? ` (back to ${target.nameEn})` : ''} — ${reason}`, { reason, toStage: target?.code ?? null }, tx);
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLEARANCE_FILE_REOPENED', entityType: 'ClearanceFile',
      entityId: fileId, before: { status: 'CLOSED' }, after: { status: 'OPEN', reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.files.get(fileId);
  }

  // ───────────────────────────── stage history ─────────────────────────────

  async history(fileId: string) {
    await this.files.require(fileId);
    const rows = await this.db.client.fileStatusHistory.findMany({
      where: { clearanceFileId: fileId }, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      include: { fromStage: { select: stageSelect }, toStage: { select: stageSelect } },
    });
    const members = await this.db.client.tenantUser.findMany({
      where: { userId: { in: [...new Set(rows.map((r) => r.changedBy))] } }, select: { userId: true, user: { select: userSelect } },
    });
    const names = new Map(members.map((m) => [m.userId, m.user] as const));
    return rows.map((r) => ({
      id: r.id, fromStage: r.fromStage, toStage: r.toStage, reason: r.reason, changedAt: r.changedAt,
      changedBy: names.get(r.changedBy) ?? null,
    }));
  }

  // ───────────────────────────── rule evaluation ─────────────────────────────

  private async blockers(auth: AuthContext, file: Awaited<ReturnType<TransitionsService['loadFile']>>, t: Awaited<ReturnType<TransitionsService['outgoing']>>[number]): Promise<Blocker[]> {
    const out: Blocker[] = [];
    if (file.status !== 'OPEN') {
      out.push({ code: 'FILE_NOT_ACTIVE', message: `The file is ${file.status.toLowerCase()} and cannot change stage` });
      return out;
    }
    const permission = t.requiredPermission ?? 'clearance_files.transition';
    if (!auth.permissions.has(permission)) {
      out.push({ code: 'PERMISSION_DENIED', message: 'You do not have permission to make this change', details: { permission } });
    }
    if (t.requiresApproval && !auth.permissions.has('clearance_files.approve')) {
      out.push({ code: 'APPROVAL_REQUIRED', message: 'This change must be made or approved by a user with approval permission', details: { permission: 'clearance_files.approve' } });
    }
    if (t.requiresDocumentCheck) {
      const missing = await this.requirements.missingBefore(file.id, t.toStage);
      if (missing.length) out.push(this.missingDocs(missing));
    }
    if (t.requiredTaskCheck) {
      const open = await this.openTasks(file.id);
      if (open.length) out.push({ code: 'OPEN_TASKS_REMAIN', message: `${open.length} task(s) must be completed first`, details: open });
    }
    return out;
  }

  private missingDocs(missing: Awaited<ReturnType<RequirementsService['missingBefore']>>): Blocker {
    return {
      code: 'REQUIRED_DOCUMENTS_MISSING', message: `${missing.length} required document(s) are missing`,
      details: missing.map((m) => ({ documentTypeId: m.documentType.id, code: m.documentType.code, nameEn: m.documentType.nameEn, nameAr: m.documentType.nameAr, state: m.state })),
    };
  }

  private blockedError(blockers: Blocker[]): DomainError {
    const first = blockers[0];
    return new DomainError(first.code, first.message, BLOCKER_STATUS[first.code] ?? 422, blockers);
  }

  private async openTasks(fileId: string) {
    return this.db.client.task.findMany({
      where: { clearanceFileId: fileId, status: { in: [...OPEN_TASK] } }, select: { id: true, title: true, dueAt: true }, orderBy: { createdAt: 'asc' },
    });
  }

  private async outgoing(file: { workflowTemplateId: string | null; currentStageId: string | null }) {
    return this.db.client.workflowTransition.findMany({
      where: { workflowTemplateId: file.workflowTemplateId!, fromStageId: file.currentStageId! },
      include: { toStage: { select: stageSelect } },
      orderBy: { toStage: { sequence: 'asc' } },
    });
  }

  private async loadFile(fileId: string) {
    const f = await this.db.client.clearanceFile.findUnique({ where: { id: fileId }, include: { currentStage: { select: stageSelect } } });
    if (!f) throw notFound('CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    return f;
  }
}
