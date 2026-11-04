import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, fullName, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { UserRow } from '../types';
import { UserForm } from './UserForm';

const LIMIT = 20;

function UserLine({ u, isMe, onEdit }: { u: UserRow; isMe: boolean; onEdit: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const status = useMutation({
    mutationFn: (isActive: boolean) => api.patch(`/users/${u.id}/status`, { isActive }),
    onSuccess: async () => { setProblem(null); await qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : t('common.error')),
  });
  return (
    <>
      <tr className={u.isActive ? '' : 'text-slate-400'}>
        <Td dir="auto"><span className="font-medium">{fullName(u)}</span>{isMe && <Badge tone="blue" className="ms-2">{t('users.you')}</Badge>}<span className="block text-xs text-slate-500" dir="ltr">{u.email}</span></Td>
        <Td><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r.id} tone="neutral">{r.name}</Badge>)}</div></Td>
        <Td dir="auto">{u.branch?.name ?? '—'}</Td>
        <Td>{u.lastLoginAt ? formatDate(u.lastLoginAt, locale, true) : t('users.never')}</Td>
        <Td><Badge tone={u.isActive ? 'green' : 'neutral'}>{u.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          <div className="flex gap-1">
            <Button variant="ghost" aria-label={`${t('common.edit')} ${fullName(u)}`} onClick={onEdit}>{t('common.edit')}</Button>
            {!isMe && (
              <Button variant="ghost" aria-label={`${u.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${fullName(u)}`} loading={status.isPending} onClick={() => status.mutate(!u.isActive)}>
                {u.isActive ? t('clients.deactivate') : t('clients.reactivate')}
              </Button>
            )}
          </div>
        </Td>
      </tr>
      {problem && <tr><td colSpan={6} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

export function UsersTab() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<'new' | UserRow | null>(null);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['users', { term, active, page }],
    queryFn: ({ signal }) => api.list<UserRow>('/users', { search: term, isActive: active, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      {form && <UserForm user={form === 'new' ? undefined : form} onCancel={() => setForm(null)} onSaved={async () => { setForm(null); await qc.invalidateQueries({ queryKey: ['users'] }); }} />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('users.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('common.status')} className="w-40" value={active} onChange={(e) => reset(setActive)(e.target.value)}>
          <option value="true">{t('common.active')}</option>
          <option value="false">{t('common.inactive')}</option>
          <option value="">{t('common.all')}</option>
        </Select>
        {!form && <Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('users.addUser')}</Button>}
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('users.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('common.name')}</Th><Th>{t('users.roles')}</Th><Th>{t('users.branch')}</Th><Th>{t('users.lastSignIn')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((u) => <UserLine key={u.id} u={u} isMe={u.id === me?.user.id} onEdit={() => setForm(u)} />)}
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
