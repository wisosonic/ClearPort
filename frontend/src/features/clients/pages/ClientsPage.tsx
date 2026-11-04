import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface ClientRow { id: string; clientCode: string; name: string; clientType: string; phone: string | null; email: string | null; countryCode: string | null; isActive: boolean }
const LIMIT = 20;

export function ClientsPage() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());

  const q = useQuery({
    queryKey: ['clients', { term, active, page }],
    queryFn: ({ signal }) => api.list<ClientRow>('/clients', { search: term, isActive: active, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('clients.title')}</h1>
        {can(permissions, 'clients.manage') && (
          <Link to="/clients/new" className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"><Plus className="size-4" aria-hidden />{t('clients.new')}</Link>
        )}
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('clients.searchPlaceholder')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Select aria-label={t('common.status')} className="w-40" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
          <option value="true">{t('common.active')}</option>
          <option value="false">{t('common.inactive')}</option>
          <option value="">{t('common.all')}</option>
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
                  <tr><Th>{t('clients.code')}</Th><Th>{t('common.name')}</Th><Th>{t('files.type')}</Th><Th>{t('clients.phone')}</Th><Th>{t('clients.email')}</Th><Th>{t('common.status')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50">
                      <Td className="tabular-nums" dir="ltr">{c.clientCode}</Td>
                      <Td className="font-medium" dir="auto"><Link to={`/clients/${c.id}`} className="text-brand-700 hover:underline">{c.name}</Link></Td>
                      <Td>{t(`clients.types.${c.clientType}`, { defaultValue: c.clientType })}</Td>
                      <Td dir="ltr">{c.phone ?? '—'}</Td>
                      <Td dir="ltr">{c.email ?? '—'}</Td>
                      <Td><Badge tone={c.isActive ? 'green' : 'neutral'}>{c.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
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
