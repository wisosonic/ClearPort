import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithTenant, requireTenant, currentTenant, NoTenantContextError } from '../src/database/tenant-context';
import { createTenantClient, TenantScopeViolation, type TenantClient } from '../src/database/tenant-scope';
import { freshDb, makeClient, makeFile, makeMember, makeTenant, type TestDb } from './helpers';

/** The application-layer isolation that replaces Postgres RLS. */
describe('tenant-scoped Prisma client', () => {
  let db: TestDb;
  let a: { id: string; user: string; client: string; file: string };
  let b: { id: string; user: string; client: string; file: string };
  let tA: TenantClient;
  let tB: TenantClient;

  async function seed(slug: string) {
    const t = await makeTenant(db.prisma, slug);
    const u = await makeMember(db.prisma, t.id, `${slug}@x.test`);
    const c = await makeClient(db.prisma, t.id, 'C1');
    const f = await makeFile(db.prisma, { tenantId: t.id, clientId: c.id, createdBy: u.id });
    return { id: t.id, user: u.id, client: c.id, file: f.id };
  }

  beforeAll(async () => {
    db = await freshDb();
    a = await seed('scope-a');
    b = await seed('scope-b');
    tA = createTenantClient(db.prisma, a.id);
    tB = createTenantClient(db.prisma, b.id);
  });
  afterAll(async () => db.cleanup());

  it('reads only the tenant\'s own rows, with or without extra filters', async () => {
    expect((await tA.client.findMany()).map((c) => c.tenantId)).toEqual([a.id]);
    expect(await tA.client.count()).toBe(1);
    expect(await tA.client.findMany({ where: { tenantId: b.id } })).toEqual([]); // explicit foreign filter still scoped
    expect(await tA.client.findMany({ where: { OR: [{ tenantId: b.id }, { name: { contains: 'C' } }] } })).toHaveLength(1);
    expect(await tA.clearanceFile.findUnique({ where: { id: b.file } })).toBeNull();
    expect(await tA.clearanceFile.findFirst({ where: { id: b.file } })).toBeNull();
    expect(await tA.clearanceFile.findUnique({ where: { id: a.file } })).not.toBeNull();
  });

  it('cannot update or delete another tenant\'s rows (acts as not found)', async () => {
    await expect(tA.client.update({ where: { id: b.client }, data: { name: 'x' } })).rejects.toMatchObject({ code: 'P2025' });
    await expect(tA.client.delete({ where: { id: b.client } })).rejects.toMatchObject({ code: 'P2025' });
    expect((await tA.client.updateMany({ where: { id: b.client }, data: { name: 'x' } })).count).toBe(0);
    expect((await tA.client.deleteMany({ where: { id: b.client } })).count).toBe(0);
    expect((await db.prisma.client.findUniqueOrThrow({ where: { id: b.client } })).name).toBe('Client C1');
  });

  it('stamps tenantId on create and refuses a different one', async () => {
    const created = await tA.client.create({ data: { clientCode: 'NEW1', name: 'New' } as any });
    expect(created.tenantId).toBe(a.id);
    await expect(tA.client.create({ data: { tenantId: b.id, clientCode: 'NEW2', name: 'Evil' } })).rejects.toThrow(TenantScopeViolation);
    await expect(tA.client.update({ where: { id: created.id }, data: { tenantId: b.id } })).rejects.toThrow(TenantScopeViolation);
    await expect(
      tA.client.create({ data: { clientCode: 'NEW3', name: 'Rel', tenant: { connect: { id: b.id } } } as any }),
    ).rejects.toThrow(TenantScopeViolation);
    const many = await tA.client.createMany({ data: [{ clientCode: 'M1', name: 'm' }, { clientCode: 'M2', name: 'm' }] as any });
    expect(many.count).toBe(2);
    expect(await db.prisma.client.count({ where: { tenantId: b.id } })).toBe(1);
  });

  it('upsert cannot reach another tenant\'s row', async () => {
    const up = await tA.client.upsert({
      where: { tenantId_clientCode: { tenantId: b.id, clientCode: 'C1' } },
      create: { clientCode: 'C1', name: 'upserted' } as any,
      update: { name: 'overwritten' },
    }).catch((e) => e);
    // The scoped where cannot match B's row; A already has C1 so the create path conflicts — either way B is untouched.
    expect((await db.prisma.client.findFirstOrThrow({ where: { tenantId: b.id, clientCode: 'C1' } })).name).toBe('Client C1');
    expect(up).toBeDefined();
  });

  it('exposes system roles to every tenant but never lets them be modified', async () => {
    const roles = await tA.role.findMany();
    expect(roles.some((r) => r.tenantId === null && r.code === 'OWNER')).toBe(true);
    const owner = roles.find((r) => r.code === 'OWNER')!;
    expect(await tA.role.findUnique({ where: { id: owner.id } })).not.toBeNull();
    await expect(tA.role.update({ where: { id: owner.id }, data: { name: 'hacked' } })).rejects.toMatchObject({ code: 'P2025' });
    await expect(tA.role.delete({ where: { id: owner.id } })).rejects.toMatchObject({ code: 'P2025' });
    expect((await tA.role.updateMany({ where: { tenantId: null }, data: { name: 'hacked' } })).count).toBe(0);

    const custom = await tB.role.create({ data: { code: 'B_CUSTOM', name: 'B custom' } as any });
    expect(await tA.role.findUnique({ where: { id: custom.id } })).toBeNull(); // other tenant's custom role is invisible
    expect((await tA.role.findMany()).some((r) => r.code === 'B_CUSTOM')).toBe(false);
  });

  it('blocks identity models that must only be used by auth code', async () => {
    await expect((tA as any).user.findMany()).rejects.toThrow(TenantScopeViolation);
    await expect((tA as any).tenant.findMany()).rejects.toThrow(TenantScopeViolation);
    await expect((tA as any).refreshSession.findMany()).rejects.toThrow(TenantScopeViolation);
  });

  it('allows global reference data', async () => {
    expect(await tA.currency.count()).toBeGreaterThan(0);
    expect(await tA.permission.count()).toBeGreaterThan(0);
  });

  it('scopes aggregates and groupBy', async () => {
    expect((await tA.clearanceFile.aggregate({ _count: true }))._count).toBe(1);
    const groups = await tA.client.groupBy({ by: ['tenantId'], _count: true });
    expect(groups.map((g) => g.tenantId)).toEqual([a.id]);
  });
});

describe('tenant context', () => {
  it('is available inside runWithTenant, including across awaits', async () => {
    expect(currentTenant()).toBeUndefined();
    expect(() => requireTenant()).toThrow(NoTenantContextError);
    await runWithTenant({ tenantId: 't1' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(requireTenant().tenantId).toBe('t1');
    });
    expect(currentTenant()).toBeUndefined();
  });

  it('keeps concurrent requests from different tenants isolated', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['t1', 't2', 't3', 't4'].map((t, i) =>
        runWithTenant({ tenantId: t }, async () => {
          await new Promise((r) => setTimeout(r, 20 - i * 4));
          seen.push(`${t}:${requireTenant().tenantId}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['t1:t1', 't2:t2', 't3:t3', 't4:t4']);
  });
});
