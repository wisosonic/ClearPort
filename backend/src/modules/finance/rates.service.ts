import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { fromBase, rate as normaliseRate, toBase, type DecimalString } from '../../common/money';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import type { createRateSchema } from './finance.schemas';

export type RateConvention = 'BASE_PER_FOREIGN' | 'FOREIGN_PER_BASE';

/** The rate actually used by a transaction. It is copied onto the transaction and never edited. */
export interface ResolvedRate {
  rate: DecimalString; // 10 decimals
  convention: RateConvention;
  /** BASE | MANUAL_ENTRY | EXCHANGE_RATE_TABLE | free text recorded with the rate */
  source: string;
  currency: string;
  baseCurrency: string;
}

export interface RateOverride {
  exchangeRate?: string;
  rateConvention?: RateConvention;
  rateSource?: string | null;
}

/**
 * Exchange rates (spec 6.1). Rates are stored per FOREIGN currency against the office's BASE
 * currency, with an explicit convention:
 *
 *   BASE_PER_FOREIGN  rate = base units per 1 foreign unit   (e.g. EUR: 1 EUR = 1.0850 USD)
 *   FOREIGN_PER_BASE  rate = foreign units per 1 base unit   (e.g. LBP: 1 USD = 89,500 LBP)
 *
 * The convention matters: 1 LBP in USD is 0.0000111732..., which a 10-decimal rate would only
 * hold to 5 significant digits (an error of ~0.1 USD per 1,000 USD). Storing "89500" is exact.
 * Weak currencies (0 decimal places) default to FOREIGN_PER_BASE.
 */
@Injectable()
export class RatesService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async baseCurrency(tenantId: string): Promise<string> {
    const t = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { defaultCurrency: true } });
    return t.defaultCurrency;
  }

  /**
   * The rate to use for `currency` on `at`: an explicit override if given, 1 for the base currency,
   * otherwise the most recent rate effective on or before `at`.
   */
  async resolve(tenantId: string, currency: string, at: Date, override?: RateOverride): Promise<ResolvedRate> {
    const baseCurrency = await this.baseCurrency(tenantId);
    if (currency === baseCurrency) {
      if (override?.exchangeRate && Number(override.exchangeRate) !== 1) {
        throw unprocessable('BASE_CURRENCY_RATE_IS_ONE', `${currency} is the base currency; its exchange rate is always 1`);
      }
      return { rate: normaliseRate('1'), convention: 'BASE_PER_FOREIGN', source: 'BASE', currency, baseCurrency };
    }
    if (override?.exchangeRate) {
      return {
        rate: normaliseRate(override.exchangeRate), convention: override.rateConvention ?? (await this.defaultConvention(currency)),
        source: override.rateSource ?? 'MANUAL_ENTRY', currency, baseCurrency,
      };
    }
    const row = await this.db.client.exchangeRate.findFirst({
      where: { fromCurrency: currency, toCurrency: baseCurrency, effectiveAt: { lte: at } },
      orderBy: { effectiveAt: 'desc' },
    });
    if (!row) {
      throw unprocessable('EXCHANGE_RATE_REQUIRED',
        `No ${currency}→${baseCurrency} exchange rate is on file for ${at.toISOString().slice(0, 10)}. Record a rate, or enter one on the transaction.`,
        [{ currency, baseCurrency, date: at.toISOString().slice(0, 10) }]);
    }
    return { rate: row.rate, convention: row.convention as RateConvention, source: row.source ?? 'EXCHANGE_RATE_TABLE', currency, baseCurrency };
  }

  toBase(amount: DecimalString, r: Pick<ResolvedRate, 'rate' | 'convention'>): DecimalString {
    return toBase(amount, r.rate, r.convention);
  }

  fromBase(baseAmount: DecimalString, r: Pick<ResolvedRate, 'rate' | 'convention'>): DecimalString {
    return fromBase(baseAmount, r.rate, r.convention);
  }

  private async defaultConvention(currency: string): Promise<RateConvention> {
    const c = await this.db.client.currency.findUnique({ where: { code: currency } });
    return c && c.decimalPlaces === 0 ? 'FOREIGN_PER_BASE' : 'BASE_PER_FOREIGN';
  }

  /** Currency must exist and be active. */
  async assertCurrency(code: string) {
    const c = await this.db.client.currency.findUnique({ where: { code } });
    if (!c || !c.isActive) throw unprocessable('CURRENCY_NOT_FOUND', `Unknown or inactive currency ${code}`);
    return c;
  }

  // ───────────────────────────── queries and writes ─────────────────────────────

  currencies() {
    return this.db.client.currency.findMany({ where: { isActive: true }, orderBy: { code: 'asc' } });
  }

  async list(tenantId: string, currency?: string) {
    return this.db.client.exchangeRate.findMany({
      where: currency ? { fromCurrency: currency } : {}, orderBy: [{ fromCurrency: 'asc' }, { effectiveAt: 'desc' }], take: 500,
    });
  }

  /** Rates are append-only: a correction is a new row with a later effective time. */
  async create(auth: AuthContext, input: z.infer<typeof createRateSchema>, meta: RequestMeta) {
    const baseCurrency = await this.baseCurrency(auth.tenantId);
    if (input.currency === baseCurrency) throw unprocessable('BASE_CURRENCY_NEEDS_NO_RATE', `${baseCurrency} is the base currency`);
    const cur = await this.assertCurrency(input.currency);
    const convention: RateConvention = input.convention ?? (cur.decimalPlaces === 0 ? 'FOREIGN_PER_BASE' : 'BASE_PER_FOREIGN');
    const effectiveAt = input.effectiveAt ?? new Date();
    if (await this.db.client.exchangeRate.findFirst({ where: { fromCurrency: input.currency, toCurrency: baseCurrency, effectiveAt } })) {
      throw conflict('EXCHANGE_RATE_EXISTS', 'A rate for this currency already exists at exactly that time; record the new one at a later time');
    }
    const row = await this.db.client.exchangeRate.create({
      data: {
        fromCurrency: input.currency, toCurrency: baseCurrency, rate: normaliseRate(input.rate), convention,
        effectiveAt, source: input.source ?? 'MANUAL_ENTRY', createdBy: auth.userId,
      } as any,
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'EXCHANGE_RATE_RECORDED', entityType: 'ExchangeRate',
      entityId: row.id, after: row, ip: meta.ip, userAgent: meta.userAgent,
    });
    return row;
  }

  async latest(tenantId: string, currency: string, at: Date) {
    const r = await this.resolve(tenantId, currency, at);
    return { ...r, asOf: at.toISOString() };
  }

  async getOrThrow(id: string) {
    const r = await this.db.client.exchangeRate.findUnique({ where: { id } });
    if (!r) throw notFound('EXCHANGE_RATE_NOT_FOUND', 'Exchange rate not found');
    return r;
  }
}
