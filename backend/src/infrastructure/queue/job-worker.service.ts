import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { JobQueueService } from './job-queue.service';

export const CLEANUP_INTERVAL_MS = 24 * 3_600_000;

/**
 * Polls the queue and runs due jobs. Runs inside the API process by default (single-node design);
 * set JOB_WORKER=false there and run `npm run worker` as a separate process to isolate it.
 */
@Injectable()
export class JobWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  readonly workerId: string;

  constructor(
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.workerId = queue.newWorkerId();
  }

  async onApplicationBootstrap() {
    if (this.env.JOB_WORKER) await this.start();
  }

  async start() {
    this.stopped = false;
    // keep the daily housekeeping job queued (deduplicated, so restarts never pile them up)
    await this.queue.ensurePending('system.cleanup', {}, new Date(Date.now() + 60_000)).catch((e) => this.log.error(`Could not queue cleanup: ${e.message}`));
    if (this.env.BACKUP_DIR && this.env.BACKUP_PASSPHRASE) {
      await this.queue.ensurePending('system.backup', {}, new Date(Date.now() + 3_600_000)).catch((e) => this.log.error(`Could not queue backup: ${e.message}`));
    }
    this.log.log(`Job worker ${this.workerId} started (poll ${this.env.JOB_POLL_MS} ms)`);
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.(); // never keep the process alive on its own
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.queue.recoverStale(this.env.JOB_LOCK_TIMEOUT_SECONDS * 1000);
      await this.queue.drain(this.workerId);
    } catch (e) {
      this.log.error(`Worker tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
      this.schedule(this.env.JOB_POLL_MS);
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (let i = 0; i < 50 && this.running; i++) await new Promise((r) => setTimeout(r, 100)); // let the current job finish
  }
}
