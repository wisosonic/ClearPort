import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, type FinanceOffice } from './finance-helpers';

describe('notifications and office-wide switches', () => {
  let api: TestApi;
  let A: FinanceOffice; // has exchange rates, so its main currency is fixed
  let officer: string;
  let officerId: string;
  let owner2: string; // a brand-new office with nothing booked
  let fileId: string;

  const me = async (token: string) => (await ok(api.req('get', '/auth/me', token))).user.id as string;
  const assign = (to: string | null) => api.req('post', `/clearance-files/${fileId}/assign`, A.owner).send({ userId: to });
  const mine = async (token: string, q = '') => (await api.req('get', `/notifications${q}`, token)).body;

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'notif-a');
    officer = A.officer;
    officerId = await me(officer);
    fileId = A.fileId;
    await provision(api, 'notif-new', 'owner@notif-new.test');
    owner2 = (await signIn(api, 'owner@notif-new.test')).accessToken;
  });
  afterAll(async () => api.close());

  it('tells an employee when a file is assigned to them, and keeps it private to them', async () => {
    expect((await assign(officerId)).status).toBe(200);
    const list = await mine(officer);
    expect(list.meta.unreadCount).toBeGreaterThan(0);
    const n = list.data.find((x: any) => x.type === 'FILE_ASSIGNED');
    expect(n).toMatchObject({ readAt: null });
    expect((await mine(A.owner)).data.some((x: any) => x.id === n.id)).toBe(false); // the owner does not see it
    expect((await api.req('post', `/notifications/${n.id}/read`, A.owner)).status).toBe(404); // nor can they touch it
    expect((await api.req('post', `/notifications/${n.id}/read`, officer)).status).toBe(204);
    expect((await mine(officer, '?unread=true')).data.some((x: any) => x.id === n.id)).toBe(false);
    expect((await mine(officer)).data.find((x: any) => x.id === n.id).readAt).not.toBeNull();
  });

  it('marks everything read at once', async () => {
    await assign(null);
    await assign(officerId);
    expect((await mine(officer)).meta.unreadCount).toBeGreaterThan(0);
    expect((await ok(api.req('post', '/notifications/read-all', officer))).marked).toBeGreaterThan(0);
    expect((await mine(officer)).meta.unreadCount).toBe(0);
  });

  it('stops creating in-app notifications when the office switches them off, and resumes when on again', async () => {
    const before = (await mine(officer)).meta.total;
    expect((await api.req('patch', '/tenant', A.owner).send({ notifyInApp: false })).body.data.notifyInApp).toBe(false);
    await assign(null);
    await assign(officerId);
    expect((await mine(officer)).meta.total).toBe(before); // nothing new
    await api.req('patch', '/tenant', A.owner).send({ notifyInApp: true });
    await assign(null);
    await assign(officerId);
    expect((await mine(officer)).meta.total).toBe(before + 1);
  });

  it('records the email and SMS choices, defaulting to off, and only settings managers can change them', async () => {
    const t = (await ok(api.req('get', '/tenant', A.owner)));
    expect(t).toMatchObject({ notifyInApp: true, notifyEmail: false, notifySms: false });
    const res = await api.req('patch', '/tenant', A.owner).send({ notifyEmail: true, notifySms: true });
    expect(res.body.data).toMatchObject({ notifyEmail: true, notifySms: true, notifyInApp: true });
    expect((await api.req('patch', '/tenant', officer).send({ notifyEmail: false })).status).toBe(403);
    expect((await ok(api.req('get', '/tenant', owner2))).notifyEmail).toBe(false); // another office untouched
  });

  describe('main currency', () => {
    it('is fixed once records exist, and says what is in the way', async () => {
      const info = await ok(api.req('get', '/tenant/currency-change', A.owner));
      expect(info.canChange).toBe(false);
      expect(info.blockers).toContain('EXCHANGE_RATES');
      const res = await api.req('patch', '/tenant', A.owner).send({ defaultCurrency: 'LBP' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('BASE_CURRENCY_IN_USE');
      expect((await ok(api.req('get', '/tenant', A.owner))).defaultCurrency).toBe('USD');
      expect((await api.req('patch', '/tenant', A.owner).send({ defaultCurrency: 'USD' })).status).toBe(200); // unchanged is fine
      expect((await api.req('get', '/tenant/currency-change', officer)).status).toBe(403);
    });

    it('can be changed in a brand-new office, and is then used for everything', async () => {
      expect((await ok(api.req('get', '/tenant/currency-change', owner2))).canChange).toBe(true);
      expect((await api.req('patch', '/tenant', owner2).send({ defaultCurrency: 'EUR' })).body.data.defaultCurrency).toBe('EUR');
      expect((await ok(api.req('get', '/auth/me', owner2))).tenant.defaultCurrency).toBe('EUR');
      // from now on EUR is the base: an invoice without a currency is in EUR
      const client = await ok(api.req('post', '/clients', owner2).send({ name: 'Euro client' }));
      const file = await ok(api.req('post', '/clearance-files', owner2).send({ fileType: 'IMPORT', clientId: client.id }));
      const cats = await ok(api.req('get', '/financial-categories', owner2));
      const inv = await ok(api.req('post', '/invoices', owner2).send({ clearanceFileId: file.id, items: [{ description: 'Fee', categoryId: cats.find((c: any) => c.name === CAT.SERVICE).id, unitPrice: '100' }] }));
      expect(inv.currencyCode).toBe('EUR');
      // ... and with an invoice on record (even a draft) it is fixed again
      const after = await ok(api.req('get', '/tenant/currency-change', owner2));
      expect(after).toMatchObject({ canChange: false, blockers: ['INVOICES'] });
    });
  });
});
