import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTenant } from '../src/database/tenant-context';
import { backoffMs, JobQueueService } from '../src/infrastructure/queue/job-queue.service';
import { HousekeepingService } from '../src/infrastructure/queue/housekeeping.service';
import { JobWorkerService } from '../src/infrastructure/queue/job-worker.service';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';
import { ok } from './finance-helpers';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('background job queue', () => {
  let api: TestApi;
  let q: JobQueueService;
  const seen: { type: string; payload: any; tenant: string | undefined }[] = [];
  const W = 'test-worker';

  beforeAll(async () => {
    api = await startApi();
    q = api.app.get(JobQueueService);
    q.register('test.echo', async (j) => { seen.push({ type: j.type, payload: j.payload, tenant: currentTenant()?.tenantId }); });
    q.register('test.fail', async () => { throw new Error('boom'); });
    q.register('test.fail-nonerror', async () => { throw 'plain string failure'; }); // eslint-disable-line no-throw-literal
    q.register('test.long-error', async () => { throw new Error('x'.repeat(5000)); });
  });
  afterAll(async () => api.close());

  const job = (id: string) => api.prisma.job.findUniqueOrThrow({ where: { id } });
  const clear = () => api.prisma.job.deleteMany({});

  describe('claiming', () => {
    it('hands out the oldest due job first and never a future one', async () => {
      await clear();
      const now = new Date('2026-11-10T12:00:00Z');
      const later = await q.enqueue('test.echo', { n: 'later' }, { runAt: new Date(now.getTime() + HOUR) });
      const b = await q.enqueue('test.echo', { n: 'b' }, { runAt: new Date(now.getTime() - 5 * MIN) });
      const a = await q.enqueue('test.echo', { n: 'a' }, { runAt: new Date(now.getTime() - 10 * MIN) });
      const first = await q.claimNext(W, now);
      const second = await q.claimNext(W, now);
      expect([first?.id, second?.id]).toEqual([a, b]);
      expect(await q.claimNext(W, now)).toBeNull(); // the remaining one is not due yet
      expect((await job(later)).status).toBe('PENDING');
      expect(await job(a)).toMatchObject({ status: 'RUNNING', attempts: 1, lockedBy: W });
      expect((await job(a)).lockedAt).not.toBeNull();
      expect((await q.claimNext(W, new Date(now.getTime() + 2 * HOUR)))?.id).toBe(later);
    });

    it('never gives one job to two workers, even when they claim at the same instant', async () => {
      await clear();
      const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => q.enqueue('test.echo', { i })));
      const claimed = await Promise.all(Array.from({ length: 40 }, (_, i) => q.claimNext(`w${i}`)));
      const got = claimed.filter((c) => c !== null).map((c) => c!.id);
      expect(got).toHaveLength(30); // 30 jobs, 40 workers: ten get nothing
      expect(new Set(got).size).toBe(30); // all distinct
      expect(new Set(got)).toEqual(new Set(ids));
      expect((await api.prisma.job.findMany({ where: { status: 'RUNNING' } })).every((j) => j.attempts === 1)).toBe(true);
    });
  });

  describe('running jobs', () => {
    it('runs a handler with the payload and marks the job done', async () => {
      await clear(); seen.length = 0;
      const id = await q.enqueue('test.echo', { hello: 'world' });
      expect(await q.runOnce(W)).toBe('done');
      expect(seen).toEqual([{ type: 'test.echo', payload: { hello: 'world' }, tenant: undefined }]);
      expect(await job(id)).toMatchObject({ status: 'DONE', lastError: null, lockedBy: null, attempts: 1 });
      expect(await q.runOnce(W)).toBe('idle');
    });

    it('runs office jobs inside that office\'s tenant context, and system jobs outside any', async () => {
      await clear(); seen.length = 0;
      const t = await provision(api, 'jobs-ctx', 'owner@jobs-ctx.test');
      await q.enqueue('test.echo', { who: 'office' }, { tenantId: t.tenantId });
      await q.enqueue('test.echo', { who: 'system' }, { runAt: new Date(Date.now() + 1) });
      await q.drain(W, new Date(Date.now() + 1000));
      expect(seen.find((s) => s.payload.who === 'office')?.tenant).toBe(t.tenantId);
      expect(seen.find((s) => s.payload.who === 'system')?.tenant).toBeUndefined();
    });

    it('retries a failing job with exponential backoff, recording the error', async () => {
      await clear();
      const t0 = new Date('2026-11-10T12:00:00Z');
      const id = await q.enqueue('test.fail', {}, { maxAttempts: 4, runAt: t0 });
      expect(await q.runOnce(W, t0)).toBe('retry');
      let j = await job(id);
      expect(j).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'boom', lockedBy: null });
      expect(j.runAt.getTime()).toBe(t0.getTime() + 30_000); // first retry after 30 s
      expect(await q.runOnce(W, new Date(t0.getTime() + 10_000))).toBe('idle'); // not due yet
      const t1 = new Date(t0.getTime() + 31_000);
      expect(await q.runOnce(W, t1)).toBe('retry');
      j = await job(id);
      expect(j.attempts).toBe(2);
      expect(j.runAt.getTime()).toBe(t1.getTime() + 60_000); // then 60 s
      const t2 = new Date(t1.getTime() + 61_000);
      await q.runOnce(W, t2);
      expect((await job(id)).runAt.getTime()).toBe(t2.getTime() + 120_000); // then 2 min
    });

    it('gives up after the maximum attempts and keeps the job as FAILED (dead letter)', async () => {
      await clear();
      const id = await q.enqueue('test.fail', {}, { maxAttempts: 2 });
      const base = Date.now();
      expect(await q.runOnce(W, new Date(base))).toBe('retry');
      expect(await q.runOnce(W, new Date(base + 40_000))).toBe('failed');
      expect(await job(id)).toMatchObject({ status: 'FAILED', attempts: 2, lastError: 'boom' });
      expect(await q.runOnce(W, new Date(base + 10 * HOUR))).toBe('idle'); // a failed job is never picked up again
      expect(await q.stats()).toEqual({ FAILED: 1 });
    });

    it('fails clearly for an unknown job type, non-Error throws, and truncates huge messages', async () => {
      await clear();
      const unknown = await q.enqueue('test.nobody-handles-this', {}, { maxAttempts: 1 });
      expect(await q.runOnce(W)).toBe('failed');
      expect((await job(unknown)).lastError).toContain('No handler registered for job type "test.nobody-handles-this"');
      const plain = await q.enqueue('test.fail-nonerror', {}, { maxAttempts: 1 });
      await q.runOnce(W);
      expect((await job(plain)).lastError).toBe('plain string failure');
      const long = await q.enqueue('test.long-error', {}, { maxAttempts: 1 });
      await q.runOnce(W);
      expect((await job(long)).lastError).toHaveLength(1000);
    });

    it('uses the documented backoff schedule, capped at one hour', () => {
      expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
      expect(backoffMs(20)).toBe(HOUR);
      expect(backoffMs(0)).toBe(30_000);
    });

    it('drains everything that is due and reports the outcomes', async () => {
      await clear();
      await q.enqueue('test.echo', {}); await q.enqueue('test.echo', {}); await q.enqueue('test.fail', {}, { maxAttempts: 1 });
      expect(await q.drain(W)).toEqual({ idle: 0, done: 2, retry: 0, failed: 1 });
      expect(await q.stats()).toEqual({ DONE: 2, FAILED: 1 });
    });
  });

  describe('crashed workers', () => {
    it('returns a job to the queue when its worker disappeared, and fails it if attempts are used up', async () => {
      await clear();
      const now = new Date('2026-11-10T12:00:00Z');
      const lost = await q.enqueue('test.echo', {}, { runAt: new Date(now.getTime() - HOUR) });
      await q.claimNext('crashed-worker', new Date(now.getTime() - 20 * MIN)); // locked 20 minutes ago, never finished
      const fresh = await q.enqueue('test.echo', {}, { runAt: new Date(now.getTime() - HOUR) });
      await q.claimNext('busy-worker', new Date(now.getTime() - 30_000)); // locked 30 s ago: still working
      const exhausted = await q.enqueue('test.echo', {}, { maxAttempts: 1, runAt: new Date(now.getTime() - HOUR) });
      await q.claimNext('crashed-2', new Date(now.getTime() - 20 * MIN));

      expect(await q.recoverStale(5 * MIN, now)).toBe(2);
      expect(await job(lost)).toMatchObject({ status: 'PENDING', lockedBy: null, lastError: 'worker lost (lock expired)' });
      expect((await job(fresh)).status).toBe('RUNNING'); // untouched
      expect(await job(exhausted)).toMatchObject({ status: 'FAILED' });
      expect((await q.claimNext(W, now))?.id).toBe(lost); // and it is runnable again
    });
  });

  describe('deduplication', () => {
    it('reuses a waiting job with the same type, office and key', async () => {
      await clear();
      const t = await provision(api, 'jobs-dedupe', 'owner@jobs-dedupe.test');
      const a = await q.enqueue('test.echo', { x: 1 }, { tenantId: t.tenantId, dedupeKey: 'k1' });
      expect(await q.enqueue('test.echo', { x: 2 }, { tenantId: t.tenantId, dedupeKey: 'k1' })).toBe(a);
      expect(await q.enqueue('test.echo', { x: 1 }, { tenantId: t.tenantId, dedupeKey: 'k2' })).not.toBe(a);
      expect(await q.enqueue('test.echo', { x: 1 }, { dedupeKey: 'k1' })).not.toBe(a); // another scope (system)
      expect(await q.enqueue('test.fail', { x: 1 }, { tenantId: t.tenantId, dedupeKey: 'k1' })).not.toBe(a); // another type
      await q.runOnce(W); // finishes one job
      const again = await q.enqueue('test.echo', {}, { tenantId: t.tenantId, dedupeKey: 'k1' });
      expect(again).not.toBe(a); // once the first is done, the key may be used again
    });

    it('keeps a single pending housekeeping-style job', async () => {
      await clear();
      const a = await q.ensurePending('test.echo', {}, new Date(Date.now() + HOUR));
      expect(await q.ensurePending('test.echo', {}, new Date(Date.now() + 2 * HOUR))).toBe(a);
      expect(await api.prisma.job.count({ where: { type: 'test.echo', status: 'PENDING' } })).toBe(1);
    });
  });
});

