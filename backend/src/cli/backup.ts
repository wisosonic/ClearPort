import 'dotenv/config';
import { resolve } from 'node:path';
import { BackupError, createBackup, pruneBackups, restoreBackup, sqlitePathFromUrl, verifyBackup } from '../infrastructure/backup/backup';

const USAGE = `ClearPort backup tool

  npm run backup -- create [--out <dir>]
  npm run backup -- verify <file.cpbak>
  npm run backup -- restore <file.cpbak> [--overwrite]

The passphrase is read from BACKUP_PASSPHRASE. Stop the API and worker before restoring.`;

const flag = (a: string[], n: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const passphrase = process.env.BACKUP_PASSPHRASE;
  const databasePath = sqlitePathFromUrl(process.env.DATABASE_URL ?? 'file:./dev.db');
  const storageRoot = resolve(process.env.STORAGE_ROOT ?? './storage');
  if (cmd === 'create') {
    const outputDir = resolve(flag(rest, '--out') ?? process.env.BACKUP_DIR ?? './backups');
    const r = await createBackup({ databasePath, storageRoot, outputDir, passphrase });
    const removed = await pruneBackups(outputDir, Number(process.env.BACKUP_KEEP ?? 14));
    console.log(`Backup written: ${r.path} (${(r.bytes / 1024).toFixed(1)} KiB, ${r.manifest.storageFiles} document file(s))`);
    if (removed.length) console.log(`Removed ${removed.length} old backup(s).`);
  } else if (cmd === 'verify' && rest[0]) {
    const m = await verifyBackup(resolve(rest[0]), passphrase);
    console.log(`OK — backup from ${m.createdAt}: ${Object.keys(m.tables).length} tables, ${m.storageFiles} document file(s), all checksums match.`);
  } else if (cmd === 'restore' && rest[0]) {
    const r = await restoreBackup({ archive: resolve(rest[0]), passphrase, databasePath, storageRoot, overwrite: rest.includes('--overwrite') });
    console.log(`Restored backup from ${r.manifest.createdAt} into ${r.databasePath} and ${r.storageRoot}.`);
    for (const p of r.previous) console.log(`Previous data kept at: ${p}`);
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e instanceof BackupError ? `Error: ${e.message}` : e); process.exit(1); });
