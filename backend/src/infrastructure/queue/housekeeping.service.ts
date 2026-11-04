import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { createBackup, pruneBackups, sqlitePathFromUrl } from '../backup/backup';
import { PrismaService } from '../../database/prisma.module';
import { LocalStorageService } from '../storage/local-storage.service';
import { CLEANUP_INTERVAL_MS } from './job-worker.service';
import { JobQueueService } from './job-queue.service';

const DAY = 86_400_000;

export interface CleanupResult {
  doneJobs: number;
  failedJobs: number;
  expiredSessions: number;
  orphanUploads: number;
}

/**
 * Daily housekeeping. Removes only things that carry no business meaning: finished jobs, long-dead
 * login sessions, and upload temp files left behind by a crash. Business and audit records are never touched.
 */
@Injectable()
export class HousekeepingService implements OnModuleInit {
  private readonly log = new Logger(HousekeepingService.name);

  constructor(
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LocalStorageService) private readonly storage: LocalStorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.queue.register('system.backup', async () => {
      try { await this.backup(); } finally { await this.queue.ensurePending('system.backup', {}, new Date(Date.now() + CLEANUP_INTERVAL_MS)); }
    });
    this.queue.register('system.cleanup', async () => {
      const r = await this.run();
      this.log.log(`Housekeeping: ${JSON.stringify(r)}`);
      // schedule the next run (the current job is RUNNING, so nothing is PENDING yet)
      await this.queue.ensurePending('system.cleanup', {}, new Date(Date.now() + CLEANUP_INTERVAL_MS));
    });
  }

  /** Nightly encrypted backup (only when BACKUP_DIR and BACKUP_PASSPHRASE are configured). */
  async backup() {
    const { BACKUP_DIR: dir, BACKUP_PASSPHRASE: passphrase, BACKUP_KEEP: keep, DATABASE_URL } = this.env;
    if (!dir || !passphrase) return null;
    const r = await createBackup({ databasePath: sqlitePathFromUrl(DATABASE_URL), storageRoot: this.storage.root, outputDir: resolve(dir), passphrase });
    await pruneBackups(resolve(dir), keep);
    this.log.log(`Backup written: ${r.path}`);
    return r;
  }

  async run(now = new Date()): Promise<CleanupResult> {
    const db = this.prisma.client;
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const doneJobs = await db.job.deleteMany({ where: { status: 'DONE', updatedAt: { lt: ago(7) } } });
    // FAILED jobs are kept for a month so an operator can see what went wrong
    const failedJobs = await db.job.deleteMany({ where: { status: 'FAILED', updatedAt: { lt: ago(30) } } });
    const sessions = await db.refreshSession.deleteMany({ where: { OR: [{ expiresAt: { lt: ago(7) } }, { revokedAt: { lt: ago(30) } }] } });

    // upload temp files normally vanish within the request; any older than a day belong to a crashed request
    let orphans = 0;
    try {
      for (const name of await readdir(this.storage.tempDir)) {
        const path = join(this.storage.tempDir, name);
        const s = await stat(path).catch(() => null);
        if (s?.isFile() && now.getTime() - s.mtimeMs > DAY) { await unlink(path).catch(() => undefined); orphans++; }
      }
    } catch { /* temp directory not created yet */ }
    return { doneJobs: doneJobs.count, failedJobs: failedJobs.count, expiredSessions: sessions.count, orphanUploads: orphans };
  }
}
