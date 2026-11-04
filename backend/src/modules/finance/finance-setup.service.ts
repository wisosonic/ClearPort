import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound } from '../../common/errors';
import { decimalString } from '../../common/zod-helpers';
import { TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import type { createCategorySchema, taxSettingsSchema, updateCategorySchema } from './finance.schemas';

const TAX_KEY = 'finance.tax';
export interface TaxSettings { enabled: boolean; name: string; ratePercent: string }
const DISABLED: TaxSettings = { enabled: false, name: 'VAT', ratePercent: '0.0000' };

/** Financial categories and the office's tax setting (spec 6.2 / 6.4). */
@Injectable()
export class FinanceSetupService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── tax: configured per office, never hardcoded (spec section 4) ──

  async getTax(): Promise<TaxSettings> {
    const { tenantId } = requireTenant();
    const row = await this.db.client.systemSetting.findFirst({ where: { tenantId, key: TAX_KEY } });
    return row ? (row.value as unknown as TaxSettings) : DISABLED;
  }

  /** The percentage to apply to NEW invoices, or null when tax is off. */
  async activeRate(): Promise<string | null> {
    const t = await this.getTax();
    return t.enabled && Number(t.ratePercent) > 0 ? t.ratePercent : null;
  }

  async putTax(auth: AuthContext, input: z.infer<typeof taxSettingsSchema>, meta: RequestMeta): Promise<TaxSettings> {
    const before = await this.getTax();
    const value: TaxSettings = { enabled: input.enabled, name: input.name, ratePercent: decimalString(4).parse(input.ratePercent) };
    await this.db.client.systemSetting.upsert({
      where: { tenantId_key: { tenantId: auth.tenantId, key: TAX_KEY } },
      create: { key: TAX_KEY, value: value as any } as any,
      update: { value: value as any },
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TAX_SETTINGS_CHANGED', entityType: 'SystemSetting', entityId: TAX_KEY,
      before, after: value, ip: meta.ip, userAgent: meta.userAgent,
    });
    return value;
  }

  // ── categories ──

  categories(includeInactive = false) {
    return this.db.client.financialCategory.findMany({ where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' } });
  }

  async createCategory(auth: AuthContext, input: z.infer<typeof createCategorySchema>, meta: RequestMeta) {
    if (await this.db.client.financialCategory.findFirst({ where: { name: input.name } })) {
      throw conflict('CATEGORY_NAME_TAKEN', 'A category with this name already exists');
    }
    const row = await this.db.client.financialCategory.create({ data: input as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'FINANCIAL_CATEGORY_CREATED', entityType: 'FinancialCategory', entityId: row.id,
      after: row, ip: meta.ip, userAgent: meta.userAgent,
    });
    return row;
  }

  async updateCategory(auth: AuthContext, id: string, input: z.infer<typeof updateCategorySchema>, meta: RequestMeta) {
    const before = await this.db.client.financialCategory.findUnique({ where: { id } });
    if (!before) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
    if (input.name && input.name !== before.name && (await this.db.client.financialCategory.findFirst({ where: { name: input.name } }))) {
      throw conflict('CATEGORY_NAME_TAKEN', 'A category with this name already exists');
    }
    const after = await this.db.client.financialCategory.update({ where: { id }, data: input });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'FINANCIAL_CATEGORY_UPDATED', entityType: 'FinancialCategory', entityId: id,
      before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }
}
