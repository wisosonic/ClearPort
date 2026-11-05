import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, DomainError, notFound, unprocessable } from '../../common/errors';
import { abs, add, compare, isPositive, negate, sub, sum, ZERO, type DecimalString } from '../../common/money';
import { nextDocumentNumber } from '../../common/numbering';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import type {
  createAccountSchema, createCashAccountSchema, createJournalSchema, journalListQuerySchema, updateAccountSchema,
  updateCashAccountSchema,
} from './finance.schemas';
import { RatesService, type RateConvention } from './rates.service';

/** Logical roles of the ledger accounts the business flows post to (seeded per office). */
export const ACCOUNTS = {
  CASH_GROUP: '1000',
  RECEIVABLES: '1200', // clients owe us for invoices
  DISBURSEMENTS: '1300', // pass-through costs paid for clients, not yet re-billed
  CLIENT_ADVANCES: '2100', // money held for clients (a LIABILITY, never revenue)
  PAYABLES: '2200', // vendors we owe
  TAXES_PAYABLE: '2300',
  SERVICE_REVENUE: '4100',
  FX_GAIN_LOSS: '4300',
  OFFICE_EXPENSES: '5100',
} as const;

/** Entries that count in balances: posted ones and ones later reversed (their reversal entry offsets them). */
export const LEDGER_STATUSES = ['POSTED', 'REVERSED'] as const;

export interface PostingLine {
  account: string; // account code
  side: 'DEBIT' | 'CREDIT';
  currency: string;
  amount: DecimalString; // transaction currency, positive
  rate: DecimalString;
  convention: RateConvention;
  /** Base-currency value. Callers that must balance exactly across several lines pass it explicitly. */
  base: DecimalString;
  clearanceFileId?: string | null;
  /** Only for revaluation: the line moves the base value of a foreign balance without changing the foreign amount (amount is 0). */
  baseOnly?: boolean;
}

export interface PostingSpec {
  entryDate: Date;
  description: string;
  sourceType: string;
  sourceId?: string | null;
  createdBy: string;
  /** Set only on reversal entries. Must be given at creation: a posted entry is immutable. */
  reversalOfId?: string | null;
  lines: PostingLine[];
}

const DEBIT_NORMAL = new Set(['ASSET', 'EXPENSE']);

