import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { Authenticated, CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { AccountingService } from './accounting.service';
import { FinanceSetupService } from './finance-setup.service';
import {
  createAccountSchema, createCashAccountSchema, createCategorySchema, createJournalSchema, createRateSchema,
  journalListQuerySchema, latestRateQuerySchema, rateListQuerySchema, reverseJournalSchema, taxSettingsSchema,
  trialBalanceQuerySchema, updateAccountSchema, updateCashAccountSchema, updateCategorySchema,
} from './finance.schemas';
import { RatesService } from './rates.service';

const id = () => new ZodPipe(uuid);

/** Currencies, exchange rates, categories, tax setting. Reading is open to any office member. */
@Controller()
export class FinanceSetupController {
  constructor(
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(FinanceSetupService) private readonly setup: FinanceSetupService,
  ) {}

  @Authenticated()
  @Get('currencies')
  currencies() {
    return this.rates.currencies();
  }

  @Authenticated()
  @Get('exchange-rates')
  listRates(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(rateListQuerySchema)) q: z.infer<typeof rateListQuerySchema>) {
    return this.rates.list(auth.tenantId, q.currency);
  }

  /** The rate a transaction on that date would use right now (or 422 if none is on file). */
  @Authenticated()
  @Get('exchange-rates/latest')
  latest(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(latestRateQuerySchema)) q: z.infer<typeof latestRateQuerySchema>) {
    const at = q.date ? new Date(`${q.date}T23:59:59.999Z`) : new Date();
    return this.rates.latest(auth.tenantId, q.currency, at);
  }

  /** Append-only: record a new rate with a later effective time to correct an old one. */
  @RequirePermissions('accounting.post')
  @Post('exchange-rates')
  createRate(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createRateSchema)) body: z.infer<typeof createRateSchema>, @ReqMeta() meta: RequestMeta) {
    return this.rates.create(auth, body, meta);
  }

  @Authenticated()
  @Get('financial-categories')
  categories(@Query('includeInactive') includeInactive?: string) {
    return this.setup.categories(includeInactive === 'true');
  }

  @RequirePermissions('settings.manage')
  @Post('financial-categories')
  createCategory(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createCategorySchema)) body: z.infer<typeof createCategorySchema>, @ReqMeta() meta: RequestMeta) {
    return this.setup.createCategory(auth, body, meta);
  }

  @RequirePermissions('settings.manage')
  @Patch('financial-categories/:categoryId')
  updateCategory(
    @CurrentAuth() auth: AuthContext, @Param('categoryId', id()) categoryId: string,
    @Body(new ZodPipe(updateCategorySchema)) body: z.infer<typeof updateCategorySchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.setup.updateCategory(auth, categoryId, body, meta);
  }

  @Authenticated()
  @Get('settings/tax')
  getTax() {
    return this.setup.getTax();
  }

  /** The office enters its tax rate; it is applied to NEW invoices and snapshotted on each line. */
  @RequirePermissions('settings.manage')
  @Put('settings/tax')
  putTax(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(taxSettingsSchema)) body: z.infer<typeof taxSettingsSchema>, @ReqMeta() meta: RequestMeta) {
    return this.setup.putTax(auth, body, meta);
  }
}

@Controller()
export class AccountingController {
  constructor(@Inject(AccountingService) private readonly accounting: AccountingService) {}

  @RequirePermissions('accounting.view')
  @Get('accounting/accounts')
  accounts() {
    return this.accounting.accounts();
  }

  @RequirePermissions('accounting.post')
  @Post('accounting/accounts')
  createAccount(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createAccountSchema)) body: z.infer<typeof createAccountSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounting.createAccount(auth, body, meta);
  }

  @RequirePermissions('accounting.post')
  @Patch('accounting/accounts/:accountId')
  updateAccount(
    @CurrentAuth() auth: AuthContext, @Param('accountId', id()) accountId: string,
    @Body(new ZodPipe(updateAccountSchema)) body: z.infer<typeof updateAccountSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounting.updateAccount(auth, accountId, body, meta);
  }

  @RequirePermissions('accounting.view')
  @Get('accounting/journal-entries')
  journal(@Query(new ZodPipe(journalListQuerySchema)) q: z.infer<typeof journalListQuerySchema>) {
    return this.accounting.list(q);
  }

  @RequirePermissions('accounting.view')
  @Get('accounting/journal-entries/:entryId')
  entry(@Param('entryId', id()) entryId: string) {
    return this.accounting.getEntry(entryId);
  }

  /** A manual adjustment, posted immediately. Business documents post their own entries automatically. */
  @RequirePermissions('accounting.post')
  @Post('accounting/journal-entries')
  postManual(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createJournalSchema)) body: z.infer<typeof createJournalSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounting.createManual(auth, body, meta);
  }

  @RequirePermissions('accounting.post')
  @HttpCode(200)
  @Post('accounting/journal-entries/:entryId/reverse')
  reverse(
    @CurrentAuth() auth: AuthContext, @Param('entryId', id()) entryId: string,
    @Body(new ZodPipe(reverseJournalSchema)) body: z.infer<typeof reverseJournalSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounting.reverseManual(auth, entryId, body.reason, meta);
  }

  @RequirePermissions('accounting.view')
  @Get('accounting/trial-balance')
  trialBalance(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(trialBalanceQuerySchema)) q: z.infer<typeof trialBalanceQuerySchema>) {
    return this.accounting.trialBalance(auth.tenantId, q.asOf);
  }

  @RequirePermissions('payments.view')
  @Get('cash-accounts')
  cashAccounts(@Query('includeInactive') includeInactive?: string) {
    return this.accounting.cashAccounts(includeInactive === 'true');
  }

  @RequirePermissions('accounting.post')
  @Post('cash-accounts')
  createCash(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createCashAccountSchema)) body: z.infer<typeof createCashAccountSchema>, @ReqMeta() meta: RequestMeta) {
    return this.accounting.createCashAccount(auth, body, meta);
  }

  @RequirePermissions('accounting.post')
  @Patch('cash-accounts/:cashId')
  updateCash(
    @CurrentAuth() auth: AuthContext, @Param('cashId', id()) cashId: string,
    @Body(new ZodPipe(updateCashAccountSchema)) body: z.infer<typeof updateCashAccountSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.accounting.updateCashAccount(auth, cashId, body, meta);
  }
}
