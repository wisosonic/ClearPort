import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { TransitionsService } from './transitions.service';
import { WorkflowAdminService } from './workflow-admin.service';
import {
  closeSchema, createStageSchema, createTemplateSchema, createTransitionSchema, reopenSchema,
  templateListQuerySchema, transitionSchema, updateStageSchema, updateTemplateSchema, updateTransitionSchema,
} from './workflow.schemas';

const id = () => new ZodPipe(uuid);

/** Workflow configuration. Reading is open to anyone who can see files; editing needs workflows.manage. */
@Controller('workflow-templates')
export class WorkflowAdminController {
  constructor(@Inject(WorkflowAdminService) private readonly admin: WorkflowAdminService) {}

  @RequirePermissions('clearance_files.view')
  @Get()
  list(@Query(new ZodPipe(templateListQuerySchema)) q: z.infer<typeof templateListQuerySchema>) {
    return this.admin.list(q.fileType);
  }

  @RequirePermissions('clearance_files.view')
  @Get(':templateId')
  get(@Param('templateId', id()) templateId: string) {
    return this.admin.get(templateId);
  }

  @RequirePermissions('workflows.manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createTemplateSchema)) body: z.infer<typeof createTemplateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.admin.createTemplate(auth, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Patch(':templateId')
  update(
    @CurrentAuth() auth: AuthContext, @Param('templateId', id()) templateId: string,
    @Body(new ZodPipe(updateTemplateSchema)) body: z.infer<typeof updateTemplateSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.admin.updateTemplate(auth, templateId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Post(':templateId/stages')
  addStage(
    @CurrentAuth() auth: AuthContext, @Param('templateId', id()) templateId: string,
    @Body(new ZodPipe(createStageSchema)) body: z.infer<typeof createStageSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.admin.addStage(auth, templateId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Patch(':templateId/stages/:stageId')
  updateStage(
    @CurrentAuth() auth: AuthContext, @Param('stageId', id()) stageId: string,
    @Body(new ZodPipe(updateStageSchema)) body: z.infer<typeof updateStageSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.admin.updateStage(auth, stageId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Post(':templateId/transitions')
  addTransition(
    @CurrentAuth() auth: AuthContext, @Param('templateId', id()) templateId: string,
    @Body(new ZodPipe(createTransitionSchema)) body: z.infer<typeof createTransitionSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.admin.addTransition(auth, templateId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Patch(':templateId/transitions/:transitionId')
  updateTransition(
    @CurrentAuth() auth: AuthContext, @Param('transitionId', id()) transitionId: string,
    @Body(new ZodPipe(updateTransitionSchema)) body: z.infer<typeof updateTransitionSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.admin.updateTransition(auth, transitionId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @HttpCode(204)
  @Delete(':templateId/transitions/:transitionId')
  async removeTransition(@CurrentAuth() auth: AuthContext, @Param('transitionId', id()) transitionId: string, @ReqMeta() meta: RequestMeta) {
    await this.admin.removeTransition(auth, transitionId, meta);
  }
}

/** Moving files through their workflow. The service enforces the transition's own permission. */
@Controller('clearance-files/:fileId')
export class TransitionsController {
  constructor(@Inject(TransitionsService) private readonly transitions: TransitionsService) {}

  /** What this file can do next, and what blocks each option. */
  @RequirePermissions('clearance_files.view')
  @Get('transitions')
  available(@CurrentAuth() auth: AuthContext, @Param('fileId', id()) fileId: string) {
    return this.transitions.available(auth, fileId);
  }

  /** The ONLY way to change a file's stage (spec 14.3): rules, permissions, documents and tasks are enforced. */
  @RequirePermissions('clearance_files.view')
  @HttpCode(200)
  @Post('transition')
  transition(
    @CurrentAuth() auth: AuthContext, @Param('fileId', id()) fileId: string,
    @Body(new ZodPipe(transitionSchema)) body: z.infer<typeof transitionSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.transitions.transition(auth, fileId, body, meta);
  }

  @RequirePermissions('clearance_files.view')
  @Get('status-history')
  history(@Param('fileId', id()) fileId: string) {
    return this.transitions.history(fileId);
  }

  @RequirePermissions('clearance_files.view')
  @Get('closure-check')
  closureCheck(@Param('fileId', id()) fileId: string) {
    return this.transitions.closureCheck(fileId);
  }

  @RequirePermissions('clearance_files.close')
  @HttpCode(200)
  @Post('close')
  close(
    @CurrentAuth() auth: AuthContext, @Param('fileId', id()) fileId: string,
    @Body(new ZodPipe(closeSchema)) body: z.infer<typeof closeSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.transitions.close(auth, fileId, body, meta);
  }

  @RequirePermissions('clearance_files.close')
  @HttpCode(200)
  @Post('reopen')
  reopen(
    @CurrentAuth() auth: AuthContext, @Param('fileId', id()) fileId: string,
    @Body(new ZodPipe(reopenSchema)) body: z.infer<typeof reopenSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.transitions.reopen(auth, fileId, body.reason, meta);
  }
}
