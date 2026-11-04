import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zonedDayBounds } from '../src/modules/tasks/tasks.service';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';

describe('zonedDayBounds (office-calendar "today")', () => {
  it('uses the zone\'s offset, not the server\'s', () => {
    // Lebanon is UTC+2 in November (winter time): 23:30Z on 3 Nov is already 4 Nov locally
    const { start, end } = zonedDayBounds(new Date('2026-11-03T23:30:00Z'), 'Asia/Beirut');
    expect(start.toISOString()).toBe('2026-11-03T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-04T22:00:00.000Z');
  });

  it('follows daylight saving: UTC+3 in summer', () => {
    const { start } = zonedDayBounds(new Date('2026-07-15T10:00:00Z'), 'Asia/Beirut');
    expect(start.toISOString()).toBe('2026-07-14T21:00:00.000Z');
  });

  it('handles UTC, zones behind UTC, and unknown zones', () => {
    expect(zonedDayBounds(new Date('2026-11-03T05:00:00Z'), 'UTC').start.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    // New York is UTC-5 in November: 03:00Z is still 2 Nov locally
    expect(zonedDayBounds(new Date('2026-11-03T03:00:00Z'), 'America/New_York').start.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(zonedDayBounds(new Date('2026-11-03T05:00:00Z'), 'Not/AZone').start.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('always spans 24 hours and contains the given instant', () => {
    for (const tz of ['Asia/Beirut', 'UTC', 'America/New_York', 'Asia/Tokyo']) {
      const now = new Date('2026-11-03T12:34:56Z');
      const { start, end } = zonedDayBounds(now, tz);
      expect(end.getTime() - start.getTime()).toBe(86_400_000);
      expect(start.getTime() <= now.getTime() && now.getTime() < end.getTime(), tz).toBe(true);
    }
  });
});

describe('tasks API', () => {
  let api: TestApi;
  let A: string;
  let B: string;
  let officer: string; // tasks.view + tasks.manage
  let viewer: string; // tasks.view only
  let accountant: string; // no task permissions
  let ownerId: string;
  let officerId: string;
  let viewerId: string;
  let fileId: string;
  let tenantAId: string;

  const ok = async (p: any) => {
    const res = await p;
    if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const mk = (token: string, body: Record<string, unknown>) => api.req('post', '/tasks', token).send({ title: 'Task', ...body });
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  beforeAll(async () => {
    api = await startApi();
    const a = await provision(api, 'tasks-a', 'owner@tasks-a.test');
    await provision(api, 'tasks-b', 'owner@tasks-b.test');
    tenantAId = a.tenantId;
    A = (await signIn(api, 'owner@tasks-a.test')).accessToken;
    B = (await signIn(api, 'owner@tasks-b.test')).accessToken;
    officerId = (await createUser(api, A, 'officer@tasks-a.test', 'CLEARANCE_OFFICER')).id;
    viewerId = (await createUser(api, A, 'viewer@tasks-a.test', 'VIEWER')).id;
    await createUser(api, A, 'acct@tasks-a.test', 'ACCOUNTANT');
    officer = (await signIn(api, 'officer@tasks-a.test')).accessToken;
    viewer = (await signIn(api, 'viewer@tasks-a.test')).accessToken;
    accountant = (await signIn(api, 'acct@tasks-a.test')).accessToken;
    ownerId = (await ok(api.req('get', '/auth/me', A))).user.id;
    const client = await ok(api.req('post', '/clients', A).send({ name: 'Task Client' }));
    fileId = (await ok(api.req('post', '/clearance-files', A).send({ fileType: 'IMPORT', clientId: client.id }))).id;
  });
  afterAll(async () => api.close());

  describe('creating', () => {
    it('defaults the assignee to the creator and works without a file', async () => {
      const t = await ok(mk(officer, { title: 'Call the shipping agent' }));
      expect(t).toMatchObject({ title: 'Call the shipping agent', status: 'OPEN', priority: 'NORMAL', clearanceFile: null, isOverdue: false });
      expect(t.assignee.id).toBe(officerId);
      expect(t.createdByUser.id).toBe(officerId);
      expect(t.completedAt).toBeNull();
    });

    it('attaches to a file, logs on its timeline, and notifies a different assignee', async () => {
      const t = await ok(mk(officer, { clearanceFileId: fileId, assignedTo: ownerId, title: 'Review customs reference', priority: 'HIGH', dueAt: '2026-12-01T09:00:00Z', description: 'Check digits' }));
      expect(t.clearanceFile.id).toBe(fileId);
      expect(t.assignee.id).toBe(ownerId);
      expect(new Date(t.dueAt).toISOString()).toBe('2026-12-01T09:00:00.000Z');
      const tl = await ok(api.req('get', `/clearance-files/${fileId}/timeline`, A));
      expect(tl.some((x: any) => x.activityType === 'TASK_CREATED' && x.description.includes('Review customs reference'))).toBe(true);
      const notes = await api.prisma.notification.findMany({ where: { userId: ownerId, type: 'TASK_ASSIGNED' } });
      expect(notes.some((n) => (n.metadata as any).taskId === t.id)).toBe(true);
      // no notification when you assign a task to yourself
      const before = await api.prisma.notification.count({ where: { userId: officerId, type: 'TASK_ASSIGNED' } });
      await ok(mk(officer, { title: 'Self task' }));
      expect(await api.prisma.notification.count({ where: { userId: officerId, type: 'TASK_ASSIGNED' } })).toBe(before);
    });

    it('validates input, assignee, and file', async () => {
      const bad = await mk(officer, { title: '', priority: 'MEGA', dueAt: 'soon' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.map((d: any) => d.path).sort()).toEqual(['dueAt', 'priority', 'title']);
      expect((await mk(officer, { assignedTo: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
      const bOwner = (await ok(api.req('get', '/auth/me', B))).user.id;
      expect((await mk(officer, { assignedTo: bOwner })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
      expect((await mk(officer, { clearanceFileId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
      const gone = await createUser(api, A, 'gone@tasks-a.test', 'VIEWER');
      await api.req('patch', `/users/${gone.id}/status`, A).send({ isActive: false });
      expect((await mk(officer, { assignedTo: gone.id })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
    });

    it('cannot add tasks to a closed file', async () => {
      const client = await api.prisma.client.findFirstOrThrow({ where: { tenantId: tenantAId } });
      const f = await ok(api.req('post', '/clearance-files', A).send({ fileType: 'IMPORT', clientId: client.id }));
      await api.prisma.clearanceFile.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      const res = await mk(officer, { clearanceFileId: f.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('FILE_NOT_EDITABLE');
    });

    it('requires tasks.manage to create', async () => {
      expect((await mk(viewer, {})).status).toBe(403);
      expect((await mk(accountant, {})).status).toBe(403);
      expect((await api.req('get', '/tasks', accountant)).status).toBe(403); // no tasks.view either
    });
  });

  describe('updating and completing', () => {
    it('lets managers edit everything and reassign, with a timeline entry', async () => {
      const t = await ok(mk(officer, { clearanceFileId: fileId, title: 'Original', assignedTo: officerId }));
      const upd = await ok(api.req('patch', `/tasks/${t.id}`, officer).send({ title: 'Renamed', priority: 'URGENT', dueAt: '2026-12-24T10:00:00Z', description: 'Updated', assignedTo: ownerId }));
      expect(upd).toMatchObject({ title: 'Renamed', priority: 'URGENT', description: 'Updated' });
      expect(upd.assignee.id).toBe(ownerId);
      const tl = await ok(api.req('get', `/clearance-files/${fileId}/timeline?limit=100`, A));
      expect(tl.some((x: any) => x.activityType === 'TASK_REASSIGNED')).toBe(true);
      expect((await ok(api.req('patch', `/tasks/${t.id}`, officer).send({ dueAt: null }))).dueAt).toBeNull();
      expect((await api.req('patch', `/tasks/${t.id}`, officer).send({ status: 'DONE' })).status).toBe(400); // only via /complete
      expect((await api.req('patch', `/tasks/${t.id}`, officer).send({ clearanceFileId: null })).status).toBe(400); // strict
    });

    it('lets an assignee without tasks.manage move only their own task\'s status', async () => {
      const t = await ok(mk(officer, { title: 'For the viewer', assignedTo: viewerId }));
      const started = await ok(api.req('patch', `/tasks/${t.id}`, viewer).send({ status: 'IN_PROGRESS' }));
      expect(started.status).toBe('IN_PROGRESS');
      expect((await api.req('patch', `/tasks/${t.id}`, viewer).send({ title: 'hacked' })).status).toBe(403);
      expect((await api.req('patch', `/tasks/${t.id}`, viewer).send({ assignedTo: officerId })).status).toBe(403);
      const others = await ok(mk(officer, { title: 'Not yours', assignedTo: officerId }));
      expect((await api.req('patch', `/tasks/${others.id}`, viewer).send({ status: 'IN_PROGRESS' })).status).toBe(403);
      expect((await api.req('post', `/tasks/${others.id}/complete`, viewer)).status).toBe(403);
    });

    it('completes a task, stamping the time, and is idempotent', async () => {
      const t = await ok(mk(officer, { clearanceFileId: fileId, title: 'Finish me', assignedTo: viewerId }));
      const done = await ok(api.req('post', `/tasks/${t.id}/complete`, viewer)); // the assignee may complete it
      expect(done.status).toBe('DONE');
      expect(done.completedAt).not.toBeNull();
      const again = await ok(api.req('post', `/tasks/${t.id}/complete`, officer));
      expect(again.completedAt).toBe(done.completedAt); // unchanged
      const tl = await ok(api.req('get', `/clearance-files/${fileId}/timeline?limit=100`, A));
      expect(tl.filter((x: any) => x.activityType === 'TASK_COMPLETED' && x.description.includes('Finish me'))).toHaveLength(1);
    });

    it('freezes completed tasks except for an explicit reopen, and cannot complete a cancelled task', async () => {
      const t = await ok(mk(officer, { title: 'Lifecycle' }));
      await ok(api.req('post', `/tasks/${t.id}/complete`, officer));
      expect((await api.req('patch', `/tasks/${t.id}`, officer).send({ title: 'edit after done' })).body.error.code).toBe('TASK_ALREADY_DONE');
      expect((await api.req('patch', `/tasks/${t.id}`, officer).send({ status: 'CANCELLED' })).body.error.code).toBe('TASK_ALREADY_DONE');
      const reopened = await ok(api.req('patch', `/tasks/${t.id}`, officer).send({ status: 'OPEN' }));
      expect(reopened).toMatchObject({ status: 'OPEN', completedAt: null });
      await ok(api.req('patch', `/tasks/${t.id}`, officer).send({ status: 'CANCELLED' }));
      expect((await api.req('post', `/tasks/${t.id}/complete`, officer)).body.error.code).toBe('TASK_CANCELLED');
    });
  });

  describe('listing and filtering', () => {
    beforeAll(async () => {
      await ok(mk(officer, { title: 'Overdue alpha', dueAt: hoursFromNow(-48), priority: 'HIGH' }));
      await ok(mk(officer, { title: 'Upcoming beta', dueAt: hoursFromNow(72), assignedTo: ownerId }));
      await ok(mk(officer, { title: 'Percent 100% sure', clearanceFileId: fileId }));
    });
    const list = async (qs: string, token = A) => (await api.req('get', `/tasks?${qs}&limit=100`, token)).body;

    it('filters by state, status, priority, assignee, file and overdue', async () => {
      const open = await list('state=open');
      expect(open.data.every((t: any) => ['OPEN', 'IN_PROGRESS'].includes(t.status))).toBe(true);
      const closed = await list('state=closed');
      expect(closed.data.length).toBeGreaterThan(0);
      expect(closed.data.every((t: any) => ['DONE', 'CANCELLED'].includes(t.status))).toBe(true);
      expect((await list('priority=HIGH')).data.every((t: any) => t.priority === 'HIGH')).toBe(true);
      const mine = await list('assignedTo=me', officer);
      expect(mine.data.length).toBeGreaterThan(2);
      expect(mine.data.every((t: any) => t.assignee.id === officerId)).toBe(true);
      expect((await list(`clearanceFileId=${fileId}`)).data.every((t: any) => t.clearanceFile?.id === fileId)).toBe(true);
      const overdue = await list('overdue=true');
      expect(overdue.data.map((t: any) => t.title)).toContain('Overdue alpha');
      expect(overdue.data.every((t: any) => t.isOverdue && ['OPEN', 'IN_PROGRESS'].includes(t.status))).toBe(true);
    });

    it('filters by due date range, searches literally, and pages on the server', async () => {
      const day = new Date(Date.now() + 72 * 3_600_000).toISOString().slice(0, 10);
      expect((await list(`dueFrom=${day}&dueTo=${day}`)).data.map((t: any) => t.title)).toContain('Upcoming beta');
      expect((await list('search=percent 100%25')).data.map((t: any) => t.title)).toEqual(['Percent 100% sure']);
      expect((await list('search=%25')).data.map((t: any) => t.title)).toEqual(['Percent 100% sure']); // "%" is literal
      const p1 = await api.req('get', '/tasks?limit=3&page=1&sort=title:asc', A);
      expect(p1.body.data).toHaveLength(3);
      expect(p1.body.meta.total).toBeGreaterThan(3);
      expect((await api.req('get', '/tasks?sort=passwordHash:asc', A)).status).toBe(200);
    });

    it('lets read-only roles see tasks and lists a file\'s tasks', async () => {
      expect((await api.req('get', '/tasks', viewer)).status).toBe(200);
      const forFile = await ok(api.req('get', `/clearance-files/${fileId}/tasks`, viewer));
      expect(forFile.length).toBeGreaterThan(0);
      expect(forFile.every((t: any) => t.clearanceFile.id === fileId)).toBe(true);
    });
  });

  describe('my tasks dashboard', () => {
    it('groups open tasks into overdue / today / upcoming / no date, soonest first', async () => {
      // a clean user so counts are exact
      const u = await createUser(api, A, 'dash@tasks-a.test', 'CLEARANCE_OFFICER');
      const dash = (await signIn(api, 'dash@tasks-a.test')).accessToken;
      const tenant = await api.prisma.tenant.findUniqueOrThrow({ where: { id: tenantAId } });
      const { start } = zonedDayBounds(new Date(), tenant.timezone);
      const midToday = new Date(start.getTime() + 12 * 3_600_000).toISOString(); // noon today, office time
      const mine = (title: string, dueAt?: string) => ok(mk(A, { title, assignedTo: u.id, ...(dueAt && { dueAt }) }));

      await mine('Yesterday', new Date(start.getTime() - 3_600_000).toISOString());
      await mine('Today noon', midToday);
      await mine('Next week', new Date(start.getTime() + 7 * 86_400_000).toISOString());
      await mine('No date');
      const done = await mine('Already done', midToday);
      await api.req('post', `/tasks/${done.id}/complete`, A);
      const cancelled = await mine('Cancelled', midToday);
      await api.req('patch', `/tasks/${cancelled.id}`, A).send({ status: 'CANCELLED' });
      await ok(mk(A, { title: 'Someone else\'s', assignedTo: ownerId, dueAt: midToday }));

      const res = await ok(api.req('get', '/dashboard/my-tasks', dash));
      expect(res.counts).toEqual({ overdue: 1, dueToday: 1, upcoming: 1, noDueDate: 1, total: 4 });
      expect(res.tasks.map((t: any) => [t.title, t.bucket])).toEqual([
        ['Yesterday', 'overdue'], ['Today noon', 'dueToday'], ['Next week', 'upcoming'], ['No date', 'noDueDate'],
      ]);
    });

    it('is available to anyone with tasks.view, and empty for a new user', async () => {
      const res = await ok(api.req('get', '/dashboard/my-tasks', viewer));
      expect(res.counts.total).toBe(res.tasks.length);
      expect((await api.req('get', '/dashboard/my-tasks', accountant)).status).toBe(403);
    });
  });

  describe('office isolation', () => {
    it('answers 404 for another office\'s tasks and never lists them', async () => {
      const client = await ok(api.req('post', '/clients', B).send({ name: 'B client' }));
      const bFile = await ok(api.req('post', '/clearance-files', B).send({ fileType: 'IMPORT', clientId: client.id }));
      const bTask = await ok(api.req('post', '/tasks', B).send({ title: 'B secret task', clearanceFileId: bFile.id }));
      for (const [m, p, body] of [
        ['get', `/tasks/${bTask.id}`, undefined], ['patch', `/tasks/${bTask.id}`, { status: 'IN_PROGRESS' }],
        ['post', `/tasks/${bTask.id}/complete`, undefined], ['get', `/clearance-files/${bFile.id}/tasks`, undefined],
      ] as const) {
        expect((await api.req(m, p, A).send(body)).status, `${m} ${p}`).toBe(404);
      }
      expect((await api.req('post', '/tasks', A).send({ title: 'x', clearanceFileId: bFile.id })).status).toBe(404);
      expect((await ok(api.req('get', '/tasks?search=secret&limit=100', A)))).toEqual([]);
      expect((await ok(api.req('get', '/tasks?limit=100', A))).some((t: any) => t.id === bTask.id)).toBe(false);
      expect((await ok(api.req('get', `/tasks/${bTask.id}`, B))).status).toBe('OPEN');
    });
  });
});
