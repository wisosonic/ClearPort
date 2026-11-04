import { createUser, provision, signIn, type TestApi } from './api-helpers';

export const ok = async (p: any) => {
  const res = await p;
  if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.data;
};

export interface FinanceOffice {
  slug: string;
  tenantId: string;
  ownerId: string;
  owner: string;
  accountant: string; // accounting.post, expenses.approve, invoices.issue, payments.create
  manager: string;
  officer: string; // can record expenses and create invoices drafts, nothing that moves money
  viewer: string;
  clientId: string;
  fileId: string;
  cash: { usd: string; lbp: string };
  cat: Record<string, string>; // category name -> id
  /** a second, empty file for the same client */
  newFile: (token?: string, extra?: Record<string, unknown>) => Promise<string>;
}

/**
 * An office ready for finance tests: USD base, LBP (89,500 per USD) and EUR (1.0850 USD) rates from
 * 1 Jan 2026, one client and file, the seeded categories, and users with different finance powers.
 */
export async function financeOffice(api: TestApi, slug: string): Promise<FinanceOffice> {
  const prov = await provision(api, slug, `owner@${slug}.test`);
  const owner = (await signIn(api, `owner@${slug}.test`)).accessToken;
  await createUser(api, owner, `accountant@${slug}.test`, 'ACCOUNTANT');
  await createUser(api, owner, `manager@${slug}.test`, 'MANAGER');
  await createUser(api, owner, `officer@${slug}.test`, 'CLEARANCE_OFFICER');
  await createUser(api, owner, `viewer@${slug}.test`, 'VIEWER');
  const accountant = (await signIn(api, `accountant@${slug}.test`)).accessToken;
  const manager = (await signIn(api, `manager@${slug}.test`)).accessToken;
  const officer = (await signIn(api, `officer@${slug}.test`)).accessToken;
  const viewer = (await signIn(api, `viewer@${slug}.test`)).accessToken;

  await ok(api.req('post', '/exchange-rates', accountant).send({ currency: 'LBP', rate: '89500', effectiveAt: '2026-01-01T00:00:00Z', source: 'test' }));
  await ok(api.req('post', '/exchange-rates', accountant).send({ currency: 'EUR', rate: '1.0850', effectiveAt: '2026-01-01T00:00:00Z', source: 'test' }));

  const clientId = (await ok(api.req('post', '/clients', owner).send({ name: `Client of ${slug}`, paymentTermsDays: 30 }))).id;
  const newFile = async (token = owner, extra: Record<string, unknown> = {}) =>
    (await ok(api.req('post', '/clearance-files', token).send({ fileType: 'IMPORT', clientId, ...extra }))).id as string;
  const fileId = await newFile();

  const cashAccounts = await ok(api.req('get', '/cash-accounts', accountant));
  const cats = await ok(api.req('get', '/financial-categories', owner));
  const me = await ok(api.req('get', '/auth/me', owner));
  return {
    slug, tenantId: prov.tenantId, ownerId: me.user.id, owner, accountant, manager, officer, viewer, clientId, fileId, newFile,
    cash: { usd: cashAccounts.find((c: any) => c.currencyCode === 'USD').id, lbp: cashAccounts.find((c: any) => c.currencyCode === 'LBP').id },
    cat: Object.fromEntries(cats.map((c: any) => [c.name, c.id])),
  };
}

export const CAT = {
  DUTIES: 'Customs duties and taxes',
  PORT: 'Port fees',
  TRANSPORT: 'Transportation',
  SERVICE: 'Clearance service fees',
  OFFICE: 'Office expenses (non-billable)',
} as const;

/** Account balances (base currency, normal direction) from the trial balance, by code. */
export async function trialBalance(api: TestApi, token: string, asOf?: string) {
  const tb = await ok(api.req('get', `/accounting/trial-balance${asOf ? `?asOf=${asOf}` : ''}`, token));
  const byCode = Object.fromEntries(tb.lines.map((l: any) => [l.accountCode, l]));
  const balance = (code: string) => (byCode[code]?.balance ?? '0.0000') as string;
  return { tb, byCode, balance, balanced: tb.balanced as boolean };
}