@Injectable()
export class AccountingService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ═══════════════════════════ posting (used by every business flow) ═══════════════════════════

  /**
   * Creates and POSTS a balanced journal entry inside the caller's transaction (spec 18.2).
   * Validates accounts, amounts and exact balance in base currency; the database trigger re-checks
   * on the DRAFT→POSTED switch and makes the entry immutable afterwards.
   */
  async post(tx: any, spec: PostingSpec): Promise<{ id: string; entryNumber: string }> {
    if (spec.lines.length < 2) throw new Error('A journal entry needs at least two lines');
    const codes = [...new Set(spec.lines.map((l) => l.account))];
    const accounts = await tx.chartOfAccount.findMany({ where: { accountCode: { in: codes } } });
    const byCode = new Map<string, { id: string; isActive: boolean; name: string }>(accounts.map((a: any) => [a.accountCode, a]));
    for (const code of codes) {
      const a = byCode.get(code);
      if (!a) throw new DomainError('LEDGER_ACCOUNT_MISSING', `Ledger account ${code} does not exist in this office's chart of accounts`, 500);
      if (!a.isActive) throw unprocessable('LEDGER_ACCOUNT_INACTIVE', `Ledger account ${code} (${a.name}) is inactive`);
    }

    let debits = ZERO;
    let credits = ZERO;
    for (const l of spec.lines) {
      if ((!l.baseOnly && !isPositive(l.amount)) || (l.baseOnly && compare(l.amount, ZERO) !== 0) || !isPositive(l.base)) {
        throw new Error(`Journal line amounts must be positive (account ${l.account}, ${l.amount}, base ${l.base})`);
      }
      if (l.side === 'DEBIT') debits = add(debits, l.base);
      else credits = add(credits, l.base);
    }
    if (compare(debits, credits) !== 0) {
      throw new Error(`Unbalanced journal entry in base currency: debits ${debits} vs credits ${credits} (${spec.sourceType})`);
    }

    const { tenantId } = requireTenant();
    const entryNumber = await nextDocumentNumber(tx, tenantId, 'JE', spec.entryDate.getUTCFullYear());
    const entry = await tx.journalEntry.create({
      data: {
        entryNumber, entryDate: spec.entryDate, description: spec.description, sourceType: spec.sourceType,
        sourceId: spec.sourceId ?? null, status: 'DRAFT', createdBy: spec.createdBy, reversalOfId: spec.reversalOfId ?? null,
      },
    });
    await tx.journalEntryLine.createMany({
      data: spec.lines.map((l) => ({
        journalEntryId: entry.id, accountId: byCode.get(l.account)!.id, currencyCode: l.currency,
        exchangeRate: l.rate, rateConvention: l.convention,
        debit: l.side === 'DEBIT' ? l.amount : ZERO, credit: l.side === 'CREDIT' ? l.amount : ZERO,
        baseDebit: l.side === 'DEBIT' ? l.base : ZERO, baseCredit: l.side === 'CREDIT' ? l.base : ZERO,
        clearanceFileId: l.clearanceFileId ?? null,
      })),
    });
    await tx.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', postedAt: new Date() } });
    return { id: entry.id, entryNumber };
  }

  /**
   * Reverses a POSTED entry with a mirror entry (spec 6.6): same lines and bases, debits and credits
   * swapped. The original is marked REVERSED; both stay in the ledger.
   */
  async reverse(tx: any, entryId: string, ctx: { reason: string; userId: string; date?: Date }): Promise<{ id: string; entryNumber: string }> {
    const original = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
    if (!original) throw notFound('JOURNAL_ENTRY_NOT_FOUND', 'Journal entry not found');
    if (original.status !== 'POSTED') throw conflict('JOURNAL_ENTRY_NOT_REVERSIBLE', `Only a posted entry can be reversed (this one is ${original.status.toLowerCase()})`);

    const accounts = await tx.chartOfAccount.findMany({ where: { id: { in: original.lines.map((l: any) => l.accountId) } } });
    const codeById = new Map<string, string>(accounts.map((a: any) => [a.id, a.accountCode]));
    const reversal = await this.post(tx, {
      entryDate: ctx.date ?? new Date(), description: `Reversal of ${original.entryNumber}: ${ctx.reason}`,
      sourceType: 'REVERSAL', sourceId: original.id, createdBy: ctx.userId, reversalOfId: original.id,
      lines: original.lines.map((l: any) => {
        const wasDebit = Number(l.baseDebit) > 0;
        const amount = wasDebit ? l.debit : l.credit;
        return {
          account: codeById.get(l.accountId)!, side: wasDebit ? 'CREDIT' : 'DEBIT', currency: l.currencyCode,
          amount, rate: l.exchangeRate, convention: l.rateConvention,
          base: wasDebit ? l.baseDebit : l.baseCredit, clearanceFileId: l.clearanceFileId, baseOnly: Number(amount) === 0,
        } satisfies PostingLine;
      }),
    });
    await tx.journalEntry.update({ where: { id: original.id }, data: { status: 'REVERSED' } });
    return reversal;
  }

  /** Reverses every still-posted entry created for a business record (e.g. an invoice's issue entry). */
  async reverseBySource(tx: any, sourceType: string, sourceId: string, ctx: { reason: string; userId: string; date?: Date }): Promise<number> {
    const entries = await tx.journalEntry.findMany({ where: { sourceType, sourceId, status: 'POSTED' }, orderBy: { createdAt: 'asc' } });
    for (const e of entries) await this.reverse(tx, e.id, ctx);
    return entries.length;
  }

  /**
   * Adds the realized foreign-exchange difference so an entry whose two sides were valued at
   * different rates still balances EXACTLY in base currency (e.g. a payment received at today's rate
   * settling an invoice booked at an older rate).
   *
   *   debits > credits  -> the extra value is a GAIN  -> credit 4300
   *   credits > debits  -> the shortfall is a LOSS    -> debit  4300
   */
  withFxPlug(lines: PostingLine[], baseCurrency: string, clearanceFileId?: string | null): PostingLine[] {
    const debits = sum(lines.filter((l) => l.side === 'DEBIT').map((l) => l.base));
    const credits = sum(lines.filter((l) => l.side === 'CREDIT').map((l) => l.base));
    const cmp = compare(debits, credits);
    if (cmp === 0) return lines;
    const diff = abs(sub(debits, credits));
    return [...lines, {
      account: ACCOUNTS.FX_GAIN_LOSS, side: cmp > 0 ? 'CREDIT' : 'DEBIT', currency: baseCurrency, amount: diff,
      rate: '1.0000000000', convention: 'BASE_PER_FOREIGN', base: diff, clearanceFileId: clearanceFileId ?? null,
    }];
  }

  // ═══════════════════════════ foreign-exchange revaluation ═══════════════════════════

  /**
   * Revalues the foreign-currency balances of every asset and liability account at the rates on file
   * for `asOf`, booking the difference to 4300 (FX gain / loss) in ONE entry dated `asOf`.
   *
   * Each account's carried base value (what the ledger holds today, including earlier revaluations) is compared
   * with its foreign balance converted at the `asOf` rate; only the difference is booked, so running it again at the next
   * period end continues from where it stopped, and a balance that has been settled in full is brought back to nil.
   * A currency without a rate for that date is skipped and reported — no rate is guessed.
   * `preview` returns the adjustments without posting.
   */
  async revalue(auth: AuthContext, input: { asOf: Date; preview: boolean }, meta: RequestMeta) {
    const tenantId = auth.tenantId;
    const base = await this.rates.baseCurrency(tenantId);
    const cutoff = new Date(input.asOf.getTime());
    cutoff.setUTCHours(23, 59, 59, 999);
    const accounts = await this.db.client.chartOfAccount.findMany({ where: { accountType: { in: ['ASSET', 'LIABILITY'] } } });
    const lines = await this.db.client.journalEntryLine.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) }, currencyCode: { not: base }, journalEntry: { status: { in: [...LEDGER_STATUSES] }, entryDate: { lte: cutoff } } },
      select: { accountId: true, currencyCode: true, debit: true, credit: true, baseDebit: true, baseCredit: true },
    });
    const groups = new Map<string, typeof lines>();
    for (const l of lines) groups.set(`${l.accountId}|${l.currencyCode}`, [...(groups.get(`${l.accountId}|${l.currencyCode}`) ?? []), l]);

    const adjustments: { accountCode: string; accountName: string; currency: string; foreignBalance: DecimalString; carriedBase: DecimalString; revaluedBase: DecimalString; difference: DecimalString }[] = [];
    const skipped: { accountCode: string; currency: string; reason: string }[] = [];
    for (const [key, rows] of groups) {
      const [accountId, currency] = key.split('|') as [string, string];
      const account = accounts.find((a) => a.id === accountId)!;
      const foreign = sub(sum(rows.map((r) => r.debit)), sum(rows.map((r) => r.credit)));
      const carried = sub(sum(rows.map((r) => r.baseDebit)), sum(rows.map((r) => r.baseCredit)));
      let r;
      try { r = await this.rates.resolve(tenantId, currency, input.asOf); } catch { skipped.push({ accountCode: account.accountCode, currency, reason: `No ${currency} exchange rate on or before ${input.asOf.toISOString().slice(0, 10)}` }); continue; }
      const magnitude = this.rates.toBase(abs(foreign), r);
      const revalued = compare(foreign, ZERO) < 0 ? negate(magnitude) : magnitude;
      const difference = sub(revalued, carried);
      if (compare(difference, ZERO) === 0) continue;
      adjustments.push({ accountCode: account.accountCode, accountName: account.name, currency, foreignBalance: foreign, carriedBase: carried, revaluedBase: revalued, difference });
    }
    adjustments.sort((a, b) => a.accountCode.localeCompare(b.accountCode) || a.currency.localeCompare(b.currency));
    const net = sum(adjustments.map((a) => a.difference)); // + = gain, - = loss
    const result = { asOf: input.asOf.toISOString().slice(0, 10), baseCurrency: base, adjustments, skipped, netGainLoss: net, entry: null as null | { id: string; entryNumber: string } };
    if (input.preview || adjustments.length === 0) return result;

    const postingLines: PostingLine[] = adjustments.map((a) => ({
      account: a.accountCode, side: compare(a.difference, ZERO) > 0 ? 'DEBIT' : 'CREDIT', currency: a.currency, amount: ZERO, rate: '1.0000000000',
      convention: 'BASE_PER_FOREIGN', base: abs(a.difference), baseOnly: true,
    }));
    postingLines.push({
      account: ACCOUNTS.FX_GAIN_LOSS, side: compare(net, ZERO) > 0 ? 'CREDIT' : 'DEBIT', currency: base, amount: abs(net), rate: '1.0000000000', convention: 'BASE_PER_FOREIGN', base: abs(net),
    });
    // gains and losses on different accounts may offset: the 4300 line carries only the net, the rest balance among the account lines
    const debits = sum(postingLines.filter((l) => l.side === 'DEBIT').map((l) => l.base));
    const credits = sum(postingLines.filter((l) => l.side === 'CREDIT').map((l) => l.base));
    if (compare(debits, credits) !== 0) throw new Error(`Unbalanced revaluation entry: ${debits} vs ${credits}`);
    const entry = await this.db.client.$transaction((tx) => this.post(tx, {
      entryDate: input.asOf, description: `Foreign-exchange revaluation as of ${result.asOf}`, sourceType: 'FX_REVALUATION', createdBy: auth.userId, lines: postingLines,
    }));
    await this.audit.record({
      tenantId, actorUserId: auth.userId, action: 'FX_REVALUATION_POSTED', entityType: 'JournalEntry', entityId: entry.id,
      after: { entryNumber: entry.entryNumber, asOf: result.asOf, netGainLoss: net, accounts: adjustments.length }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return { ...result, entry };
  }

  // ═══════════════════════════ manual entries and reading ═══════════════════════════

  async createManual(auth: AuthContext, input: z.infer<typeof createJournalSchema>, meta: RequestMeta) {
    const tenantId = auth.tenantId;
    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const known = await this.db.client.chartOfAccount.findMany({ where: { accountCode: { in: codes } }, select: { accountCode: true } });
    const missing = codes.filter((c) => !known.some((k) => k.accountCode === c));
    if (missing.length) {
      throw unprocessable('LEDGER_ACCOUNT_NOT_FOUND', `Unknown ledger account(s): ${missing.join(', ')}`, missing.map((accountCode) => ({ accountCode })));
    }
    const lines: PostingLine[] = [];
    for (const l of input.lines) {
      await this.rates.assertCurrency(l.currencyCode);
      const r = await this.rates.resolve(tenantId, l.currencyCode, input.entryDate, l);
      const amount = (l.debit ?? l.credit)!;
      lines.push({
        account: l.accountCode, side: l.debit !== undefined ? 'DEBIT' : 'CREDIT', currency: l.currencyCode, amount,
        rate: r.rate, convention: r.convention, base: this.rates.toBase(amount, r), clearanceFileId: l.clearanceFileId,
      });
    }
    // Manual entries are entered by a person, so an imbalance is a user error, not a bug.
    const d = sum(lines.filter((l) => l.side === 'DEBIT').map((l) => l.base));
    const c = sum(lines.filter((l) => l.side === 'CREDIT').map((l) => l.base));
    if (compare(d, c) !== 0) {
      throw unprocessable('JOURNAL_NOT_BALANCED', `Debits (${d}) and credits (${c}) are not equal in ${await this.rates.baseCurrency(tenantId)}`, [{ debits: d, credits: c }]);
    }
    const entry = await this.db.client.$transaction((tx) =>
      this.post(tx, { entryDate: input.entryDate, description: input.description, sourceType: 'MANUAL', createdBy: auth.userId, lines }));
    await this.audit.record({
      tenantId, actorUserId: auth.userId, action: 'JOURNAL_ENTRY_POSTED', entityType: 'JournalEntry', entityId: entry.id,
      after: { entryNumber: entry.entryNumber, description: input.description, sourceType: 'MANUAL' }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.getEntry(entry.id);
  }

  async reverseManual(auth: AuthContext, id: string, reason: string, meta: RequestMeta) {
    const e = await this.db.client.journalEntry.findUnique({ where: { id } });
    if (!e) throw notFound('JOURNAL_ENTRY_NOT_FOUND', 'Journal entry not found');
    // System-generated entries belong to a business record (invoice, payment...). Reversing them here
    // would leave the record and the ledger disagreeing, so they are undone through their own flow.
    if (e.sourceType !== 'MANUAL') {
      throw conflict('JOURNAL_ENTRY_SOURCE_MANAGED', `This entry was created by a ${e.sourceType?.toLowerCase()}; cancel or reverse that record instead`);
    }
    const reversal = await this.db.client.$transaction((tx) => this.reverse(tx, id, { reason, userId: auth.userId }));
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'JOURNAL_ENTRY_REVERSED', entityType: 'JournalEntry', entityId: id,
      after: { reversalEntryNumber: reversal.entryNumber, reason }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.getEntry(reversal.id);
  }

  async list(q: z.infer<typeof journalListQuerySchema>) {
    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.sourceType) where.sourceType = q.sourceType;
    if (q.from || q.to) {
      where.entryDate = {
        ...(q.from && { gte: new Date(`${q.from}T00:00:00.000Z`) }),
        ...(q.to && { lte: new Date(`${q.to}T23:59:59.999Z`) }),
      };
    }
    const lineFilter: any = {};
    if (q.clearanceFileId) lineFilter.clearanceFileId = q.clearanceFileId;
    if (q.accountCode) lineFilter.account = { accountCode: q.accountCode };
    if (Object.keys(lineFilter).length) where.lines = { some: lineFilter };
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'journal_entries', columns: ['entryNumber', 'description'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const [rows, total] = await Promise.all([
      this.db.client.journalEntry.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, ['entryDate', 'entryNumber', 'createdAt'] as const, { entryDate: 'desc' }),
        include: this.entryInclude,
      }),
      this.db.client.journalEntry.count({ where }),
    ]);
    return paginated(rows.map((e) => this.presentEntry(e)), q, total);
  }

  async getEntry(id: string) {
    const e = await this.db.client.journalEntry.findUnique({ where: { id }, include: this.entryInclude });
    if (!e) throw notFound('JOURNAL_ENTRY_NOT_FOUND', 'Journal entry not found');
    return this.presentEntry(e);
  }

  private readonly entryInclude = {
    lines: { include: { account: { select: { accountCode: true, name: true } } }, orderBy: { id: 'asc' } },
  } as const;

  private presentEntry(e: any) {
    const baseDebit = sum(e.lines.map((l: any) => l.baseDebit));
    const baseCredit = sum(e.lines.map((l: any) => l.baseCredit));
    return {
      id: e.id, entryNumber: e.entryNumber, entryDate: e.entryDate, description: e.description, sourceType: e.sourceType,
      sourceId: e.sourceId, status: e.status, reversalOfId: e.reversalOfId, postedAt: e.postedAt, createdAt: e.createdAt,
      totals: { baseDebit, baseCredit }, // equal for every posted entry
      lines: e.lines.map((l: any) => ({
        id: l.id, accountCode: l.account.accountCode, accountName: l.account.name, currencyCode: l.currencyCode,
        debit: l.debit, credit: l.credit, exchangeRate: l.exchangeRate, rateConvention: l.rateConvention,
        baseDebit: l.baseDebit, baseCredit: l.baseCredit, clearanceFileId: l.clearanceFileId,
      })),
    };
  }

  // ═══════════════════════════ chart of accounts ═══════════════════════════

  async accounts() {
    return this.db.client.chartOfAccount.findMany({ orderBy: { accountCode: 'asc' } });
  }

  async createAccount(auth: AuthContext, input: z.infer<typeof createAccountSchema>, meta: RequestMeta) {
    if (await this.db.client.chartOfAccount.findFirst({ where: { accountCode: input.accountCode } })) {
      throw conflict('ACCOUNT_CODE_TAKEN', `Account ${input.accountCode} already exists`);
    }
    if (input.parentId && !(await this.db.client.chartOfAccount.findUnique({ where: { id: input.parentId } }))) {
      throw unprocessable('PARENT_ACCOUNT_NOT_FOUND', 'Parent account not found');
    }
    if (input.currencyCode) await this.rates.assertCurrency(input.currencyCode);
    const row = await this.db.client.chartOfAccount.create({ data: input as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'LEDGER_ACCOUNT_CREATED', entityType: 'ChartOfAccount',
      entityId: row.id, after: row, ip: meta.ip, userAgent: meta.userAgent,
    });
    return row;
  }

  async updateAccount(auth: AuthContext, id: string, input: z.infer<typeof updateAccountSchema>, meta: RequestMeta) {
    const before = await this.db.client.chartOfAccount.findUnique({ where: { id } });
    if (!before) throw notFound('LEDGER_ACCOUNT_NOT_FOUND', 'Ledger account not found');
    if (input.isActive === false) {
      const system = Object.values(ACCOUNTS) as string[];
      if (system.includes(before.accountCode)) throw conflict('SYSTEM_ACCOUNT', `Account ${before.accountCode} is used by automatic postings and cannot be deactivated`);
      const bal = await this.balanceOf(before.id);
      if (compare(bal.debit, bal.credit) !== 0) throw conflict('ACCOUNT_HAS_BALANCE', 'An account with a non-zero balance cannot be deactivated');
    }
    const after = await this.db.client.chartOfAccount.update({ where: { id }, data: input });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'LEDGER_ACCOUNT_UPDATED', entityType: 'ChartOfAccount',
      entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  private async balanceOf(accountId: string) {
    const lines = await this.db.client.journalEntryLine.findMany({
      where: { accountId, journalEntry: { status: { in: [...LEDGER_STATUSES] } } }, select: { baseDebit: true, baseCredit: true },
    });
    return { debit: sum(lines.map((l) => l.baseDebit)), credit: sum(lines.map((l) => l.baseCredit)) };
  }

  /** Trial balance in BASE currency. Total debits always equal total credits. */
  async trialBalance(tenantId: string, asOf?: string) {
    const baseCurrency = await this.rates.baseCurrency(tenantId);
    const cutoff = asOf ? new Date(`${asOf}T23:59:59.999Z`) : undefined;
    const [accounts, lines] = await Promise.all([
      this.db.client.chartOfAccount.findMany({ orderBy: { accountCode: 'asc' } }),
      this.db.client.journalEntryLine.findMany({
        where: { journalEntry: { status: { in: [...LEDGER_STATUSES] }, ...(cutoff && { entryDate: { lte: cutoff } }) } },
        select: { accountId: true, baseDebit: true, baseCredit: true },
      }),
    ]);
    const rows = accounts.map((a) => {
      const mine = lines.filter((l) => l.accountId === a.id);
      const debit = sum(mine.map((l) => l.baseDebit));
      const credit = sum(mine.map((l) => l.baseCredit));
      const balance = DEBIT_NORMAL.has(a.accountType) ? sub(debit, credit) : sub(credit, debit);
      return { accountCode: a.accountCode, name: a.name, accountType: a.accountType, isActive: a.isActive, debit, credit, balance };
    }).filter((r) => compare(r.debit, ZERO) !== 0 || compare(r.credit, ZERO) !== 0);
    const totalDebit = sum(rows.map((r) => r.debit));
    const totalCredit = sum(rows.map((r) => r.credit));
    return { baseCurrency, asOf: asOf ?? null, lines: rows, totals: { debit: totalDebit, credit: totalCredit }, balanced: compare(totalDebit, totalCredit) === 0 };
  }

  /** Signed balance of one account in base currency, in the account's normal direction. */
  async accountBalances(codes: string[], opts: { fileId?: string; from?: Date; to?: Date } = {}) {
    const accounts = await this.db.client.chartOfAccount.findMany({ where: { accountCode: { in: codes } } });
    const lines = await this.db.client.journalEntryLine.findMany({
      where: {
        accountId: { in: accounts.map((a) => a.id) }, ...(opts.fileId && { clearanceFileId: opts.fileId }),
        journalEntry: { status: { in: [...LEDGER_STATUSES] }, ...((opts.from || opts.to) && { entryDate: { ...(opts.from && { gte: opts.from }), ...(opts.to && { lte: opts.to }) } }) },
      },
      select: { accountId: true, baseDebit: true, baseCredit: true },
    });
    const out: Record<string, { debit: DecimalString; credit: DecimalString; balance: DecimalString }> = {};
    for (const a of accounts) {
      const mine = lines.filter((l) => l.accountId === a.id);
      const debit = sum(mine.map((l) => l.baseDebit));
      const credit = sum(mine.map((l) => l.baseCredit));
      out[a.accountCode] = { debit, credit, balance: DEBIT_NORMAL.has(a.accountType) ? sub(debit, credit) : sub(credit, debit) };
    }
    return out;
  }

  // ═══════════════════════════ cash accounts ═══════════════════════════

  /** Cash / bank accounts with their ledger-derived balance, in each account's own currency. */
  async cashAccounts(includeInactive = false) {
    const accounts = await this.db.client.cashAccount.findMany({
      where: includeInactive ? {} : { isActive: true }, orderBy: { name: 'asc' }, include: { ledger: { select: { id: true, accountCode: true } } },
    });
    const ledgerIds = accounts.map((a) => a.ledger?.id).filter((x): x is string => !!x);
    const lines = ledgerIds.length
      ? await this.db.client.journalEntryLine.findMany({
        where: { accountId: { in: ledgerIds }, journalEntry: { status: { in: [...LEDGER_STATUSES] } } }, select: { accountId: true, debit: true, credit: true },
      })
      : [];
    return accounts.map((a) => {
      const mine = lines.filter((l) => l.accountId === a.ledger?.id);
      return {
        id: a.id, name: a.name, accountType: a.accountType, currencyCode: a.currencyCode, isActive: a.isActive,
        ledgerAccountCode: a.ledger?.accountCode ?? null, balance: sub(sum(mine.map((l) => l.debit)), sum(mine.map((l) => l.credit))),
      };
    });
  }

  async createCashAccount(auth: AuthContext, input: z.infer<typeof createCashAccountSchema>, meta: RequestMeta) {
    await this.rates.assertCurrency(input.currencyCode);
    if (await this.db.client.cashAccount.findFirst({ where: { name: input.name } })) throw conflict('CASH_ACCOUNT_NAME_TAKEN', 'A cash account with this name already exists');
    const group = await this.db.client.chartOfAccount.findFirst({ where: { accountCode: ACCOUNTS.CASH_GROUP } });
    if (!group) throw new DomainError('LEDGER_ACCOUNT_MISSING', 'The cash and bank group account (1000) is missing', 500);
    const siblings = await this.db.client.chartOfAccount.findMany({ where: { parentId: group.id }, select: { accountCode: true } });
    const next = Math.max(Number(ACCOUNTS.CASH_GROUP) + 10, ...siblings.map((s) => Number(s.accountCode) + 10));
    const created = await this.db.client.$transaction(async (tx) => {
      const ledger = await tx.chartOfAccount.create({
        data: { accountCode: String(next), name: input.name, accountType: 'ASSET', parentId: group.id, currencyCode: input.currencyCode } as any,
      });
      return tx.cashAccount.create({ data: { name: input.name, accountType: input.accountType, currencyCode: input.currencyCode, ledgerAccountId: ledger.id } as any });
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CASH_ACCOUNT_CREATED', entityType: 'CashAccount', entityId: created.id,
      after: created, ip: meta.ip, userAgent: meta.userAgent,
    });
    return (await this.cashAccounts(true)).find((c) => c.id === created.id)!;
  }

  async updateCashAccount(auth: AuthContext, id: string, input: z.infer<typeof updateCashAccountSchema>, meta: RequestMeta) {
    const before = await this.db.client.cashAccount.findUnique({ where: { id } });
    if (!before) throw notFound('CASH_ACCOUNT_NOT_FOUND', 'Cash account not found');
    if (input.isActive === false) {
      const bal = (await this.cashAccounts(true)).find((c) => c.id === id)!.balance;
      if (compare(bal, ZERO) !== 0) throw conflict('CASH_ACCOUNT_HAS_BALANCE', `The account still holds ${bal} ${before.currencyCode}; transfer it before deactivating`);
    }
    await this.db.client.cashAccount.update({ where: { id }, data: input });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CASH_ACCOUNT_UPDATED', entityType: 'CashAccount', entityId: id,
      before, after: input, ip: meta.ip, userAgent: meta.userAgent,
    });
    return (await this.cashAccounts(true)).find((c) => c.id === id)!;
  }

  /** A usable cash account in a given currency (active, has a ledger account). */
  async requireCashAccount(cashAccountId: string, currency: string) {
    const acc = await this.db.client.cashAccount.findUnique({ where: { id: cashAccountId }, include: { ledger: true } });
    if (!acc || !acc.isActive) throw unprocessable('CASH_ACCOUNT_NOT_FOUND', 'Cash account not found or inactive');
    if (!acc.ledger) throw new DomainError('LEDGER_ACCOUNT_MISSING', `Cash account "${acc.name}" has no ledger account`, 500);
    if (acc.currencyCode !== currency) {
      throw unprocessable('CASH_ACCOUNT_CURRENCY_MISMATCH', `"${acc.name}" holds ${acc.currencyCode}; this transaction is in ${currency}`);
    }
    return acc as typeof acc & { ledger: NonNullable<typeof acc.ledger> };
  }
}
