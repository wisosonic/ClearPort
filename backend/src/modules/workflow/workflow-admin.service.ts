import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import type {
  createStageSchema, createTemplateSchema, createTransitionSchema, updateStageSchema,
  updateTemplateSchema, updateTransitionSchema,
} from './workflow.schemas';

const stageSelect = { id: true, code: true, nameEn: true, nameAr: true, sequence: true, isTerminal: true } as const;

/**
 * Configuration of workflow templates, stages and transitions (spec 5.2). Offices configure their
 * own; nothing here hardcodes a customs procedure. One ACTIVE template per file type is used for
 * new files; files already in flight keep the template they were created with.
 */
@Injectable()
export class WorkflowAdminService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(fileType?: string) {
    const templates = await this.db.client.workflowTemplate.findMany({
      where: fileType ? { fileType: fileType as any } : {},
      orderBy: [{ fileType: 'asc' }, { createdAt: 'asc' }],
      include: { stages: { orderBy: { sequence: 'asc' }, select: stageSelect } },
    });
    const transitions = await this.db.client.workflowTransition.findMany({
      where: { workflowTemplateId: { in: templates.map((t) => t.id) } },
    });
    return templates.map((t) => ({ ...t, transitions: transitions.filter((x) => x.workflowTemplateId === t.id) }));
  }

  async get(id: string) {
    const t = await this.db.client.workflowTemplate.findUnique({
      where: { id }, include: { stages: { orderBy: { sequence: 'asc' }, select: stageSelect } },
    });
    if (!t) throw notFound('WORKFLOW_TEMPLATE_NOT_FOUND', 'Workflow template not found');
    const transitions = await this.db.client.workflowTransition.findMany({ where: { workflowTemplateId: id } });
    return { ...t, transitions };
  }

  async createTemplate(auth: AuthContext, input: z.infer<typeof createTemplateSchema>, meta: RequestMeta) {
    // New templates start inactive so a half-built workflow can never be picked up by new files.
    const t = await this.db.client.workflowTemplate.create({ data: { ...input, isActive: false } as any });
    await this.record(auth, meta, 'WORKFLOW_TEMPLATE_CREATED', 'WorkflowTemplate', t.id, undefined, t);
    return this.get(t.id);
  }

  async updateTemplate(auth: AuthContext, id: string, input: z.infer<typeof updateTemplateSchema>, meta: RequestMeta) {
    const before = await this.get(id);
    if (input.isActive === true && !before.isActive) {
      if (before.stages.length === 0) throw unprocessable('TEMPLATE_HAS_NO_STAGES', 'Add at least one stage before activating the template');
      if (!before.stages.some((s) => !s.isTerminal)) throw unprocessable('TEMPLATE_HAS_NO_START_STAGE', 'The template needs a non-terminal first stage');
    }
    await this.db.client.$transaction(async (tx) => {
      if (input.isActive === true) {
        await tx.workflowTemplate.updateMany({ where: { fileType: before.fileType, id: { not: id } }, data: { isActive: false } });
      }
      await tx.workflowTemplate.update({ where: { id }, data: input as any });
    });
    const after = await this.get(id);
    await this.record(auth, meta, 'WORKFLOW_TEMPLATE_UPDATED', 'WorkflowTemplate', id, input, after);
    return after;
  }

  async addStage(auth: AuthContext, templateId: string, input: z.infer<typeof createStageSchema>, meta: RequestMeta) {
    const template = await this.get(templateId);
    if (template.stages.some((s) => s.code === input.code)) throw conflict('STAGE_CODE_TAKEN', `Stage code ${input.code} already exists in this template`);
    const sequence = input.sequence ?? Math.max(0, ...template.stages.map((s) => s.sequence)) + 1;
    if (template.stages.some((s) => s.sequence === sequence)) throw conflict('STAGE_SEQUENCE_TAKEN', `Sequence ${sequence} is already used`);
    const stage = await this.db.client.workflowStage.create({
      data: { workflowTemplateId: templateId, code: input.code, nameEn: input.nameEn, nameAr: input.nameAr, sequence, isTerminal: input.isTerminal } as any,
    });
    await this.record(auth, meta, 'WORKFLOW_STAGE_CREATED', 'WorkflowStage', stage.id, undefined, stage);
    return stage;
  }

  async updateStage(auth: AuthContext, stageId: string, input: z.infer<typeof updateStageSchema>, meta: RequestMeta) {
    const before = await this.db.client.workflowStage.findUnique({ where: { id: stageId } });
    if (!before) throw notFound('WORKFLOW_STAGE_NOT_FOUND', 'Workflow stage not found');
    if (input.isTerminal === true && !before.isTerminal) {
      const outgoing = await this.db.client.workflowTransition.count({ where: { fromStageId: stageId } });
      if (outgoing > 0) throw conflict('STAGE_HAS_TRANSITIONS', 'Remove this stage\'s outgoing transitions before making it terminal');
    }
    const after = await this.db.client.workflowStage.update({ where: { id: stageId }, data: input as any });
    await this.record(auth, meta, 'WORKFLOW_STAGE_UPDATED', 'WorkflowStage', stageId, before, after);
    return after;
  }

  async addTransition(auth: AuthContext, templateId: string, input: z.infer<typeof createTransitionSchema>, meta: RequestMeta) {
    const template = await this.get(templateId);
    const from = template.stages.find((s) => s.id === input.fromStageId);
    const to = template.stages.find((s) => s.id === input.toStageId);
    if (!from || !to) throw unprocessable('STAGE_NOT_IN_TEMPLATE', 'Both stages must belong to this template');
    if (from.id === to.id) throw unprocessable('TRANSITION_TO_SELF', 'A transition must lead to a different stage');
    if (from.isTerminal) throw unprocessable('TRANSITION_FROM_TERMINAL', 'A terminal stage cannot have outgoing transitions (use reopen)');
    if (template.transitions.some((t) => t.fromStageId === from.id && t.toStageId === to.id)) {
      throw conflict('TRANSITION_EXISTS', 'This transition already exists');
    }
    await this.assertPermissionCode(input.requiredPermission ?? null);
    const t = await this.db.client.workflowTransition.create({ data: { ...input, workflowTemplateId: templateId } as any });
    await this.record(auth, meta, 'WORKFLOW_TRANSITION_CREATED', 'WorkflowTransition', t.id, undefined, t);
    return t;
  }

  async updateTransition(auth: AuthContext, transitionId: string, input: z.infer<typeof updateTransitionSchema>, meta: RequestMeta) {
    const before = await this.db.client.workflowTransition.findUnique({ where: { id: transitionId } });
    if (!before) throw notFound('WORKFLOW_TRANSITION_NOT_FOUND', 'Workflow transition not found');
    await this.assertPermissionCode(input.requiredPermission ?? null);
    const after = await this.db.client.workflowTransition.update({ where: { id: transitionId }, data: input as any });
    await this.record(auth, meta, 'WORKFLOW_TRANSITION_UPDATED', 'WorkflowTransition', transitionId, before, after);
    return after;
  }

  async removeTransition(auth: AuthContext, transitionId: string, meta: RequestMeta) {
    const before = await this.db.client.workflowTransition.findUnique({ where: { id: transitionId } });
    if (!before) throw notFound('WORKFLOW_TRANSITION_NOT_FOUND', 'Workflow transition not found');
    await this.db.client.workflowTransition.delete({ where: { id: transitionId } });
    await this.record(auth, meta, 'WORKFLOW_TRANSITION_DELETED', 'WorkflowTransition', transitionId, before, undefined);
  }

  /** A required permission must be a real permission code, otherwise nobody could ever use the transition. */
  private async assertPermissionCode(code: string | null) {
    if (code && !(await this.prisma.client.permission.findUnique({ where: { code } }))) {
      throw unprocessable('UNKNOWN_PERMISSION', `Unknown permission code ${code}`);
    }
  }

  private record(auth: AuthContext, meta: RequestMeta, action: string, entityType: string, entityId: string, before: unknown, after: unknown) {
    return this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action, entityType, entityId, before, after,
      ip: meta.ip, userAgent: meta.userAgent,
    });
  }
}
