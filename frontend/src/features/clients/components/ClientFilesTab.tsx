import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, type Locale } from '@/lib/format';
import { Badge, Card, EmptyState, ErrorState, Pagination, Spinner, Td, Th } from '@/components/ui/primitives';
import { stageName, statusTone } from '@/features/clearance-files/lib';
import type { ClientFile } from '../types';

const LIMIT = 20;

export function ClientFilesTab({ clientId }: { clientId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['client-files', clientId, page],
    queryFn: ({ signal }) => api.list<ClientFile>(`/clients/${clientId}/files`, { page, limit: LIMIT }, signal),
  });
  return (
    <Card className="overflow-hidden">
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (q.data.data.length === 0 ? <EmptyState>{t('clients.noFiles')}</EmptyState> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr><Th>{t('files.number')}</Th><Th>{t('files.type')}</Th><Th>{t('files.stage')}</Th><Th>{t('common.status')}</Th><Th>{t('files.openedAt')}</Th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.data.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-50">
                    <Td dir="ltr" className="font-medium tabular-nums"><Link to={`/files/${f.id}`} className="text-brand-700 hover:underline">{f.fileNumber}</Link></Td>
                    <Td>{t(`files.types.${f.fileType}`, { defaultValue: f.fileType })}</Td>
                    <Td>{f.currentStage ? stageName(f.currentStage, locale) : '—'}</Td>
                    <Td><Badge tone={statusTone[f.status as keyof typeof statusTone] ?? 'neutral'}>{t(`files.statuses.${f.status}`, { defaultValue: f.status })}</Badge></Td>
                    <Td>{formatDate(f.openedAt, locale)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
        </>
      ))}
    </Card>
  );
}
