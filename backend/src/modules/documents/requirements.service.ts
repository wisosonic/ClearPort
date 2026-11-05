import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { requirementConditionsSchema, type RequirementConditions, type createRequirementSchema, type updateRequirementSchema } from './documents.schemas';

/** Does a requirement with these conditions apply to this file? Conditions that cannot be read are treated as applying (asking for a document is the safe side). */
export function conditionsApply(
  raw: unknown,
  file: { priority: string; clientType: string | null; shipments: { shipmentType: string; containerCount: number }[] },
): boolean {
  if (raw === null || raw === undefined) return true;
  const parsed = requirementConditionsSchema.safeParse(raw);
  if (!parsed.success) return true;
  const c: RequirementConditions = parsed.data;
  if (c.shipmentType && !file.shipments.some((s) => (c.shipmentType as string[]).includes(s.shipmentType))) return false;
  if (c.hasContainers !== undefined && (file.shipments.some((s) => s.containerCount > 0)) !== c.hasContainers) return false;
  if (c.priority && !(c.priority as string[]).includes(file.priority)) return false;
  if (c.clientType && file.clientType !== c.clientType) return false;
  return true;
}

const typeSelect = { id: true, code: true, nameEn: true, nameAr: true } as const;
const stageSelect = { id: true, code: true, nameEn: true, nameAr: true, isTerminal: true } as const;

export interface ChecklistItem {
  requirementId: string;
  documentType: { id: string; code: string; nameEn: string; nameAr: string };
  isRequired: boolean;
  requiredBeforeStage: { id: string; code: string; nameEn: string; nameAr: string; isTerminal: boolean } | null;
  appliesTo: string | null;
  conditions: unknown;
  /** MISSING | UPLOADED | APPROVED | REJECTED_ONLY (documents exist but all were rejected) */
  state: 'MISSING' | 'UPLOADED' | 'APPROVED' | 'REJECTED_ONLY';
  satisfied: boolean;
  documentIds: string[];
}

/**
 * Required-document checklists (spec 11.4 / 5.2). Configurable per clearance type and stage, optionally
 * only for some files (see `conditionsApply`); no document list is hardcoded. A requirement is SATISFIED when the file holds at least one
 * non-void, non-rejected document of that type (review/approval is a separate, optional step).
 */
