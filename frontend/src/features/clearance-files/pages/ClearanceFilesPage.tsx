import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { formatDate, fullName, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface FileRow {
  id: string; fileNumber: string; fileType: string; status: string; priority: string; expectedArrivalAt: string | null;
  client: { id: string; clientCode: string; name: string };
  currentStage: { code: string; nameEn: string; nameAr: string | null } | null;
  assignee: { firstName: string; lastName: string } | null;
}

const statusTone = { OPEN: 'blue', ON_HOLD: 'amber', CLOSED: 'green', CANCELLED: 'neutral' } as const;
const priorityTone = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'amber', URGENT: 'red' } as const;
const LIMIT = 20;

export function ClearanceFilesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [assigned, setAssigned] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());

  const q = useQuery({
    queryKey: ['files', { term, status, assigned, page }],
    queryFn: ({ signal }) => api.list<FileRow>('/clearance-files', { search: term, status, assignedTo: assigned, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('files.title')}</h1>
        {can(permissions, 'clearance_files.create') && <Link to="/files/new" className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"><Plus className="size-4" aria-hidden />{t('files.new')}</Link>}
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('files.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('common.status')} className="w-44" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`files.statuses.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('files.assignee')} className="w-48" value={assigned} onChange={(e) => reset(setAssigned)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          <option value="me">{t('files.mine')}</option>
          <option value="unassigned">{t('files.unassigned')}</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState /> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('files.number')}</Th><Th>{t('files.client')}</Th><Th>{t('files.type')}</Th><Th>{t('files.stage')}</Th><Th>{t('common.status')}</Th><Th>{t('files.priority')}</Th><Th>{t('files.assignee')}</Th><Th>{t('files.arrival')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((f) => (
                    <tr key={f.id} className="hover:bg-slate-50">
                      <Td className="font-medium tabular-nums" dir="ltr"><Link to={`/files/${f.id}`} className="text-brand-700 hover:underline">{f.fileNumber}</Link></Td>
                      <Td dir="auto">{f.client.name}</Td>
                      <Td>{t(`files.types.${f.fileType}`)}</Td>
                      <Td dir="auto">{f.currentStage ? (locale === 'ar' && f.currentStage.nameAr ? f.currentStage.nameAr : f.currentStage.nameEn) : '—'}</Td>
                      <Td><Badge tone={statusTone[f.status as keyof typeof statusTone] ?? 'neutral'}>{t(`files.statuses.${f.status}`)}</Badge></Td>
                      <Td><Badge tone={priorityTone[f.priority as keyof typeof priorityTone] ?? 'neutral'}>{t(`files.priorities.${f.priority}`)}</Badge></Td>
                      <Td dir="auto">{f.assignee ? fullName(f.assignee) : <span className="text-slate-400">{t('files.unassigned')}</span>}</Td>
                      <Td>{formatDate(f.expectedArrivalAt, locale)}</Td>
                    </tr>
                  ))}
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
