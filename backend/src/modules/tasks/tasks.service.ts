import { Inject, Injectable } from '@nestjs/common';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ActivityService } from '../clearance-files/activity.service';
import { FilesService } from '../clearance-files/files.service';
import { TaskRemindersService } from './task-reminders.service';
import type { CreateTaskInput, TaskListQuery, UpdateTaskInput } from './tasks.schemas';

const TASK_SORT = ['dueAt', 'createdAt', 'priority', 'status', 'title'] as const;
const OPEN_STATES = ['OPEN', 'IN_PROGRESS'] as const;
const userSelect = { id: true, firstName: true, lastName: true } as const;

/**
 * The start and end (UTC instants) of "today" in a time zone, so "due today" and "overdue" follow
 * the office's calendar rather than the server's.
 */
export function zonedDayBounds(now: Date, timeZone: string): { start: Date; end: Date } {
  let parts: Record<string, number>;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  } catch {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start: d, end: new Date(d.getTime() + 86_400_000) };
  }
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000; // how far the zone is ahead of UTC
  const start = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offsetMs);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TaskRemindersService) private readonly reminders: TaskRemindersService,
  ) {}

  // ───────────────────────────── read ─────────────────────────────

  async list(auth: AuthContext, q: TaskListQuery, forFileId?: string) {
    const where: any = {};
    const fileId = forFileId ?? q.clearanceFileId;
    if (fileId) where.clearanceFileId = fileId;
    if (q.status) where.status = q.status;
    else if (q.state === 'open') where.status = { in: [...OPEN_STATES] };
    else if (q.state === 'closed') where.status = { in: ['DONE', 'CANCELLED'] };
    if (q.priority) where.priority = q.priority;
    if (q.assignedTo) where.assignedTo = q.assignedTo === 'me' ? auth.userId : q.assignedTo;
    if (q.overdue === 'true') {
      where.dueAt = { lt: new Date() };
      where.status = { in: [...OPEN_STATES] };
    }
    if (q.dueFrom || q.dueTo) {
      where.dueAt = {
        ...(where.dueAt ?? {}),
        ...(q.dueFrom && { gte: new Date(`${q.dueFrom}T00:00:00.000Z`) }),
        ...(q.dueTo && { lte: new Date(`${q.dueTo}T23:59:59.999Z`) }),
      };
    }
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'tasks', columns: ['title', 'description'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const [rows, total] = await Promise.all([
      this.db.client.task.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, TASK_SORT, { dueAt: 'asc' }), include: this.include,
      }),
      this.db.client.task.count({ where }),
    ]);
    return paginated(rows.map((t) => this.present(t)), q, total);
  }

  async get(id: string) {
    const t = await this.db.client.task.findUnique({ where: { id }, include: this.include });
    if (!t) throw notFound('TASK_NOT_FOUND', 'Task not found');
    return this.present(t);
  }

  /** The signed-in user's open tasks, grouped by urgency in the office's time zone. */
  async myTasks(auth: AuthContext) {
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { timezone: true } });
    const { start, end } = zonedDayBounds(new Date(), tenant.timezone);
    const rows = await this.db.client.task.findMany({
      where: { assignedTo: auth.userId, status: { in: [...OPEN_STATES] } }, include: this.include,
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    });
    const tasks = rows.map((t) => this.present(t));
    const bucket = (t: { dueAt: Date | null }) =>
      !t.dueAt ? 'noDueDate' : t.dueAt < start ? 'overdue' : t.dueAt < end ? 'dueToday' : 'upcoming';
    const counts = { overdue: 0, dueToday: 0, upcoming: 0, noDueDate: 0, total: tasks.length };
    for (const t of tasks) counts[bucket(t) as 'overdue' | 'dueToday' | 'upcoming' | 'noDueDate']++;
    // due soonest first; tasks without a date last
    tasks.sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
    return { counts, tasks: tasks.map((t) => ({ ...t, bucket: bucket(t) })) };
  }

  // ───────────────────────────── write ─────────────────────────────

  async create(auth: AuthContext, input: CreateTaskInput, meta: RequestMeta) {
    const assignee = input.assignedTo ?? auth.userId;
    await this.assertAssignee(assignee);
    if (input.clearanceFileId) {
      const file = await this.files.require(input.clearanceFileId);
      this.files.assertEditable(file);
    }
    const task = await this.db.client.$transaction(async (tx) => {
      const t = await tx.task.create({
        data: {
          clearanceFileId: input.clearanceFileId ?? null, assignedTo: assignee, createdBy: auth.userId, title: input.title,
          description: input.description ?? null, priority: input.priority, dueAt: input.dueAt ?? null,
        } as any,
      });
      if (input.clearanceFileId) {
        await this.activity.log(input.clearanceFileId, auth.userId, 'TASK_CREATED', `Task created: ${input.title}`, { taskId: t.id }, tx);
      }
      await this.notifyAssignee(tx, t, auth);
      return t;
    });
    await this.reminders.schedule(auth.tenantId, task); // due-soon / overdue reminders (background jobs)
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TASK_CREATED', entityType: 'Task', entityId: task.id,
      after: task, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(task.id);
  }

  /**
   * Managers (tasks.manage) can change anything. The assignee of a task may only move it through
   * OPEN / IN_PROGRESS / CANCELLED — they cannot retitle, re-prioritise or reassign it.
   */
  async update(auth: AuthContext, id: string, input: UpdateTaskInput, meta: RequestMeta) {
    const before = await this.require(id);
    const manager = auth.permissions.has('tasks.manage');
    if (!manager) {
      if (before.assignedTo !== auth.userId) throw forbidden('PERMISSION_DENIED', 'You can only update tasks assigned to you');
      const extra = Object.keys(input).filter((k) => k !== 'status');
      if (extra.length) throw forbidden('PERMISSION_DENIED', 'You can only change the status of your own task');
    }
    if (before.status === 'DONE' && input.status && input.status !== 'OPEN') {
      throw conflict('TASK_ALREADY_DONE', 'A completed task can only be reopened');
    }
    if (before.status === 'DONE' && !input.status) throw conflict('TASK_ALREADY_DONE', 'A completed task cannot be edited; reopen it first');
    if (input.assignedTo && input.assignedTo !== before.assignedTo) await this.assertAssignee(input.assignedTo);

    const data: Record<string, unknown> = { ...input };
    if (input.status === 'OPEN' && before.status === 'DONE') data.completedAt = null; // reopened
    await this.db.client.$transaction(async (tx) => {
      const updated = await tx.task.update({ where: { id }, data: data as any });
      if (before.clearanceFileId) {
        if (input.assignedTo && input.assignedTo !== before.assignedTo) {
          await this.activity.log(before.clearanceFileId, auth.userId, 'TASK_REASSIGNED', `Task reassigned: ${updated.title}`, { taskId: id, from: before.assignedTo, to: input.assignedTo }, tx);
        } else if (input.status === 'CANCELLED') {
          await this.activity.log(before.clearanceFileId, auth.userId, 'TASK_CANCELLED', `Task cancelled: ${updated.title}`, { taskId: id }, tx);
        } else if (input.status === 'OPEN' && before.status === 'DONE') {
          await this.activity.log(before.clearanceFileId, auth.userId, 'TASK_REOPENED', `Task reopened: ${updated.title}`, { taskId: id }, tx);
        }
      }
      if (input.assignedTo && input.assignedTo !== before.assignedTo) await this.notifyAssignee(tx, updated, auth);
    });
    const after = await this.get(id);
    if (input.dueAt !== undefined || input.status !== undefined) await this.reminders.schedule(auth.tenantId, after as any);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TASK_UPDATED', entityType: 'Task', entityId: id,
      before: { ...pick(before, Object.keys(input)) }, after: { ...pick(after as any, Object.keys(input)) }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  async complete(auth: AuthContext, id: string, meta: RequestMeta) {
    const task = await this.require(id);
    if (!auth.permissions.has('tasks.manage') && task.assignedTo !== auth.userId) {
      throw forbidden('PERMISSION_DENIED', 'You can only complete tasks assigned to you');
    }
    if (task.status === 'DONE') return this.get(id);
    if (task.status === 'CANCELLED') throw conflict('TASK_CANCELLED', 'A cancelled task cannot be completed');
    await this.db.client.$transaction(async (tx) => {
      await tx.task.update({ where: { id }, data: { status: 'DONE', completedAt: new Date() } });
      if (task.clearanceFileId) {
        await this.activity.log(task.clearanceFileId, auth.userId, 'TASK_COMPLETED', `Task completed: ${task.title}`, { taskId: id }, tx);
      }
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'TASK_COMPLETED', entityType: 'Task', entityId: id,
      before: { status: task.status }, after: { status: 'DONE' }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private readonly include = {
    clearanceFile: { select: { id: true, fileNumber: true } },
    assignee: { select: { user: { select: userSelect } } },
    creator: { select: { user: { select: userSelect } } },
  } as const;

  private present(t: any) {
    const { assignee, creator, ...rest } = t;
    const open = t.status === 'OPEN' || t.status === 'IN_PROGRESS';
    return {
      ...rest,
      assignee: assignee?.user ?? null,
      createdByUser: creator?.user ?? null,
      isOverdue: open && !!t.dueAt && t.dueAt.getTime() < Date.now(),
    } as typeof rest & { assignee: unknown; createdByUser: unknown; isOverdue: boolean; dueAt: Date | null };
  }

  private async require(id: string) {
    const t = await this.db.client.task.findUnique({ where: { id } });
    if (!t) throw notFound('TASK_NOT_FOUND', 'Task not found');
    return t;
  }

  private async assertAssignee(userId: string) {
    const m = await this.db.client.tenantUser.findFirst({ where: { userId }, include: { user: { select: { isActive: true } } } });
    if (!m || !m.isActive || !m.user.isActive) throw unprocessable('ASSIGNEE_NOT_FOUND', 'The assignee is not an active employee of your office');
  }

  private async notifyAssignee(tx: any, task: { id: string; title: string; assignedTo: string; clearanceFileId: string | null }, auth: AuthContext) {
    if (task.assignedTo === auth.userId) return;
    await tx.notification.create({
      data: {
        userId: task.assignedTo, type: 'TASK_ASSIGNED', title: `New task: ${task.title}`,
        metadata: { taskId: task.id, clearanceFileId: task.clearanceFileId },
      },
    });
  }
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
