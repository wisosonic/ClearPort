import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../common/errors';
import { ZodPipe } from '../../common/zod.pipe';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { Authenticated, CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';

const createBranchSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]+$/).min(1).max(20),
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
});
const updateBranchSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable(),
  phone: z.string().trim().max(50).nullable(),
  isActive: z.boolean(),
}).partial().strict();

const uuid = z.string().uuid();

@Controller('branches')
export class BranchesController {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Authenticated()
  @Get()
  list() {
    return this.db.client.branch.findMany({ orderBy: { code: 'asc' } });
  }

  @RequirePermissions('settings.manage')
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createBranchSchema)) body: z.infer<typeof createBranchSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const branch = await this.db.client.branch.create({ data: body as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'BRANCH_CREATED', entityType: 'Branch',
      entityId: branch.id, after: branch, ip: meta.ip, userAgent: meta.userAgent,
    });
    return branch;
  }

  @RequirePermissions('settings.manage')
  @Patch(':id')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(updateBranchSchema)) body: z.infer<typeof updateBranchSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const before = await this.db.client.branch.findUnique({ where: { id } });
    if (!before) throw notFound('BRANCH_NOT_FOUND', 'Branch not found');
    const after = await this.db.client.branch.update({ where: { id }, data: body });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'BRANCH_UPDATED', entityType: 'Branch',
      entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }
}
