import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, createApp } from '../src/app.factory';
import { loadEnv } from '../src/config/env';
import { createBackup, pruneBackups, restoreBackup, sqlitePathFromUrl, verifyBackup, BackupError } from '../src/infrastructure/backup/backup';
import { HousekeepingService } from '../src/infrastructure/queue/housekeeping.service';
import { PASSWORD, JWT_SECRET, provision, signIn, startApi, type TestApi } from './api-helpers';

const PASS = 'a-long-test-passphrase';

describe('encrypted backup and restore', () => {
  let api: TestApi;
  let work: string;
  let dbPath: string;
  let archive: string;
  let counts: Record<string, number>;
  const docs: Record<string, Buffer> = {
    'tenants/t1/files/f1/d1/v1-aaa': Buffer.from('%PDF-1.4 first document'),
    'tenants/t1/files/f1/d1/v2-bbb': Buffer.from('%PDF-1.4 second version'),
    'tenants/t1/files/f2/d2/v1-ccc': Buffer.alloc(300_000, 7), // bigger than one stream chunk
    'tenants/t1/files/f2/d3/v1-empty': Buffer.alloc(0),
  };

  beforeAll(async () => {
    api = await startApi();
    work = mkdtempSync(join(tmpdir(), 'clearport-backup-'));
    dbPath = sqlitePathFromUrl(api.db.url);
    await provision(api, 'bk-a', 'owner@bk-a.test');
    await provision(api, 'bk-b', 'owner@bk-b.test');
    for (const [k, v] of Object.entries(docs)) {
      mkdirSync(join(api.storageRoot, k, '..'), { recursive: true });
      writeFileSync(join(api.storageRoot, k), v);
    }
    writeFileSync(join(api.storageRoot, '_tmp', 'half-uploaded'), 'temp'); // must NOT be backed up
    counts = {
      tenants: await api.prisma.tenant.count(), users: await api.prisma.user.count(), audit: await api.prisma.auditLog.count(),
    };
    const r = await createBackup({ databasePath: dbPath, storageRoot: api.storageRoot, outputDir: join(work, 'out'), passphrase: PASS });
    archive = r.path;
  }, 60_000);
  afterAll(async () => { await api.close(); rmSync(work, { recursive: true, force: true }); });

  it('writes one encrypted file that reveals nothing readable', () => {
    expect(archive).toMatch(/clearport-backup-.*\.cpbak$/);
    const raw = readFileSync(archive);
    expect(raw.subarray(0, 5).toString()).toBe('CPBK1');
    expect(raw.includes(Buffer.from('SQLite format'))).toBe(false); // the database header is not visible
    expect(raw.includes(Buffer.from('first document'))).toBe(false);
    expect(raw.includes(Buffer.from('owner@bk-a.test'))).toBe(false);
    expect(readdirSync(join(work, 'out'))).toEqual([archive.split(/[\\/]/).pop()]); // no scratch files left behind
  });

  it('records what it contains: row counts per table, the documents, checksums', async () => {
    const m = await verifyBackup(archive, PASS);
    expect(m.format).toBe(1);
    expect(m.storageFiles).toBe(4);
    expect(m.tables.tenants).toBe(counts.tenants);
    expect(m.tables.users).toBe(counts.users);
    expect(m.entries.map((e) => e.name)).toContain('storage/tenants/t1/files/f1/d1/v1-aaa');
    expect(m.entries.some((e) => e.name.includes('_tmp'))).toBe(false);
    expect(m.entries.every((e) => /^[0-9a-f]{64}$/.test(e.sha256))).toBe(true);
  });

  it('restores into an empty location and the restored data is identical', async () => {
    const dir = join(work, 'restore-1');
    const res = await restoreBackup({ archive, passphrase: PASS, databasePath: join(dir, 'db', 'clearport.db'), storageRoot: join(dir, 'storage') });
    expect(res.previous).toEqual([]);
    for (const [k, v] of Object.entries(docs)) expect(readFileSync(join(dir, 'storage', k)).equals(v), k).toBe(true);
    expect(existsSync(join(dir, 'storage', '_tmp'))).toBe(true); // ready for uploads
    expect(readdirSync(join(dir, 'db')).sort()).toEqual(['clearport.db']); // no staging leftovers
    const db = new Database(join(dir, 'db', 'clearport.db'), { readonly: true });
    expect((db.prepare('SELECT COUNT(*) n FROM tenants').get() as any).n).toBe(counts.tenants);
    expect((db.prepare('SELECT COUNT(*) n FROM users').get() as any).n).toBe(counts.users);
    expect((db.prepare('SELECT COUNT(*) n FROM audit_logs').get() as any).n).toBe(counts.audit);
    // integrity triggers survived the round trip
    const triggers = (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get() as any).n;
    const original = new Database(dbPath, { readonly: true });
    expect(triggers).toBe((original.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get() as any).n);
    expect(triggers).toBeGreaterThan(10);
    original.close(); db.close();
  });

  it('boots the application on the restored copy: users can still sign in and see their office', async () => {
    const dir = join(work, 'restore-2');
    await restoreBackup({ archive, passphrase: PASS, databasePath: join(dir, 'clearport.db'), storageRoot: join(dir, 'storage') });
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: `file:${join(dir, 'clearport.db').replace(/\\/g, '/')}`, STORAGE_ROOT: join(dir, 'storage'), JWT_ACCESS_SECRET: JWT_SECRET, RATE_LIMIT_AUTH: '100000', RATE_LIMIT_DEFAULT: '100000' } as NodeJS.ProcessEnv);
    const app = await createApp(env);
    await app.init();
    try {
      const http = supertest(app.getHttpServer());
      const login = await http.post(`/${API_PREFIX}/auth/login`).send({ email: 'owner@bk-a.test', password: PASSWORD });
      expect(login.status).toBe(200);
      const me = await http.get(`/${API_PREFIX}/auth/me`).set('Authorization', `Bearer ${login.body.data.accessToken}`);
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.body)).toContain('bk-a');
    } finally { await app.close(); }
  }, 60_000);

  it('keeps the data consistent when taken while the application is writing', async () => {
    const busy = join(work, 'busy');
    let stop = false;
    const writer = (async () => { while (!stop) { await api.prisma.auditLog.create({ data: { action: 'TEST_NOISE', entityType: 'x', metadata: {} } as any }).catch(() => undefined); await new Promise((r) => setTimeout(r, 2)); } })();
    try {
      const r = await createBackup({ databasePath: dbPath, storageRoot: api.storageRoot, outputDir: busy, passphrase: PASS });
      expect(r.manifest.tables.audit_logs).toBeGreaterThanOrEqual(counts.audit);
      await verifyBackup(r.path, PASS); // passes the integrity and row-count checks
    } finally { stop = true; await writer; }
  }, 60_000);

  describe('refuses to restore anything it cannot trust', () => {
    const target = (n: string) => ({ databasePath: join(work, n, 'db.sqlite'), storageRoot: join(work, n, 'storage') });
    const expectNothingWritten = (n: string) => expect(existsSync(join(work, n, 'db.sqlite')) || existsSync(join(work, n, 'storage'))).toBe(false);

    it('wrong passphrase', async () => {
      await expect(restoreBackup({ archive, passphrase: 'not-the-right-passphrase', ...target('w1') })).rejects.toThrow(/wrong passphrase|damaged/);
      expectNothingWritten('w1');
    });

    it('missing or too short a passphrase', async () => {
      await expect(restoreBackup({ archive, passphrase: undefined, ...target('w2') })).rejects.toThrow(/passphrase/);
      await expect(createBackup({ databasePath: dbPath, storageRoot: api.storageRoot, outputDir: join(work, 'w2'), passphrase: 'short' })).rejects.toThrow(/at least 12/);
    });

    it('a single flipped bit anywhere in the file', async () => {
      const raw = readFileSync(archive);
      for (const at of [10, 40, Math.floor(raw.length / 2), raw.length - 5]) {
        const bad = Buffer.from(raw); bad[at] ^= 1;
        const f = join(work, `bit-${at}.cpbak`); writeFileSync(f, bad);
        await expect(restoreBackup({ archive: f, passphrase: PASS, ...target(`bit${at}`) }), `byte ${at}`).rejects.toBeInstanceOf(BackupError);
        expectNothingWritten(`bit${at}`);
      }
    });

    it('a truncated file', async () => {
      const raw = readFileSync(archive);
      const f = join(work, 'cut.cpbak'); writeFileSync(f, raw.subarray(0, raw.length - 100));
      await expect(restoreBackup({ archive: f, passphrase: PASS, ...target('cut') })).rejects.toBeInstanceOf(BackupError);
      const tiny = join(work, 'tiny.cpbak'); writeFileSync(tiny, 'CPBK1');
      await expect(verifyBackup(tiny, PASS)).rejects.toThrow(/too small/);
      expectNothingWritten('cut');
    });

    it('a file that is not a backup', async () => {
      const f = join(work, 'notes.txt'); writeFileSync(f, 'x'.repeat(500));
      await expect(verifyBackup(f, PASS)).rejects.toThrow(/bad header/);
      await expect(verifyBackup(join(work, 'nope.cpbak'), PASS)).rejects.toThrow(/not found/);
    });
  });

  describe('existing data', () => {
    it('is never overwritten unless asked, and is kept aside when it is', async () => {
      const dir = join(work, 'live');
      const databasePath = join(dir, 'clearport.db'); const storageRoot = join(dir, 'storage');
      mkdirSync(storageRoot, { recursive: true });
      copyFileSync(dbPath, databasePath);
      writeFileSync(join(storageRoot, 'old-document'), 'precious');
      await expect(restoreBackup({ archive, passphrase: PASS, databasePath, storageRoot })).rejects.toThrow(/already contains data/);
      expect(readFileSync(join(storageRoot, 'old-document'), 'utf8')).toBe('precious'); // untouched

      const res = await restoreBackup({ archive, passphrase: PASS, databasePath, storageRoot, overwrite: true });
      expect(res.previous.length).toBe(2);
      const oldStorage = res.previous.find((p) => p.includes('storage'))!;
      expect(readFileSync(join(oldStorage, 'old-document'), 'utf8')).toBe('precious');
      expect(existsSync(join(storageRoot, 'old-document'))).toBe(false);
      expect(readFileSync(join(storageRoot, 'tenants/t1/files/f1/d1/v1-aaa'), 'utf8')).toBe('%PDF-1.4 first document');
    });

    it('a failed restore leaves existing data exactly as it was', async () => {
      const dir = join(work, 'live2');
      const databasePath = join(dir, 'clearport.db'); const storageRoot = join(dir, 'storage');
      mkdirSync(storageRoot, { recursive: true });
      copyFileSync(dbPath, databasePath);
      writeFileSync(join(storageRoot, 'keep-me'), 'data');
      const before = readFileSync(databasePath);
      await expect(restoreBackup({ archive, passphrase: 'wrong-passphrase-here', databasePath, storageRoot, overwrite: true })).rejects.toBeInstanceOf(BackupError);
      expect(readFileSync(databasePath).equals(before)).toBe(true);
      expect(readFileSync(join(storageRoot, 'keep-me'), 'utf8')).toBe('data');
      expect(readdirSync(dir).sort()).toEqual(['clearport.db', 'storage']); // no staging directories left
    });
  });

  it('rejects a corrupted database even when the encryption is valid', async () => {
    // an attacker (or a bug) who knows the passphrase produces a backup whose database is damaged
    const bad = join(work, 'bad-db'); mkdirSync(bad);
    const garbage = join(bad, 'garbage.db'); writeFileSync(garbage, Buffer.alloc(8192, 1));
    await expect(createBackup({ databasePath: garbage, storageRoot: api.storageRoot, outputDir: join(bad, 'out'), passphrase: PASS })).rejects.toThrow();
    expect(existsSync(join(bad, 'out')) ? readdirSync(join(bad, 'out')) : []).toEqual([]); // nothing half-written
  });

  it('keeps only the newest N backups', async () => {
    const d = join(work, 'prune'); mkdirSync(d);
    for (const day of ['01', '02', '03', '04']) writeFileSync(join(d, `clearport-backup-2026-11-${day}T00-00-00-000Z.cpbak`), 'x');
    writeFileSync(join(d, 'notes.txt'), 'keep');
    expect((await pruneBackups(d, 2)).sort()).toEqual(['clearport-backup-2026-11-01T00-00-00-000Z.cpbak', 'clearport-backup-2026-11-02T00-00-00-000Z.cpbak']);
    expect(readdirSync(d).sort()).toEqual(['clearport-backup-2026-11-03T00-00-00-000Z.cpbak', 'clearport-backup-2026-11-04T00-00-00-000Z.cpbak', 'notes.txt']);
  });

  it('parses Prisma file URLs, relative and absolute', () => {
    expect(sqlitePathFromUrl('file:./dev.db', '/app')).toMatch(/app[\\/]dev\.db$/);
    expect(sqlitePathFromUrl('file:/data/x.db?connection_limit=1')).toMatch(/data[\\/]x\.db$/);
    expect(() => sqlitePathFromUrl('postgres://x')).toThrow(/SQLite/);
  });
});

describe('scheduled backup job', () => {
  it('does nothing unless configured, and writes a verifiable backup when it is', async () => {
    const off = await startApi();
    try { expect(await off.app.get(HousekeepingService).backup()).toBeNull(); } finally { await off.close(); }

    const dir = mkdtempSync(join(tmpdir(), 'clearport-nightly-'));
    const on = await startApi({ BACKUP_DIR: dir, BACKUP_PASSPHRASE: PASS, BACKUP_KEEP: '2' });
    try {
      await provision(on, 'nightly');
      const hk = on.app.get(HousekeepingService);
      for (let i = 0; i < 3; i++) { await hk.backup(); await new Promise((r) => setTimeout(r, 15)); }
      const files = readdirSync(dir);
      expect(files).toHaveLength(2); // retention applied
      const m = await verifyBackup(join(dir, files.sort().pop()!), PASS);
      expect(m.tables.tenants).toBeGreaterThanOrEqual(1);
    } finally { await on.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
