import { useMutation, useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api-client';
import { fullName } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { dueToIso, isoToLocalDay, type Person, type Task } from './types';
import { useRefreshTasks } from './useRefreshTasks';

const schema = z.object({
  title: z.string().trim().min(1, 'tasks.titleRequired').max(200, 'files.tooLong'),
  description: z.string().max(5000, 'files.tooLong'),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  dueDay: z.string(),
  assignedTo: z.string(),
});
type Values = z.infer<typeof schema>;

/** Create (with `fileId` for a file's task, or none for a general one) or edit (`task`). */
export function TaskForm({ fileId, task, onDone }: { fileId?: string; task?: Task; onDone: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const refresh = useRefreshTasks(fileId ?? task?.clearanceFileId ?? undefined);
  const canPick = can(permissions, 'users.manage');
  const members = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.list<Person>('/users', { isActive: 'true', limit: 100 }),
    enabled: canPick,
  });
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: task?.title ?? '', description: task?.description ?? '', priority: task?.priority ?? 'NORMAL',
      dueDay: isoToLocalDay(task?.dueAt), assignedTo: task?.assignedTo ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: Values) => {
      if (task) {
        return api.patch(`/tasks/${task.id}`, {
          title: v.title.trim(), description: v.description.trim(), priority: v.priority,
          dueAt: v.dueDay ? dueToIso(v.dueDay) : null, ...(v.assignedTo && v.assignedTo !== task.assignedTo ? { assignedTo: v.assignedTo } : {}),
        });
      }
      return api.post('/tasks', {
        title: v.title.trim(), description: v.description.trim() || undefined, priority: v.priority, dueAt: dueToIso(v.dueDay),
        clearanceFileId: fileId, assignedTo: v.assignedTo || undefined,
      });
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const err = (e?: { message?: string }) => (e?.message ? t(e.message) : undefined);

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4" noValidate>
      {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
      <Field label={t('tasks.taskTitle')} htmlFor="task-title" error={err(errors.title)}><Input id="task-title" dir="auto" {...register('title')} /></Field>
      <Field label={t('tasks.description')} htmlFor="task-description" error={err(errors.description)}><Textarea id="task-description" dir="auto" {...register('description')} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('files.priority')} htmlFor="task-priority">
          <Select id="task-priority" {...register('priority')}>{['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((p) => <option key={p} value={p}>{t(`files.priorities.${p}`)}</option>)}</Select>
        </Field>
        <Field label={t('tasks.due')} htmlFor="task-due"><Input id="task-due" type="date" {...register('dueDay')} /></Field>
        {canPick && (
          <Field label={t('tasks.assignee')} htmlFor="task-assignee" hint={task ? undefined : t('tasks.assigneeHint')}>
            <Select id="task-assignee" {...register('assignedTo')}>
              <option value="">{task ? '' : t('tasks.me')}</option>
              {(members.data?.data ?? []).map((m) => <option key={m.id} value={m.id}>{fullName(m)}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
