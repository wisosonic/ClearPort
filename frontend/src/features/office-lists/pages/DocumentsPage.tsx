import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError, download } from '@/lib/api-client';
import { formatBytes, formatDate, fullName, type Locale } from '@/lib/format';
import { saveBlob } from '@/lib/save-blob';
import { useDebounced } from '@/hooks/useDebounced';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { DocType, DocumentRow } from '@/features/clearance-files/components/documents/types';

type Row = DocumentRow & { clearanceFile: { id: string; fileNumber: string } | null };
const docTone = { PENDING_REVIEW: 'amber', APPROVED: 'green', REJECTED: 'red', VOID: 'neutral' } as const;
const LIMIT = 20;
const typeName = (x: { nameEn: string; nameAr: string }, locale: Locale) => (locale === 'ar' ? x.nameAr : x.nameEn);

function DownloadButton({ d }: { d: Row }) {
  const { t } = useTranslation();
  const get = useMutation({
    mutationFn: async () => { const { blob, filename } = await download(`/documents/${d.id}/download`); saveBlob(blob, filename ?? d.originalFilename); },
  });
  return (
    <div>
      <Button variant="ghost" aria-label={`${t('docs.download')} ${d.originalFilename}`} loading={get.isPending} onClick={() => get.mutate()}><Download className="size-4" aria-hidden /></Button>
      {get.isError && <p role="alert" className="text-xs text-red-700">{get.error instanceof ApiError ? get.error.message : t('common.error')}</p>}
    </div>
  );
}

/** Every document in the office. Uploading and reviewing happen on the file page, which each row links to. */
export function DocumentsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [typeId, setTypeId] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api.get<DocType[]>('/document-types') });
  const q = useQuery({
    queryKey: ['documents', { term, status, typeId, includeVoid, page }],
    queryFn: ({ signal }) => api.list<Row>('/documents', { search: term, status, documentTypeId: typeId, includeVoid: includeVoid ? 'true' : undefined, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('nav.documents')}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('lists.documentSearch')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('docs.type')} className="w-52" value={typeId} onChange={(e) => reset(setTypeId)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {(types.data ?? []).filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{typeName(x, locale)}</option>)}
        </Select>
        <Select aria-label={t('common.status')} className="w-44" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['PENDING_REVIEW', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{t(`docs.statuses.${s}`)}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeVoid} onChange={(e) => reset(setIncludeVoid)(e.target.checked)} />{t('lists.includeVoid')}</label>
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('lists.noDocuments')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('docs.type')}</Th><Th>{t('docs.file')}</Th><Th>{t('files.number')}</Th><Th>{t('docs.version')}</Th><Th>{t('docs.size')}</Th><Th>{t('common.status')}</Th><Th>{t('docs.uploadedBy')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((d) => (
                    <tr key={d.id} className={d.status === 'VOID' ? 'text-slate-400' : 'hover:bg-slate-50'}>
                      <Td dir="auto" className="font-medium">{typeName(d.documentType, locale)}</Td>
                      <Td dir="auto" className="max-w-xs break-words">{d.originalFilename}</Td>
                      <Td dir="ltr" className="tabular-nums">{d.clearanceFile ? <Link to={`/files/${d.clearanceFile.id}`} className="text-brand-700 hover:underline">{d.clearanceFile.fileNumber}</Link> : '—'}</Td>
                      <Td>v{d.versionNumber}</Td>
                      <Td dir="ltr">{formatBytes(d.fileSize)}</Td>
                      <Td><Badge tone={docTone[d.status]}>{t(`docs.statuses.${d.status}`)}</Badge></Td>
                      <Td dir="auto">{d.uploadedBy ? fullName(d.uploadedBy) : '—'}<span className="block text-xs text-slate-500">{formatDate(d.uploadedAt, locale)}</span></Td>
                      <Td>{d.status !== 'VOID' && <DownloadButton d={d} />}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
          </>
        ))}
      </Card>
      <Alert tone="blue">{t('lists.documentsHint')}</Alert>
    </div>
  );
}
