import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sqlTime } from '../../common/sql-time';
import { PrismaService } from '../../database/prisma.module';
import { runWithTenant } from '../../database/tenant-context';

export interface JobRecord {
  id: string;
  tenantId: string | null;
  type: string;
  payload: Record<string, any>;
  attempts: number;
  maxAttempts: number;
}
export type JobHandler = (job: JobRecord) => Promise<void>;
export type RunResult = 'idle' | 'done' | 'retry' | 'failed';

export interface EnqueueOptions {
  /** null / omitted = a system job (not tied to an office) */
  tenantId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  /** a PENDING or RUNNING job of the same type, tenant and key is reused instead of queueing a duplicate */
  dedupeKey?: string;
}

const DEDUPE_FIELD = '__dedupe';
const MAX_ERROR_LENGTH = 1000;
/** 30 s, 60 s, 2 min, 4 min ... capped at 1 hour. Deterministic, so behaviour is predictable and testable. */
export const backoffMs = (attempt: number) => Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));

/**
 * The background job queue (spec 18.4), stored in SQLite — no Redis. Jobs survive restarts.
 *
 *  - claiming is ONE atomic UPDATE ... RETURNING, so two workers can never take the same job
 *  - a failing job is retried with exponential backoff; after `maxAttempts` it becomes FAILED (dead letter,
 *    visible for an operator) rather than being retried forever
 *  - a worker that dies mid-job leaves it RUNNING: stale locks are returned to the queue
 *  - jobs run INSIDE their office's tenant context; handlers must be idempotent (a job can run twice
 *    if a worker crashes after finishing the work but before marking it done)
 *  - the queue is behind this small interface, so Redis/BullMQ could replace it later
 */
@Injectable()
export class JobQueueService {
  private readonly log = new Logger(JobQueueService.name);
  private readonly handlers = new Map<string, JobHandler>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  registeredTypes() {
    return [...this.handlers.keys()];
  }

  // ───────────────────────────── producing ─────────────────────────────

  async enqueue(type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<string> {
    const db = this.prisma.client;
    const tenantId = opts.tenantId ?? null;
    if (opts.dedupeKey) {
      const open = await db.job.findMany({ where: { type, tenantId, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true, payload: true } });
      const existing = open.find((j) => (j.payload as any)?.[DEDUPE_FIELD] === opts.dedupeKey);
      if (existing) return existing.id;
    }
    const job = await db.job.create({
      data: {
        tenantId, type, payload: { ...payload, ...(opts.dedupeKey ? { [DEDUPE_FIELD]: opts.dedupeKey } : {}) } as any,
        runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5,
      },
    });
    return job.id;
  }

  /** Queues a job only if none of that type is already waiting (PENDING). Used for recurring housekeeping. */
  async ensurePending(type: string, payload: Record<string, unknown>, runAt: Date, tenantId: string | null = null): Promise<string> {
    const waiting = await this.prisma.client.job.findFirst({ where: { type, tenantId, status: 'PENDING' }, select: { id: true } });
    return waiting ? waiting.id : this.enqueue(type, payload, { tenantId, runAt });
  }

  // ───────────────────────────── consuming ─────────────────────────────

  /** Atomically takes the oldest due job. Returns null when nothing is due. */
  async claimNext(workerId: string, now = new Date()): Promise<JobRecord | null> {
    const ts = sqlTime(now);
    const rows = await this.prisma.client.$queryRaw<{ id: string; tenantId: string | null; type: string; payload: string; attempts: number | bigint; maxAttempts: number | bigint }[]>`
      UPDATE jobs SET status = 'RUNNING', lockedAt = ${ts}, lockedBy = ${workerId}, attempts = attempts + 1, updatedAt = ${ts}
      WHERE id = (SELECT id FROM jobs WHERE status = 'PENDING' AND runAt <= ${ts} ORDER BY runAt ASC, createdAt ASC LIMIT 1)
      RETURNING id, tenantId, type, payload, attempts, maxAttempts`;
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, tenantId: r.tenantId, type: r.type, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload as any), attempts: Number(r.attempts), maxAttempts: Number(r.maxAttempts) };
  }

  /** Returns jobs whose worker vanished (locked longer than the timeout) to the queue, or fails them if out of attempts. */
  async recoverStale(lockTimeoutMs: number, now = new Date()): Promise<number> {
    const cutoff = sqlTime(new Date(now.getTime() - lockTimeoutMs));
    const ts = sqlTime(now);
    const retry = await this.prisma.client.$executeRaw`
      UPDATE jobs SET status = 'PENDING', lockedAt = NULL, lockedBy = NULL, runAt = ${ts}, lastError = 'worker lost (lock expired)', updatedAt = ${ts}
      WHERE status = 'RUNNING' AND lockedAt < ${cutoff} AND attempts < maxAttempts`;
    const dead = await this.prisma.client.$executeRaw`
      UPDATE jobs SET status = 'FAILED', lockedAt = NULL, lockedBy = NULL, lastError = 'worker lost (lock expired); attempts exhausted', updatedAt = ${ts}
      WHERE status = 'RUNNING' AND lockedAt < ${cutoff} AND attempts >= maxAttempts`;
    return Number(retry) + Number(dead);
  }

  private async complete(id: string) {
    await this.prisma.client.job.update({ where: { id }, data: { status: 'DONE', lockedAt: null, lockedBy: null, lastError: null } });
  }

  private async fail(job: JobRecord, error: unknown, now: Date): Promise<'retry' | 'failed'> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
    const exhausted = job.attempts >= job.maxAttempts;
    await this.prisma.client.job.update({
      where: { id: job.id },
      data: exhausted
        ? { status: 'FAILED', lockedAt: null, lockedBy: null, lastError: message }
        : { status: 'PENDING', lockedAt: null, lockedBy: null, lastError: message, runAt: new Date(now.getTime() + backoffMs(job.attempts)) },
    });
    return exhausted ? 'failed' : 'retry';
  }

  /** Claims and runs at most one job. */
  async runOnce(workerId: string, now = new Date()): Promise<RunResult> {
    const job = await this.claimNext(workerId, now);
    if (!job) return 'idle';
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type "${job.type}"`);
      // Office jobs run inside that office's tenant context, exactly like a request would.
      if (job.tenantId) await runWithTenant({ tenantId: job.tenantId }, () => handler(job));
      else await handler(job);
      await this.complete(job.id);
      return 'done';
    } catch (e) {
      this.log.warn(`Job ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${(e as Error).message}`);
      return this.fail(job, e, now);
    }
  }

  /** Runs every currently-due job (used by tests and by the worker's drain loop). */
  async drain(workerId: string, now = new Date(), max = 1000): Promise<Record<RunResult, number>> {
    const counts: Record<RunResult, number> = { idle: 0, done: 0, retry: 0, failed: 0 };
    for (let i = 0; i < max; i++) {
      const r = await this.runOnce(workerId, now);
      if (r === 'idle') break;
      counts[r]++;
    }
    return counts;
  }

  /** Counts by status, for monitoring. */
  async stats() {
    const rows = await this.prisma.client.job.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all])) as Record<string, number>;
  }

  newWorkerId() {
    return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
}
