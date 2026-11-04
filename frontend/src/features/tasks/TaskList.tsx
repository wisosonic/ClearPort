import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, fullName, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import { TaskForm } from './TaskForm';
import type { Task, TaskStatus } from './types';
import { useRefreshTasks } from './useRefreshTasks';

const statusTone = { OPEN: 'blue', IN_PROGRESS: 'amber', DONE: 'green', CANCELLED: 'neutral' } as const;
const priorityTone = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'amber', URGENT: 'red' } as const;
const LIMIT = 20;

function TaskRow({ task, fileId, showFile, locked }: { task: Task; fileId?: string; showFile: boolean; locked: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { me, permissions } = useAuth();
  const refresh = useRefreshTasks(fileId ?? task.clearanceFileId ?? undefined);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onError = (e: unknown) => setProblem(e instanceof ApiError ? e.message : t('common.error'));
  const onSuccess = async () => { setProblem(null); await refresh(); };

  const setStatus = useMutation({ mutationFn: (status: TaskStatus) => api.patch(`/tasks/${task.id}`, { status }), onSuccess, onError });
  const complete = useMutation({ mutationFn: () => api.post(`/tasks/${task.id}/complete`), onSuccess, onError });

  const manager = can(permissions, 'tasks.manage');
  const mine = me?.user.id === task.assignedTo;
  const active = task.status === 'OPEN' || task.status === 'IN_PROGRESS';
  const mayAct = (mine || manager) && !locked;
  const busy = setStatus.isPending || complete.isPending;
  const label = (verb: string) => `${t(verb)}: ${task.title}`;

  if (editing) return <tr><td colSpan={showFile ? 7 : 6} className="p-3"><TaskForm task={task} fileId={fileId} onDone={() => setEditing(false)} /></td></tr>;

  return (
    <>
      <tr className={task.status === 'DONE' || task.status === 'CANCELLED' ? 'text-slate-500' : ''}>
        <Td dir="auto" className="max-w-sm"><span className="font-medium">{task.title}</span>{task.description && <span className="block whitespace-pre-wrap text-xs text-slate-500">{task.description}</span>}</Td>
        {showFile && <Td dir="ltr">{task.clearanceFile ? <Link className="text-brand-700 hover:underline" to={`/files/${task.clearanceFile.id}`}>{task.clearanceFile.fileNumber}</Link> : <span className="text-slate-400">—</span>}</Td>}
        <Td><Badge tone={priorityTone[task.priority]}>{t(`files.priorities.${task.priority}`)}</Badge></Td>
        <Td>
          {task.dueAt ? formatDate(task.dueAt, locale) : '—'}
          {task.isOverdue && <Badge tone="red" className="ms-2">{t('tasks.overdue')}</Badge>}
        </Td>
        <Td dir="auto">{task.assignee ? fullName(task.assignee) : '—'}</Td>
        <Td><Badge tone={statusTone[task.status]}>{t(`tasks.statuses.${task.status}`)}</Badge></Td>
        <Td>
          {mayAct && (
            <div className="flex flex-wrap gap-1">
              {task.status === 'OPEN' && <Button variant="ghost" disabled={busy} aria-label={label('tasks.start')} onClick={() => setStatus.mutate('IN_PROGRESS')}>{t('tasks.start')}</Button>}
              {active && <Button variant="ghost" disabled={busy} aria-label={label('tasks.complete')} onClick={() => complete.mutate()}>{t('tasks.complete')}</Button>}
              {task.status === 'DONE' && <Button variant="ghost" disabled={busy} aria-label={label('tasks.reopen')} onClick={() => setStatus.mutate('OPEN')}>{t('tasks.reopen')}</Button>}
              {manager && active && <Button variant="ghost" disabled={busy} aria-label={label('common.edit')} onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
              {manager && active && <Button variant="ghost" disabled={busy} aria-label={label('tasks.cancel')} onClick={() => setStatus.mutate('CANCELLED')}>{t('tasks.cancel')}</Button>}
            </div>
          )}
        </Td>
      </tr>
      {problem && <tr><td colSpan={showFile ? 7 : 6} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

/** A file's tasks (`fileId`) or the office's tasks (no `fileId`). */
export function TaskList({ fileId, locked = false, defaultMine = false }: { fileId?: string; locked?: boolean; defaultMine?: boolean }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [state, setState] = useState<'open' | 'closed' | ''>('open');
  const [mine, setMine] = useState(defaultMine);
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const canCreate = can(permissions, 'tasks.manage') && !locked;
  const q = useQuery({
    queryKey: ['tasks', fileId ?? 'all', { state, mine, overdue, page }],
    queryFn: ({ signal }) => api.list<Task>(fileId ? `/clearance-files/${fileId}/tasks` : '/tasks', {
      state, assignedTo: mine ? 'me' : undefined, overdue: overdue ? 'true' : undefined, page, limit: LIMIT,
    }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label={t('tasks.show')} className="w-44" value={state} onChange={(e) => reset(setState)(e.target.value as typeof state)}>
          <option value="open">{t('tasks.stateOpen')}</option>
          <option value="closed">{t('tasks.stateClosed')}</option>
          <option value="">{t('common.all')}</option>
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => reset(setMine)(e.target.checked)} />{t('tasks.mine')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => reset(setOverdue)(e.target.checked)} />{t('tasks.overdueOnly')}</label>
        <div className="ms-auto">{canCreate && !creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('tasks.add')}</Button>}</div>
      </div>
      {creating && <TaskForm fileId={fileId} onDone={() => setCreating(false)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('tasks.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <Th>{t('tasks.taskTitle')}</Th>{!fileId && <Th>{t('files.number')}</Th>}<Th>{t('files.priority')}</Th><Th>{t('tasks.due')}</Th><Th>{t('tasks.assignee')}</Th><Th>{t('common.status')}</Th>
                    <Th><span className="sr-only">{t('common.actions')}</span></Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((task) => <TaskRow key={task.id} task={task} fileId={fileId} showFile={!fileId} locked={locked} />)}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
          </>
        ))}
      </Card>
    </div>
  );
}
