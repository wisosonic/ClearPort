import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { fullName } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Button, Select } from '@/components/ui/primitives';
import type { FileDetail } from '../lib';

interface Member { id: string; firstName: string; lastName: string }

/** Anyone with clearance_files.assign may assign to themselves or unassign; picking another employee needs the user list (users.manage). */
export function AssignControl({ file }: { file: FileDetail }) {
  const { t } = useTranslation();
  const { me, permissions } = useAuth();
  const qc = useQueryClient();
  const canAssign = can(permissions, 'clearance_files.assign') && (file.status === 'OPEN' || file.status === 'ON_HOLD');
  const canPick = can(permissions, 'users.manage');
  const members = useQuery({
    queryKey: ['assignable-users'],
    queryFn: () => api.list<Member>('/users', { isActive: 'true', limit: 100 }),
    enabled: canAssign && canPick,
  });
  const assign = useMutation({
    mutationFn: (userId: string | null) => api.post(`/clearance-files/${file.id}/assign`, { userId }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['file', file.id] }),
      qc.invalidateQueries({ queryKey: ['file-timeline', file.id] }),
      qc.invalidateQueries({ queryKey: ['files'] }),
    ]),
  });

  return (
    <div className="space-y-2">
      <p className="text-sm" dir="auto">{file.assignee ? fullName(file.assignee) : <span className="text-slate-400">{t('files.unassigned')}</span>}</p>
      {canAssign && (
        <div className="flex flex-wrap items-center gap-2">
          {canPick && members.data && (
            <Select aria-label={t('files.assignTo')} className="w-56" value={file.assignee?.id ?? ''} disabled={assign.isPending}
              onChange={(e) => assign.mutate(e.target.value || null)}>
              <option value="">{t('files.unassigned')}</option>
              {members.data.data.map((m) => <option key={m.id} value={m.id}>{fullName(m)}</option>)}
            </Select>
          )}
          {!canPick && me && file.assignee?.id !== me.user.id && <Button variant="secondary" loading={assign.isPending} onClick={() => assign.mutate(me.user.id)}>{t('files.assignToMe')}</Button>}
          {!canPick && file.assignee && <Button variant="ghost" disabled={assign.isPending} onClick={() => assign.mutate(null)}>{t('files.unassign')}</Button>}
        </div>
      )}
      {assign.isError && <Alert>{assign.error instanceof ApiError ? assign.error.message : t('common.error')}</Alert>}
    </div>
  );
}
