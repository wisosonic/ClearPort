import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { z } from 'zod';
import { timeZone } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { Authenticated, CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';

const officeSelect = {
  id: true, name: true, slug: true, legalName: true, email: true, phone: true, address: true,
  defaultCurrency: true, timezone: true, locale: true, allowSelfApproval: true, status: true,
} as const;

// defaultCurrency (the base currency) is intentionally not editable: changing it would
// silently re-interpret every stored base_amount.
const updateOfficeSchema = z.object({
  name: z.string().trim().min(2).max(200),
  legalName: z.string().trim().max(200).nullable(),
  email: z.string().trim().email().max(150).nullable(),
  phone: z.string().trim().max(50).nullable(),
  address: z.string().trim().max(500).nullable(),
  timezone: timeZone,
  locale: z.enum(['en', 'ar']),
  /** Off = whoever records an expense cannot also approve it. */
  allowSelfApproval: z.boolean(),
}).partial().strict();

@Controller('tenant')
export class TenantsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** The caller's own office. The tenant comes from the verified session, never from the URL. */
  @Authenticated()
  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.prisma.client.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: officeSelect });
  }

  @RequirePermissions('settings.manage')
  @Patch()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(updateOfficeSchema)) body: z.infer<typeof updateOfficeSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const before = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: officeSelect });
    const after = await this.prisma.client.tenant.update({ where: { id: auth.tenantId }, data: body, select: officeSelect });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TENANT_UPDATED', entityType: 'Tenant',
      entityId: auth.tenantId, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }
}
