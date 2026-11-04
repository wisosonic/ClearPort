import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocateSequenceValue, fileNumberPrefix, formatNumber, nextDocumentNumber,
} from '../src/common/numbering';
import { expectRule, freshDb, makeTenant, type TestDb } from './helpers';

describe('file number generation', () => {
  let db: TestDb;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await freshDb();
    tenantA = (await makeTenant(db.prisma, 'num-a')).id;
    tenantB = (await makeTenant(db.prisma, 'num-b')).id;
  });
  afterAll(async () => db.cleanup());

  it('formats numbers like IMP-2026-00001', () => {
    expect(formatNumber('IMP', 2026, 1)).toBe('IMP-2026-00001');
    expect(formatNumber('EXP', 2026, 12345)).toBe('EXP-2026-12345');
    expect(fileNumberPrefix('IMPORT')).toBe('IMP');
    expect(fileNumberPrefix('EXPORT')).toBe('EXP');
  });

  it('allocates consecutive numbers starting at 1', async () => {
    const first = await nextDocumentNumber(db.prisma, tenantA, 'IMP', 2026);
    const second = await nextDocumentNumber(db.prisma, tenantA, 'IMP', 2026);
    expect(first).toBe('IMP-2026-00001');
    expect(second).toBe('IMP-2026-00002');
  });

  it('keeps sequences separate per document type, year and tenant', async () => {
    expect(await nextDocumentNumber(db.prisma, tenantA, 'EXP', 2026)).toBe('EXP-2026-00001');
    expect(await nextDocumentNumber(db.prisma, tenantA, 'IMP', 2027)).toBe('IMP-2027-00001');
    expect(await nextDocumentNumber(db.prisma, tenantB, 'IMP', 2026)).toBe('IMP-2026-00001');
  });

  it('never hands out the same number under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () => allocateSequenceValue(db.prisma, tenantA, 'INV', 2026)),
    );
    expect(new Set(results).size).toBe(60);
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
  });

  it('rolls the number back with a failed transaction (no gaps from failures)', async () => {
    const before = await allocateSequenceValue(db.prisma, tenantB, 'PAY', 2026);
    await expect(
      db.prisma.$transaction(async (tx) => {
        await allocateSequenceValue(tx, tenantB, 'PAY', 2026);
        throw new Error('simulated failure after allocation');
      }),
    ).rejects.toThrow('simulated failure');
    const after = await allocateSequenceValue(db.prisma, tenantB, 'PAY', 2026);
    expect(after).toBe(before + 1);
  });

  it('cannot create two files with the same number in one tenant', async () => {
    const user = await db.prisma.user.create({
      data: { email: 'dup@example.com', passwordHash: 'x', firstName: 'D', lastName: 'U' },
    });
    await db.prisma.tenantUser.create({ data: { tenantId: tenantA, userId: user.id } });
    const client = await db.prisma.client.create({ data: { tenantId: tenantA, clientCode: 'DUP', name: 'Dup' } });
    const data = {
      tenantId: tenantA, fileNumber: 'IMP-2026-99999', fileType: 'IMPORT' as const,
      clientId: client.id, createdBy: user.id,
    };
    await db.prisma.clearanceFile.create({ data });
    await expect(db.prisma.clearanceFile.create({ data })).rejects.toThrow();
  });

  it('does not allow a file number to change once assigned', async () => {
    const file = await db.prisma.clearanceFile.findFirstOrThrow({ where: { tenantId: tenantA } });
    await expectRule(
      db.prisma.clearanceFile.update({ where: { id: file.id }, data: { fileNumber: 'IMP-2026-00000' } }),
      /immutable/i,
    );
  });
});
