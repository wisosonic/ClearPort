import { z } from 'zod';
import { listQuerySchema } from '../../common/pagination';
import { isoDateTime, optText, uuid } from '../../common/zod-helpers';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export const createTaskSchema = z.object({
  clearanceFileId: uuid.optional(), // a task may be general (no file)
  /** Defaults to the creator. */
  assignedTo: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  description: optText(5000).optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  dueAt: isoDateTime.optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// DONE is set only through POST /tasks/:id/complete (it stamps completedAt).
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: optText(5000),
  priority: z.enum(PRIORITIES),
  dueAt: isoDateTime.nullable(),
  assignedTo: uuid,
  status: z.enum(['OPEN', 'IN_PROGRESS', 'CANCELLED']),
}).partial().strict();
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskListQuerySchema = listQuerySchema.extend({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  /** "open" = OPEN or IN_PROGRESS */
  state: z.enum(['open', 'closed']).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assignedTo: z.union([uuid, z.literal('me')]).optional(),
  clearanceFileId: uuid.optional(),
  overdue: z.enum(['true', 'false']).optional(),
  dueFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