@Injectable()
export class RequirementsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── per-file checklist ──

  async checklist(fileId: string): Promise<ChecklistItem[]> {
    const file = await this.db.client.clearanceFile.findUnique({
      where: { id: fileId },
      select: { fileType: true, priority: true, client: { select: { clientType: true } }, shipments: { select: { shipmentType: true, _count: { select: { containers: true } } } } },
    });
    if (!file) throw notFound('CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    const facts = { priority: file.priority, clientType: file.client?.clientType ?? null, shipments: file.shipments.map((s) => ({ shipmentType: s.shipmentType, containerCount: s._count.containers })) };
    const [reqs, docs] = await Promise.all([
      this.db.client.documentRequirement.findMany({
        where: { fileType: file.fileType },
        include: { documentType: { select: typeSelect }, requiredBefore: { select: stageSelect } },
        orderBy: [{ isRequired: 'desc' }, { id: 'asc' }],
      }),
      this.db.client.document.findMany({
        where: { clearanceFileId: fileId, deletedAt: null },
        select: { id: true, documentTypeId: true, status: true },
      }),
    ]);
    return reqs.filter((r) => conditionsApply(r.conditions, facts)).map((r) => {
      const matching = docs.filter((d) => d.documentTypeId === r.documentTypeId);
      const usable = matching.filter((d) => d.status !== 'REJECTED' && d.status !== 'VOID');
      const state: ChecklistItem['state'] =
        usable.length === 0 ? (matching.length > 0 ? 'REJECTED_ONLY' : 'MISSING')
          : usable.some((d) => d.status === 'APPROVED') ? 'APPROVED' : 'UPLOADED';
      return {
        requirementId: r.id, documentType: r.documentType, isRequired: r.isRequired,
        requiredBeforeStage: r.requiredBefore, appliesTo: r.appliesTo, conditions: r.conditions,
        state, satisfied: usable.length > 0, documentIds: matching.map((d) => d.id),
      };
    });
  }

  /**
   * Required documents still missing before the file may ENTER `target`. A requirement gates the
   * stage it names; a required document with no stage gates the terminal (closing) stage.
   */
  async missingBefore(fileId: string, target: { id: string; isTerminal: boolean }): Promise<ChecklistItem[]> {
    return (await this.checklist(fileId)).filter(
      (c) => c.isRequired && !c.satisfied &&
        (c.requiredBeforeStage ? c.requiredBeforeStage.id === target.id : target.isTerminal),
    );
  }

  // ── configuration (administrators) ──

  async list(fileType?: string) {
    return this.db.client.documentRequirement.findMany({
      where: fileType ? { fileType: fileType as any } : {},
      include: { documentType: { select: typeSelect }, requiredBefore: { select: stageSelect } },
      orderBy: [{ fileType: 'asc' }, { id: 'asc' }],
    });
  }

  async create(auth: AuthContext, input: z.infer<typeof createRequirementSchema>, meta: RequestMeta) {
    await this.assertRefs(input.fileType, input.documentTypeId, input.isRequiredBeforeStageId ?? null);
    const dup = await this.db.client.documentRequirement.findFirst({
      where: { fileType: input.fileType, documentTypeId: input.documentTypeId, isRequiredBeforeStageId: input.isRequiredBeforeStageId ?? null },
    });
    if (dup) throw conflict('REQUIREMENT_EXISTS', 'This requirement already exists');
    const row = await this.db.client.documentRequirement.create({ data: { ...input, conditions: input.conditions as any } as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_REQUIREMENT_CREATED',
      entityType: 'DocumentRequirement', entityId: row.id, after: row, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(row.id);
  }

  async update(auth: AuthContext, id: string, input: z.infer<typeof updateRequirementSchema>, meta: RequestMeta) {
    const before = await this.get(id);
    if (input.isRequiredBeforeStageId) await this.assertRefs(before.fileType, before.documentTypeId, input.isRequiredBeforeStageId);
    await this.db.client.documentRequirement.update({ where: { id }, data: input as any });
    const after = await this.get(id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_REQUIREMENT_UPDATED',
      entityType: 'DocumentRequirement', entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  async remove(auth: AuthContext, id: string, meta: RequestMeta) {
    const before = await this.get(id);
    await this.db.client.documentRequirement.delete({ where: { id } });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_REQUIREMENT_DELETED',
      entityType: 'DocumentRequirement', entityId: id, before, ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  private async get(id: string) {
    const r = await this.db.client.documentRequirement.findUnique({
      where: { id }, include: { documentType: { select: typeSelect }, requiredBefore: { select: stageSelect } },
    });
    if (!r) throw notFound('REQUIREMENT_NOT_FOUND', 'Document requirement not found');
    return r;
  }

  private async assertRefs(fileType: string, documentTypeId: string, stageId: string | null) {
    const type = await this.db.client.documentType.findUnique({ where: { id: documentTypeId } });
    if (!type || !type.isActive) throw unprocessable('DOCUMENT_TYPE_NOT_FOUND', 'Document type not found');
    if (stageId) {
      const stage = await this.db.client.workflowStage.findUnique({ where: { id: stageId }, include: { template: { select: { fileType: true } } } });
      if (!stage) throw unprocessable('STAGE_NOT_FOUND', 'Workflow stage not found');
      if (stage.template.fileType !== fileType) {
        throw unprocessable('STAGE_FILE_TYPE_MISMATCH', `That stage belongs to a ${stage.template.fileType} workflow, not ${fileType}`);
      }
    }
  }
}
