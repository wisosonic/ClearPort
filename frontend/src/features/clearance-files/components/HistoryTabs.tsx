import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, fullName, type Locale } from '@/lib/format';
import { Card, EmptyState, ErrorState, Pagination, Spinner } from '@/components/ui/primitives';
import { stageName, type Person, type Stage } from '../lib';

interface Activity { id: string; activityType: string; description: string; createdAt: string; user: Person | null }
interface HistoryRow { id: string; fromStage: Stage | null; toStage: Stage; reason: string | null; changedAt: string; changedBy: Person | null }
const LIMIT = 30;

/** Everything that happened to the file, newest first. The descriptions are written by the server in English. */
export function ActivityTab({ fileId }: { fileId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['file-timeline', fileId, page],
    queryFn: ({ signal }) => api.list<Activity>(`/clearance-files/${fileId}/timeline`, { page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="overflow-hidden">
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (q.data.data.length === 0 ? <EmptyState>{t('files.noActivity')}</EmptyState> : (
        <>
          <ol className="divide-y divide-slate-100">
            {q.data.data.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 px-5 py-3 text-sm sm:flex-row sm:items-baseline sm:justify-between">
                <span dir="auto">{a.description}</span>
                <span className="shrink-0 text-xs text-slate-500">{a.user ? `${fullName(a.user)} · ` : ''}{formatDate(a.createdAt, locale, true)}</span>
              </li>
            ))}
          </ol>
          <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
        </>
      ))}
    </Card>
  );
}

export function StageHistoryTab({ fileId }: { fileId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const q = useQuery({ queryKey: ['file-history', fileId], queryFn: () => api.get<HistoryRow[]>(`/clearance-files/${fileId}/status-history`) });
  return (
    <Card className="overflow-hidden">
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (q.data.length === 0 ? <EmptyState>{t('files.noHistory')}</EmptyState> : (
        <ol className="divide-y divide-slate-100">
          {[...q.data].reverse().map((h) => (
            <li key={h.id} className="space-y-0.5 px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {h.fromStage && <><span dir="auto">{stageName(h.fromStage, locale)}</span><ArrowRight className="rtl-flip size-4 text-slate-400" aria-hidden /></>}
                <span className="font-medium" dir="auto">{stageName(h.toStage, locale)}</span>
              </div>
              <div className="text-xs text-slate-500">
                {h.changedBy ? `${fullName(h.changedBy)} · ` : ''}{formatDate(h.changedAt, locale, true)}{h.reason ? ` — ${h.reason}` : ''}
              </div>
            </li>
          ))}
        </ol>
      ))}
    </Card>
  );
}