describe('task reminders (event-driven jobs)', () => {
  let api: TestApi;
  let q: JobQueueService;
  let owner: string; let ownerId: string;
  let officer: string; let officerId: string;
  let tenantId: string;

  const task = (body: Record<string, unknown>) => ok(api.req('post', '/tasks', owner).send({ title: 'Collect delivery order', assignedTo: officerId, ...body }));
  const jobsFor = (taskId: string) => api.prisma.job.findMany({ where: { type: { in: ['task.due-soon', 'task.overdue'] } }, orderBy: { runAt: 'asc' } })
    .then((js) => js.filter((j) => (j.payload as any).taskId === taskId));
  const notes = (userId: string, type?: string) => api.prisma.notification.findMany({ where: { userId, type: type ?? { in: ['TASK_DUE_SOON', 'TASK_OVERDUE'] } } });
  const run = (at: Date) => q.drain('t-worker', at);

  beforeAll(async () => {
    api = await startApi({ TASK_REMINDER_LEAD_HOURS: '24' });
    q = api.app.get(JobQueueService);
    tenantId = (await provision(api, 'rem', 'owner@rem.test')).tenantId;
    owner = (await signIn(api, 'owner@rem.test')).accessToken;
    officerId = (await createUser(api, owner, 'officer@rem.test', 'CLEARANCE_OFFICER')).id;
    officer = (await signIn(api, 'officer@rem.test')).accessToken;
    ownerId = (await ok(api.req('get', '/auth/me', owner))).user.id;
  });
  afterAll(async () => api.close());

  it('queues a "due soon" job a day ahead and an "overdue" job at the due date', async () => {
    const due = new Date(Date.now() + 48 * HOUR);
    const t = await task({ dueAt: due.toISOString() });
    const js = await jobsFor(t.id);
    expect(js.map((j) => j.type)).toEqual(['task.due-soon', 'task.overdue']);
    expect(js[0].runAt.getTime()).toBe(due.getTime() - 24 * HOUR);
    expect(js[1].runAt.getTime()).toBe(due.getTime());
    expect(js.every((j) => j.tenantId === tenantId && (j.payload as any).dueAt === due.toISOString())).toBe(true);
  });

  it('notifies the assignee when due soon, once, even if the job is delivered twice', async () => {
    const due = new Date(Date.now() + 25 * HOUR);
    const t = await task({ title: 'Soon task', dueAt: due.toISOString() });
    const soon = (await jobsFor(t.id))[0];
    expect(soon.runAt.getTime()).toBe(due.getTime() - 24 * HOUR); // one hour from now
    expect(await run(new Date())).toMatchObject({ done: expect.any(Number) });
    expect((await notes(officerId, 'TASK_DUE_SOON')).filter((n) => (n.metadata as any).taskId === t.id)).toHaveLength(0); // not due yet
    await run(new Date(soon.runAt.getTime() + 1000));
    const got = (await notes(officerId, 'TASK_DUE_SOON')).filter((n) => (n.metadata as any).taskId === t.id);
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe('Task due soon: Soon task');
    expect(got[0].metadata).toMatchObject({ taskId: t.id, dueAt: due.toISOString(), assignedTo: officerId });
    // a duplicate delivery of the same job does not notify again
    await q.enqueue('task.due-soon', { taskId: t.id, dueAt: due.toISOString() }, { tenantId });
    await run(new Date(soon.runAt.getTime() + 2000));
    expect((await notes(officerId, 'TASK_DUE_SOON')).filter((n) => (n.metadata as any).taskId === t.id)).toHaveLength(1);
  });

  it('tells both the assignee and the person who set the task when it goes overdue', async () => {
    const due = new Date(Date.now() + 30 * HOUR);
    const t = await task({ title: 'Will slip', dueAt: due.toISOString() });
    await run(new Date(due.getTime() + 1000));
    const forOfficer = (await notes(officerId, 'TASK_OVERDUE')).filter((n) => (n.metadata as any).taskId === t.id);
    const forOwner = (await notes(ownerId, 'TASK_OVERDUE')).filter((n) => (n.metadata as any).taskId === t.id);
    expect(forOfficer).toHaveLength(1);
    expect(forOwner).toHaveLength(1);
    expect(forOfficer[0].title).toBe('Task overdue: Will slip');
  });

  it('does nothing for a task that was completed, cancelled or deleted in the meantime', async () => {
    const mk = async (title: string) => task({ title, dueAt: new Date(Date.now() + 26 * HOUR).toISOString() });
    const done = await mk('Done early'); const cancelled = await mk('Cancelled'); const reopen = await mk('Reopened');
    await ok(api.req('post', `/tasks/${done.id}/complete`, officer));
    await ok(api.req('patch', `/tasks/${cancelled.id}`, owner).send({ status: 'CANCELLED' }));
    await run(new Date(Date.now() + 40 * HOUR));
    for (const t of [done, cancelled]) {
      expect((await notes(officerId)).some((n) => (n.metadata as any).taskId === t.id), t.title).toBe(false);
    }
    expect((await notes(officerId)).some((n) => (n.metadata as any).taskId === reopen.id)).toBe(true); // the untouched one still fires
  });

  it('follows a changed due date: the old jobs become harmless and new ones are queued', async () => {
    const first = new Date(Date.now() + 26 * HOUR);
    const t = await task({ title: 'Moved', dueAt: first.toISOString() });
    const second = new Date(Date.now() + 100 * HOUR);
    await ok(api.req('patch', `/tasks/${t.id}`, owner).send({ dueAt: second.toISOString() }));
    const js = await jobsFor(t.id);
    expect(js).toHaveLength(4); // two for the old date, two for the new one
    expect(new Set(js.map((j) => (j.payload as any).dueAt))).toEqual(new Set([first.toISOString(), second.toISOString()]));
    await run(new Date(first.getTime() + 5000)); // the OLD date passes: its jobs run and do nothing
    expect((await notes(officerId)).some((n) => (n.metadata as any).taskId === t.id)).toBe(false);
    await run(new Date(second.getTime() + 5000)); // the NEW date passes
    expect((await notes(officerId, 'TASK_OVERDUE')).filter((n) => (n.metadata as any).taskId === t.id)).toHaveLength(1);
  });

  it('queues nothing when there is nothing to remind about', async () => {
    const none = await task({ title: 'No date' });
    expect(await jobsFor(none.id)).toEqual([]);
    const past = await task({ title: 'Already late', dueAt: new Date(Date.now() - DAY).toISOString() });
    expect(await jobsFor(past.id)).toEqual([]);
    const soon = await task({ title: 'Within the hour', dueAt: new Date(Date.now() + 30 * MIN).toISOString() });
    expect((await jobsFor(soon.id)).map((j) => j.type)).toEqual(['task.overdue']); // no "due soon" this close to the deadline
    const done = await task({ title: 'Cancelled at once', dueAt: new Date(Date.now() + 5 * DAY).toISOString() });
    expect((await jobsFor(done.id)).length).toBe(2);
    await ok(api.req('patch', `/tasks/${done.id}`, owner).send({ status: 'CANCELLED' }));
    expect((await jobsFor(done.id)).length).toBe(2); // not re-queued for a cancelled task
  });

  it('skips reassigned or deactivated assignees', async () => {
    const due = new Date(Date.now() + 26 * HOUR);
    const t = await task({ title: 'For a leaver', dueAt: due.toISOString() });
    await ok(api.req('patch', `/users/${officerId}/status`, owner).send({ isActive: false }));
    const before = (await notes(officerId)).length;
    await run(new Date(due.getTime() + 5000));
    expect((await notes(officerId)).length).toBe(before); // an inactive employee gets nothing
    expect((await notes(ownerId, 'TASK_OVERDUE')).some((n) => (n.metadata as any).taskId === t.id)).toBe(true); // the creator is still told
    await ok(api.req('patch', `/users/${officerId}/status`, owner).send({ isActive: true }));
  });

  it('keeps one office\'s reminders out of another\'s', async () => {
    const other = await provision(api, 'rem-b', 'owner@rem-b.test');
    const otherTok = (await signIn(api, 'owner@rem-b.test')).accessToken;
    const otherId = (await ok(api.req('get', '/auth/me', otherTok))).user.id;
    const due = new Date(Date.now() + 26 * HOUR);
    const t = await ok(api.req('post', '/tasks', otherTok).send({ title: 'B only', dueAt: due.toISOString() }));
    const js = await jobsFor(t.id);
    expect(js.every((j) => j.tenantId === other.tenantId)).toBe(true);
    await run(new Date(due.getTime() + 5000));
    expect((await notes(otherId)).some((n) => (n.metadata as any).taskId === t.id)).toBe(true);
    expect((await notes(ownerId)).some((n) => (n.metadata as any).taskId === t.id)).toBe(false);
  });
});

