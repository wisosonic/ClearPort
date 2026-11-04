import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';

/**
 * Encrypted, verifiable backups (spec 18.5) of the two things that make up an office's data:
 * the SQLite database and the document storage directory.
 *
 * File format (".cpbak"):
 *   "CPBK1" | salt(16) | iv(12) | AES-256-GCM ciphertext | auth tag(16)
 * The key is derived from a passphrase with scrypt. Plaintext is a simple container:
 *   repeated entries  [u32 nameLen][name][u64 size][bytes]  — the last entry is "manifest.json"
 * The manifest lists every entry with its SHA-256 and the database's table row counts.
 *
 * GCM authenticates the whole file, so a wrong passphrase or any tampering/truncation fails
 * before anything is restored; checksums then catch anything the container itself got wrong.
 */
const MAGIC = Buffer.from('CPBK1');
const SALT = 16, IV = 12, TAG = 16;
const DB_ENTRY = 'database.sqlite';
const FILE_PREFIX = 'storage/';
const MANIFEST = 'manifest.json';
const FORMAT = 1;

export class BackupError extends Error {}

export interface BackupManifest {
  format: number;
  createdAt: string;
  entries: { name: string; size: number; sha256: string }[];
  tables: Record<string, number>;
  storageFiles: number;
}

export interface BackupResult { path: string; bytes: number; manifest: BackupManifest }

const kdf = (passphrase: string, salt: Buffer) => new Promise<Buffer>((res, rej) =>
  scryptCb(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

function requirePassphrase(p: string | undefined): string {
  if (!p || p.length < 12) throw new BackupError('A backup passphrase of at least 12 characters is required (BACKUP_PASSPHRASE).');
  return p;
}

/** Path of the SQLite file from a Prisma "file:" URL (relative paths resolve against cwd, as the app does). */
export function sqlitePathFromUrl(url: string, cwd = process.cwd()): string {
  if (!url.startsWith('file:')) throw new BackupError('DATABASE_URL must be a SQLite "file:" URL.');
  const p = url.slice(5).split('?')[0];
  return isAbsolute(p) ? p : resolve(cwd, p);
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(path)) h.update(c as Buffer);
  return h.digest('hex');
}

async function* walk(dir: string, base = dir): AsyncGenerator<string> {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) yield* walk(full, base);
    else if (d.isFile()) yield relative(base, full).split(sep).join('/');
  }
}

