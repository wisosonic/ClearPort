import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound } from '../../common/errors';
import { timeZone } from '../../common/zod-helpers';
import type { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '../../database/prisma.module';
import { provisionTenantDefaults } from '../../seed/tenant-defaults';
import { AuditService } from '../audit/audit.service';
import { hashPassword, passwordSchema } from '../auth/auth.service';

export const provisionTenantSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens only').min(2).max(100),
  legalName: z.string().trim().max(200).optional(),
  defaultCurrency: z.string().length(3).toUpperCase().default('USD'),
  timezone: timeZone.default('Asia/Beirut'),
  locale: z.enum(['en', 'ar']).default('en'),
  ownerEmail: z.string().trim().toLowerCase().email().max(150),
  ownerFirstName: z.string().trim().min(1).max(100),
  ownerLastName: z.string().trim().min(1).max(100),
  /** Required only when the owner e-mail is not already a ClearPort user. */
  ownerPassword: passwordSchema.optional(),
});
export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;

/**
 * Creates a customs office (tenant) with its defaults and an Owner. This is a platform-level
 * operation (run from the CLI by the operator), not an office-level API — the spec defines no
 * self-registration endpoint.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createTenant(input: ProvisionTenantInput) {
    const db = this.prisma.client;
    if (await db.tenant.findUnique({ where: { slug: input.slug } })) {
      throw conflict('TENANT_SLUG_TAKEN', `An office with slug "${input.slug}" already exists`);
    }
    const currency = await db.currency.findUnique({ where: { code: input.defaultCurrency } });
    if (!currency) throw notFound('CURRENCY_NOT_FOUND', `Unknown currency ${input.defaultCurrency}; run the seed first`);
    const ownerRole = await db.role.findFirst({ where: { tenantId: null, code: 'OWNER' } });
    if (!ownerRole) throw notFound('ROLE_NOT_FOUND', 'System roles are missing; run the seed first');

    const existing = await db.user.findUnique({ where: { email: input.ownerEmail } });
    if (!existing && !input.ownerPassword) {
      throw conflict('OWNER_PASSWORD_REQUIRED', 'ownerPassword is required for a new user');
    }
    const passwordHash = existing ? undefined : await hashPassword(input.ownerPassword!);

    const result = await db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: input.name, slug: input.slug, legalName: input.legalName,
          defaultCurrency: input.defaultCurrency, timezone: input.timezone, locale: input.locale,
        },
      });
      await provisionTenantDefaults(tx as unknown as PrismaClient, tenant.id);
      const branch = await tx.branch.create({ data: { tenantId: tenant.id, code: 'MAIN', name: 'Main office' } });
      const user =
        existing ??
        (await tx.user.create({
          data: {
            email: input.ownerEmail, passwordHash: passwordHash!,
            firstName: input.ownerFirstName, lastName: input.ownerLastName,
          },
        }));
      await tx.tenantUser.create({ data: { tenantId: tenant.id, userId: user.id, branchId: branch.id } });
      await tx.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: ownerRole.id } });
      return { tenant, user };
    });

    await this.audit.record({
      tenantId: result.tenant.id, actorUserId: result.user.id, action: 'TENANT_PROVISIONED',
      entityType: 'Tenant', entityId: result.tenant.id, after: { slug: input.slug, name: input.name },
    });
    return { tenantId: result.tenant.id, slug: result.tenant.slug, ownerUserId: result.user.id, ownerExisted: !!existing };
  }
}
