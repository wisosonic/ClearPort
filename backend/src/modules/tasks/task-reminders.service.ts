import { NotificationsService } from '../notifications/notifications.service';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { TenantDbService } from '../../database/prisma.module';
import { JobQueueService, type JobRecord } from '../../infrastructure/queue/job-queue.service';

type ReminderType = 'TASK_DUE_SOON' | 'TASK_OVERDUE';
const OPEN = ['OPEN', 'IN_PROGRESS'];

/**
 * Task reminders (spec 18.4 "scheduled task reminders"). Event-driven rather than polling: when a task is
 * created or its due date changes, two jobs are queued — "due soon" (the lead time before the due date)
 * and "overdue" (at the due date). The job re-reads the task when it runs and does nothing if the task was
 * completed, cancelled, reassigned or re-dated since, so stale jobs are harmless and nothing needs cancelling.
 */
@Injectable()
export class TaskRemindersService implements OnModuleInit {
  constructor(
    @Inject(JobQueueService) private readonly queue: JobQueueService,
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(ENV) private readonly env: Env,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.queue.register('task.due-soon', (j) => this.handle(j, 'TASK_DUE_SOON'));
    this.queue.register('task.overdue', (j) => this.handle(j, 'TASK_OVERDUE'));
  }

  /** Queues the reminder jobs for a task. Safe to call again: identical jobs are deduplicated. */
  async schedule(tenantId: string, task: { id: string; dueAt: Date | null; status: string }, now = new Date()) {
    if (!task.dueAt || !OPEN.includes(task.status)) return;
    const due = task.dueAt.getTime();
    const iso = task.dueAt.toISOString();
    const lead = this.env.TASK_REMINDER_LEAD_HOURS * 3_600_000;
    const key = `${task.id}:${iso}`;
    // a task due within the hour needs no "soon" reminder; one due in the past was handled at creation
    if (due - now.getTime() > 3_600_000) {
      await this.queue.enqueue('task.due-soon', { taskId: task.id, dueAt: iso }, { tenantId, runAt: new Date(Math.max(now.getTime(), due - lead)), dedupeKey: key });
    }
    if (due > now.getTime()) await this.queue.enqueue('task.overdue', { taskId: task.id, dueAt: iso }, { tenantId, runAt: task.dueAt, dedupeKey: key });
  }

  /** Runs inside the task's office (the worker sets the tenant context). Idempotent. */
  private async handle(job: JobRecord, type: ReminderType) {
    const { taskId, dueAt } = job.payload as { taskId: string; dueAt: string };
    const task = await this.db.client.task.findUnique({ where: { id: taskId }, include: { clearanceFile: { select: { id: true, fileNumber: true } } } });
    if (!task || !OPEN.includes(task.status) || !task.dueAt || task.dueAt.toISOString() !== dueAt) return; // done, cancelled, moved or deleted

    const recipients = new Set<string>([task.assignedTo]);
    if (type === 'TASK_OVERDUE') recipients.add(task.createdBy); // the person who set the task wants to know it slipped

    const members = await this.db.client.tenantUser.findMany({
      where: { userId: { in: [...recipients] }, isActive: true, tenant: { status: 'ACTIVE' } }, select: { userId: true },
    });
    for (const m of members) {
      const existing = await this.db.client.notification.findMany({ where: { userId: m.userId, type }, select: { metadata: true }, orderBy: { createdAt: 'desc' }, take: 500 });
      if (existing.some((n) => (n.metadata as any)?.taskId === taskId && (n.metadata as any)?.dueAt === dueAt)) continue; // already told (a retry or duplicate job)
      const where = task.clearanceFile ? ` (${task.clearanceFile.fileNumber})` : '';
      await this.notifications.create(this.db.client, {
        userId: m.userId, type,
        title: type === 'TASK_DUE_SOON' ? `Task due soon: ${task.title}${where}` : `Task overdue: ${task.title}${where}`,
        metadata: { taskId, dueAt, clearanceFileId: task.clearanceFileId, assignedTo: task.assignedTo },
      });
    }
  }
}