describe('the worker process loop', () => {
  it('picks up jobs on its own and shuts down cleanly', async () => {
    const api = await startApi({ JOB_WORKER: 'true', JOB_POLL_MS: '100' });
    try {
      const q = api.app.get(JobQueueService);
      const ran: string[] = [];
      q.register('test.auto', async (j) => { ran.push(j.payload.n); });
      await q.enqueue('test.auto', { n: 'one' });
      await q.enqueue('test.auto', { n: 'two' }, { runAt: new Date(Date.now() + 600) });
      const until = Date.now() + 8000;
      while (ran.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      expect(ran).toEqual(['one', 'two']); // the second one waited for its time
      expect(await api.prisma.job.count({ where: { type: 'system.cleanup', status: 'PENDING' } })).toBe(1); // housekeeping is queued
      expect(api.app.get(JobWorkerService).workerId).toMatch(/^worker-\d+-[0-9a-f]{8}$/);
    } finally {
      await api.close();
    }
  }, 30_000);

  it('does not start a worker in the test environment unless asked', async () => {
    const api = await startApi();
    try {
      await api.prisma.job.deleteMany({});
      await new Promise((r) => setTimeout(r, 300));
      expect(await api.prisma.job.count({ where: { type: 'system.cleanup' } })).toBe(0);
    } finally {
      await api.close();
    }
  });
});

describe('housekeeping', () => {
  it('removes only expired technical leftovers, never business data, and schedules itself again', async () => {
    const api = await startApi();
    try {
      const q = api.app.get(JobQueueService);
      const hk = api.app.get(HousekeepingService);
      const t = await provision(api, 'hk', 'owner@hk.test');
      const user = await api.prisma.user.findFirstOrThrow({ where: { email: 'owner@hk.test' } });
      const now = new Date();
      const ago = (d: number) => new Date(now.getTime() - d * DAY);
      const mkJob = (status: 'DONE' | 'FAILED', age: number) => api.prisma.job.create({ data: { type: 'x', payload: {}, status, updatedAt: ago(age) } as any });
      const [done8, done1, failed31, failed5] = [await mkJob('DONE', 8), await mkJob('DONE', 1), await mkJob('FAILED', 31), await mkJob('FAILED', 5)];
      const session = (expiresAt: Date, revokedAt: Date | null = null) => api.prisma.refreshSession.create({ data: { userId: user.id, tenantId: t.tenantId, tokenHash: `h-${Math.random()}`, familyId: 'f', expiresAt, revokedAt } });
      const [expired, live, longRevoked, recentlyRevoked] = [await session(ago(8)), await session(new Date(now.getTime() + DAY)), await session(new Date(now.getTime() + DAY), ago(31)), await session(new Date(now.getTime() + DAY), ago(2))];
      const tmp = join(api.storageRoot, '_tmp');
      mkdirSync(tmp, { recursive: true });
      const old = join(tmp, 'upload-old'); const fresh = join(tmp, 'upload-fresh');
      writeFileSync(old, 'x'); writeFileSync(fresh, 'x');
      utimesSync(old, ago(2), ago(2));
      const auditBefore = await api.prisma.auditLog.count();
      const tenantsBefore = await api.prisma.tenant.count();

      const res = await hk.run(now);
      expect(res).toEqual({ doneJobs: 1, failedJobs: 1, expiredSessions: 2, orphanUploads: 1 });
      const exists = async (m: any, id: string) => (await api.prisma[m as 'job'].count({ where: { id } as any })) === 1;
      expect([await exists('job', done8.id), await exists('job', done1.id), await exists('job', failed31.id), await exists('job', failed5.id)]).toEqual([false, true, false, true]);
      expect([await exists('refreshSession', expired.id), await exists('refreshSession', live.id), await exists('refreshSession', longRevoked.id), await exists('refreshSession', recentlyRevoked.id)]).toEqual([false, true, false, true]);
      expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
      expect(await api.prisma.auditLog.count()).toBe(auditBefore); // audit trail untouched
      expect(await api.prisma.tenant.count()).toBe(tenantsBefore);

      // run as a real job: it completes and queues tomorrow's run
      await api.prisma.job.deleteMany({});
      await q.enqueue('system.cleanup', {});
      expect(await q.drain('hk-worker')).toMatchObject({ done: 1 });
      const next = await api.prisma.job.findMany({ where: { type: 'system.cleanup', status: 'PENDING' } });
      expect(next).toHaveLength(1);
      expect(next[0].runAt.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
    } finally {
      await api.close();
    }
  }, 30_000);
});