function inspectDatabase(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    const ic = db.pragma('integrity_check') as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') throw new BackupError(`Database integrity check failed: ${JSON.stringify(ic.slice(0, 3))}`);
    const fk = db.pragma('foreign_key_check') as unknown[];
    if (fk.length) throw new BackupError(`Database has ${fk.length} foreign-key violation(s).`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return Object.fromEntries(tables.map((t) => [t.name, (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

// ───────────────────────────── container I/O ─────────────────────────────

async function writeEntry(out: ReturnType<typeof createWriteStream>, name: string, source: string | Buffer): Promise<{ size: number; sha256: string }> {
  const nameBuf = Buffer.from(name, 'utf8');
  const size = typeof source === 'string' ? (await stat(source)).size : source.length;
  const head = Buffer.alloc(4 + nameBuf.length + 8);
  head.writeUInt32BE(nameBuf.length, 0); nameBuf.copy(head, 4); head.writeBigUInt64BE(BigInt(size), 4 + nameBuf.length);
  const write = (b: Buffer) => new Promise<void>((res, rej) => out.write(b, (e) => (e ? rej(e) : res())));
  await write(head);
  const hash = createHash('sha256');
  if (typeof source === 'string') {
    let written = 0;
    for await (const chunk of createReadStream(source)) { hash.update(chunk as Buffer); written += (chunk as Buffer).length; await write(chunk as Buffer); }
    if (written !== size) throw new BackupError(`File changed while being backed up: ${name}`);
  } else { hash.update(source); await write(source); }
  return { size, sha256: hash.digest('hex') };
}

async function encryptFile(plain: string, dest: string, passphrase: string) {
  const salt = randomBytes(SALT), iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', await kdf(passphrase, salt), iv);
  const out = createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(plain), cipher, out, { end: false });
  await new Promise<void>((res, rej) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? rej(e) : res())));
}

/** Decrypts to `dest`; throws BackupError when the passphrase is wrong or the file was altered or cut short. */
async function decryptFile(src: string, dest: string, passphrase: string) {
  const { size } = await stat(src);
  if (size < MAGIC.length + SALT + IV + TAG) throw new BackupError('Not a ClearPort backup (too small).');
  const fh = await open(src, 'r');
  let header: Buffer, tag: Buffer;
  try {
    header = Buffer.alloc(MAGIC.length + SALT + IV);
    await fh.read(header, 0, header.length, 0);
    tag = Buffer.alloc(TAG);
    await fh.read(tag, 0, TAG, size - TAG);
  } finally { await fh.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('Not a ClearPort backup (bad header).');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = header.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv('aes-256-gcm', await kdf(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(src, { start: header.length, end: size - TAG - 1 }), decipher, createWriteStream(dest, { mode: 0o600 }));
  } catch {
    throw new BackupError('Cannot decrypt: wrong passphrase, or the backup is damaged or has been altered.');
  }
}

interface Extracted { name: string; sha256: string; size: number }

async function extractContainer(plain: string, into: string): Promise<{ entries: Extracted[]; manifest: BackupManifest }> {
  const fh = await open(plain, 'r');
  const total = (await fh.stat()).size;
  const entries: Extracted[] = [];
  let manifest: BackupManifest | null = null;
  let pos = 0;
  try {
    while (pos < total) {
      const h = Buffer.alloc(4);
      if ((await fh.read(h, 0, 4, pos)).bytesRead !== 4) throw new BackupError('Backup container is truncated.');
      const nameLen = h.readUInt32BE(0);
      if (nameLen === 0 || nameLen > 4096) throw new BackupError('Backup container is corrupt.');
      const nameBuf = Buffer.alloc(nameLen + 8);
      if ((await fh.read(nameBuf, 0, nameBuf.length, pos + 4)).bytesRead !== nameBuf.length) throw new BackupError('Backup container is truncated.');
      const name = nameBuf.subarray(0, nameLen).toString('utf8');
      const size = Number(nameBuf.readBigUInt64BE(nameLen));
      const dataPos = pos + 4 + nameLen + 8;
      if (dataPos + size > total) throw new BackupError('Backup container is truncated.');
      pos = dataPos + size;

      if (name === MANIFEST) {
        const b = Buffer.alloc(size);
        await fh.read(b, 0, size, dataPos);
        manifest = JSON.parse(b.toString('utf8'));
        continue;
      }
      // refuse anything that could be written outside the staging directory
      if ((name !== DB_ENTRY && !name.startsWith(FILE_PREFIX)) || name.includes('..') || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.includes('//')) {
        throw new BackupError(`Backup contains an unexpected entry: ${JSON.stringify(name)}`);
      }
      const dest = join(into, ...name.split('/'));
      if (!resolve(dest).startsWith(resolve(into) + sep)) throw new BackupError(`Backup entry escapes the restore directory: ${name}`);
      await mkdir(dirname(dest), { recursive: true });
      const hash = createHash('sha256');
      if (size === 0) await writeFile(dest, '', { flag: 'wx' });
      else await pipeline(
        createReadStream(plain, { start: dataPos, end: dataPos + size - 1 }),
        async function* (src) { for await (const c of src) { hash.update(c as Buffer); yield c; } },
        createWriteStream(dest, { flags: 'wx' }),
      );
      entries.push({ name, sha256: hash.digest('hex'), size });
    }
  } finally { await fh.close(); }
  if (!manifest) throw new BackupError('Backup has no manifest.');
  return { entries, manifest };
}

// ───────────────────────────── public API ─────────────────────────────

export interface BackupOptions {
  databasePath: string;
  storageRoot: string;
  outputDir: string;
  passphrase: string | undefined;
  now?: Date;
}

/** Creates `clearport-backup-<timestamp>.cpbak` in outputDir. Safe to run while the API is serving requests. */
export async function createBackup(o: BackupOptions): Promise<BackupResult> {
  const pass = requirePassphrase(o.passphrase);
  if (!existsSync(o.databasePath)) throw new BackupError(`Database not found: ${o.databasePath}`);
  const now = o.now ?? new Date();
  await mkdir(o.outputDir, { recursive: true });
  const work = await mkdtemp(join(o.outputDir, '.work-'));
  try {
    // 1. consistent online snapshot of the database (works while writers are active, includes the WAL)
    const snap = join(work, DB_ENTRY);
    const src = new Database(o.databasePath, { readonly: true, fileMustExist: true });
    // one step: SQLite restarts a stepwise backup whenever another connection writes, which could starve under load
    try { await src.backup(snap, { progress: () => 1_000_000 }); } finally { src.close(); }
    const tables = inspectDatabase(snap);

    // 2. container: database, every stored document, then the manifest
    const plain = join(work, 'container');
    const out = createWriteStream(plain, { mode: 0o600 });
    const entries: BackupManifest['entries'] = [];
    const add = async (name: string, source: string) => entries.push({ name, ...(await writeEntry(out, name, source)) });
    await add(DB_ENTRY, snap);
    let storageFiles = 0;
    if (existsSync(o.storageRoot)) {
      const files: string[] = [];
      for await (const rel of walk(o.storageRoot)) if (!rel.startsWith('_tmp/')) files.push(rel);
      files.sort();
      for (const rel of files) { await add(FILE_PREFIX + rel, join(o.storageRoot, ...rel.split('/'))); storageFiles++; }
    }
    const manifest: BackupManifest = { format: FORMAT, createdAt: now.toISOString(), entries, tables, storageFiles };
    await writeEntry(out, MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));

    // 3. encrypt, then move into place atomically so a half-written backup never looks complete
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const final = join(o.outputDir, `clearport-backup-${stamp}.cpbak`);
    const tmpOut = join(work, 'out.cpbak');
    await encryptFile(plain, tmpOut, pass);
    await rename(tmpOut, final);
    return { path: final, bytes: (await stat(final)).size, manifest };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  archive: string;
  passphrase: string | undefined;
  databasePath: string;
  storageRoot: string;
  /** Allow replacing an existing database / storage directory (the old ones are kept as *.pre-restore-<ts>). */
  overwrite?: boolean;
  now?: Date;
}

export interface RestoreResult { manifest: BackupManifest; databasePath: string; storageRoot: string; previous: string[] }

/** Verifies everything in a staging area first; only then swaps the data into place. */
export async function restoreBackup(o: RestoreOptions): Promise<RestoreResult> {
  const pass = requirePassphrase(o.passphrase);
  if (!existsSync(o.archive)) throw new BackupError(`Backup not found: ${o.archive}`);
  const storageHasFiles = existsSync(o.storageRoot) && (await readdir(o.storageRoot)).some((n) => n !== '_tmp');
  if (!o.overwrite && (existsSync(o.databasePath) || storageHasFiles)) {
    throw new BackupError('The target already contains data. Restore into an empty location, or pass overwrite (the current data is kept as *.pre-restore-*).');
  }
  const parent = dirname(resolve(o.databasePath));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.restore-'));
  try {
    const plain = join(staging, 'container');
    await decryptFile(o.archive, plain, pass);
    const root = join(staging, 'data');
    await mkdir(root);
    const { entries, manifest } = await extractContainer(plain, root);
    await rm(plain, { force: true });

    // checksums: every listed entry present and identical, nothing extra
    if (manifest.format !== FORMAT) throw new BackupError(`Unsupported backup format ${manifest.format}.`);
    const got = new Map(entries.map((e) => [e.name, e]));
    if (got.size !== entries.length) throw new BackupError('Backup lists an entry twice.');
    for (const m of manifest.entries) {
      const e = got.get(m.name);
      if (!e) throw new BackupError(`Backup is missing ${m.name}.`);
      if (e.sha256 !== m.sha256 || e.size !== m.size) throw new BackupError(`Checksum mismatch for ${m.name}.`);
    }
    if (got.size !== manifest.entries.length || !got.has(DB_ENTRY)) throw new BackupError('Backup contents do not match its manifest.');

    // the database must be healthy and have exactly the recorded contents
    const stagedDb = join(root, DB_ENTRY);
    const tables = inspectDatabase(stagedDb);
    for (const [t, n] of Object.entries(manifest.tables)) if (tables[t] !== n) throw new BackupError(`Table ${t} has ${tables[t]} rows, expected ${n}.`);

    // swap into place
    const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const previous: string[] = [];
    const keep = async (p: string) => { if (existsSync(p)) { const d = `${p}.pre-restore-${stamp}`; await rename(p, d); previous.push(d); } };
    await keep(o.databasePath); await keep(`${o.databasePath}-wal`); await keep(`${o.databasePath}-shm`);
    await mkdir(dirname(resolve(o.storageRoot)), { recursive: true });
    if (storageHasFiles) await keep(o.storageRoot);
    await rename(stagedDb, o.databasePath);
    const stagedStorage = join(root, 'storage');
    if (existsSync(stagedStorage)) {
      if (existsSync(o.storageRoot)) await rm(o.storageRoot, { recursive: true, force: true });
      await rename(stagedStorage, o.storageRoot);
    } else await mkdir(o.storageRoot, { recursive: true });
    await mkdir(join(o.storageRoot, '_tmp'), { recursive: true });
    return { manifest, databasePath: o.databasePath, storageRoot: o.storageRoot, previous };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Decrypts and checks a backup without restoring anything. */
export async function verifyBackup(archive: string, passphrase: string | undefined): Promise<BackupManifest> {
  const pass = requirePassphrase(passphrase);
  if (!existsSync(archive)) throw new BackupError(`Backup not found: ${archive}`);
  const staging = await mkdtemp(join(dirname(resolve(archive)), '.verify-'));
  try {
    const plain = join(staging, 'container');
    await decryptFile(archive, plain, pass);
    const root = join(staging, 'data'); await mkdir(root);
    const { entries, manifest } = await extractContainer(plain, root);
    const got = new Map(entries.map((e) => [e.name, e]));
    for (const m of manifest.entries) {
      const e = got.get(m.name);
      if (!e || e.sha256 !== m.sha256 || e.size !== m.size) throw new BackupError(`Checksum mismatch for ${m.name}.`);
    }
    if (got.size !== manifest.entries.length) throw new BackupError('Backup contents do not match its manifest.');
    const tables = inspectDatabase(join(root, DB_ENTRY));
    for (const [t, n] of Object.entries(manifest.tables)) if (tables[t] !== n) throw new BackupError(`Table ${t} has ${tables[t]} rows, expected ${n}.`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Deletes all but the newest `keep` backups in a directory. Returns what was removed. */
export async function pruneBackups(dir: string, keep: number): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => /^clearport-backup-.*\.cpbak$/.test(n)).sort().reverse();
  const old = names.slice(Math.max(keep, 1));
  for (const n of old) await rm(join(dir, n), { force: true });
  return old;
}
