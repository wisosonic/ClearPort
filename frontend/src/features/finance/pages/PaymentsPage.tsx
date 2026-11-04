import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import { RECORDABLE, type Payment } from '@/features/clearance-files/components/payments/types';

type Row = Payment & { clearanceFileId: string | null; client: { id: string; name: string } | null };
const statusTone = { DRAFT: 'neutral', POSTED: 'green', CANCELLED: 'red', REVERSED: 'red' } as const;
const LIMIT = 20;

/** Every payment in the office. Recording and applying happen on the file page, which each row links to when it has one. */
export function PaymentsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [unapplied, setUnapplied] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['payments', { term, type, status, unapplied, from, to, page }],
    queryFn: ({ signal }) => api.list<Row>('/payments', { search: term, paymentType: type, status, from, to, page, limit: LIMIT, unallocated: unapplied ? 'true' : undefined }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('pay.title')}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('pay.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('pay.type')} className="w-44" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {[...RECORDABLE, 'SUPPLIER_PAYMENT', 'REIMBURSEMENT'].map((x) => <option key={x} value={x}>{t(`pay.types.${x}`)}</option>)}
        </Select>
        <Select aria-label={t('common.status')} className="w-40" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['POSTED', 'CANCELLED', 'REVERSED'].map((s) => <option key={s} value={s}>{t(`pay.statuses.${s}`)}</option>)}
        </Select>
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={unapplied} onChange={(e) => reset(setUnapplied)(e.target.checked)} />{t('pay.unappliedOnly')}</label>
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('pay.noneMatching')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('inv.number')}</Th><Th>{t('files.client')}</Th><Th>{t('pay.type')}</Th><Th>{t('pay.date')}</Th><Th>{t('pay.method')}</Th><Th>{t('pay.amount')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <Td dir="ltr" className="font-medium tabular-nums">{p.paymentNumber}</Td>
                      <Td dir="auto">{p.client ? <Link to={`/clients/${p.client.id}`} className="text-brand-700 hover:underline">{p.client.name}</Link> : '—'}</Td>
                      <Td>{t(`pay.types.${p.paymentType}`)}</Td>
                      <Td>{formatDate(p.paymentDate, locale)}</Td>
                      <Td dir="auto">{t(`pay.methods.${p.paymentMethod}`, { defaultValue: p.paymentMethod })}{p.referenceNumber && <span className="block text-xs text-slate-500" dir="auto">{p.referenceNumber}</span>}</Td>
                      <Td dir="ltr" className="tabular-nums">{formatMoney(p.amount, p.currencyCode, locale)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={statusTone[p.status]}>{t(`pay.statuses.${p.status}`)}</Badge>
                          {p.status === 'POSTED' && Number(p.unallocatedAmount) > 0 && <Badge tone="amber">{t('pay.unapplied')}</Badge>}
                        </div>
                      </Td>
                      <Td>{p.clearanceFileId && <Link to={`/files/${p.clearanceFileId}`} className="text-sm text-brand-700 hover:underline">{t('pay.openFile')}</Link>}</Td>
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
