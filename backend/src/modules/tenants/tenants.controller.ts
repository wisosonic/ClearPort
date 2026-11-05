import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { z } from 'zod';
import { unprocessable } from '../../common/errors';
import { currencyCode, timeZone } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { Authenticated, CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';

const officeSelect = {
  id: true, name: true, slug: true, legalName: true, email: true, phone: true, address: true,
  defaultCurrency: true, timezone: true, locale: true, allowSelfApproval: true, notifyInApp: true, notifyEmail: true, notifySms: true, status: true,
} as const;

// The main (base) currency can be changed only while nothing has been booked in it: changing it later would
// silently re-interpret every stored base_amount. `currencyBlockers` says what is in the way.
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
  /** Notification channels. In-app is delivered; email and SMS record the choice (no delivery service is connected yet). */
  notifyInApp: z.boolean(),
  notifyEmail: z.boolean(),
  notifySms: z.boolean(),
  /** The main (base) currency. Only while the office has no financial records; see `blockers` in GET /tenant/currency. */
  defaultCurrency: currencyCode,
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

  /** Whether the main currency can still be changed, and if not, what has been recorded that prevents it. */
  @RequirePermissions('settings.manage')
  @Get('currency-change')
  async currencyChange(@CurrentAuth() auth: AuthContext) {
    const blockers = await this.currencyBlockers(auth.tenantId);
    return { canChange: blockers.length === 0, blockers };
  }

  private async currencyBlockers(tenantId: string): Promise<string[]> {
    const c = this.prisma.client;
    const [entries, invoices, payments, expenses, rates] = await Promise.all([
      c.journalEntry.count({ where: { tenantId } }), c.invoice.count({ where: { tenantId } }), c.payment.count({ where: { tenantId } }),
      c.expense.count({ where: { tenantId } }), c.exchangeRate.count({ where: { tenantId } }),
    ]);
    return [
      entries && 'JOURNAL_ENTRIES', invoices && 'INVOICES', payments && 'PAYMENTS', expenses && 'EXPENSES', rates && 'EXCHANGE_RATES',
    ].filter((x): x is string => !!x);
  }

  @RequirePermissions('settings.manage')
  @Patch()
  async update(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(updateOfficeSchema)) body: z.infer<typeof updateOfficeSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const before = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: officeSelect });
    if (body.defaultCurrency !== undefined && body.defaultCurrency !== before.defaultCurrency) {
      const blockers = await this.currencyBlockers(auth.tenantId);
      if (blockers.length) {
        throw unprocessable('BASE_CURRENCY_IN_USE', 'The main currency cannot be changed once invoices, payments, expenses, journal entries or exchange rates exist, because every stored amount is valued in it', blockers.map((b) => ({ blocker: b })));
      }
      const currency = await this.prisma.client.currency.findUnique({ where: { code: body.defaultCurrency } });
      if (!currency || !currency.isActive) throw unprocessable('CURRENCY_NOT_FOUND', `Unknown or inactive currency ${body.defaultCurrency}`);
    }
    const after = await this.prisma.client.tenant.update({ where: { id: auth.tenantId }, data: body, select: officeSelect });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TENANT_UPDATED', entityType: 'Tenant',
      entityId: auth.tenantId, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }
}
