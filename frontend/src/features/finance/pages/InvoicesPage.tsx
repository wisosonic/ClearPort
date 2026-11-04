import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import { INVOICE_TYPES, type Invoice } from '@/features/clearance-files/components/invoices/types';

type Row = Invoice & { client: { id: string; name: string } | null; clearanceFile: { id: string; fileNumber: string } | null };
const statusTone = { DRAFT: 'neutral', ISSUED: 'blue', CANCELLED: 'red' } as const;
const payTone = { UNPAID: 'amber', PARTIALLY_PAID: 'amber', PAID: 'green' } as const;
const LIMIT = 20;

/** Every invoice in the office. Changes are made on the file page, which each row links to. */
export function InvoicesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [payment, setPayment] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['invoices', { term, status, type, payment, from, to, page }],
    queryFn: ({ signal }) => api.list<Row>('/invoices', {
      search: term, status, invoiceType: type, from, to, page, limit: LIMIT,
      unpaid: payment === 'unpaid' ? 'true' : undefined, overdue: payment === 'overdue' ? 'true' : undefined,
    }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('inv.title')}</h1>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('inv.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('common.status')} className="w-40" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['DRAFT', 'ISSUED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`inv.statuses.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('inv.type')} className="w-44" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {INVOICE_TYPES.map((x) => <option key={x} value={x}>{t(`inv.types.${x}`)}</option>)}
        </Select>
        <Select aria-label={t('inv.paymentFilter')} className="w-44" value={payment} onChange={(e) => reset(setPayment)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          <option value="unpaid">{t('inv.unpaid')}</option>
          <option value="overdue">{t('inv.overdue')}</option>
        </Select>
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('inv.noneMatching')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('inv.number')}</Th><Th>{t('files.client')}</Th><Th>{t('files.number')}</Th><Th>{t('inv.type')}</Th><Th>{t('common.status')}</Th><Th>{t('inv.dueDate')}</Th><Th>{t('inv.total')}</Th><Th>{t('inv.outstanding')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((inv) => (
                    <tr key={inv.id} className="hover:bg-slate-50">
                      <Td dir="ltr" className="font-medium tabular-nums">{inv.status === 'DRAFT' ? t('inv.draft') : inv.invoiceNumber}</Td>
                      <Td dir="auto">{inv.client ? <Link to={`/clients/${inv.client.id}`} className="text-brand-700 hover:underline">{inv.client.name}</Link> : '—'}</Td>
                      <Td dir="ltr" className="tabular-nums">{inv.clearanceFile ? <Link to={`/files/${inv.clearanceFile.id}`} className="text-brand-700 hover:underline">{inv.clearanceFile.fileNumber}</Link> : '—'}</Td>
                      <Td>{t(`inv.types.${inv.invoiceType}`)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={statusTone[inv.status]}>{t(`inv.statuses.${inv.status}`)}</Badge>
                          {inv.paymentStatus && <Badge tone={payTone[inv.paymentStatus]}>{t(`inv.payStatuses.${inv.paymentStatus}`)}</Badge>}
                          {inv.isOverdue && <Badge tone="red">{t('inv.overdue')}</Badge>}
                        </div>
                      </Td>
                      <Td>{formatDate(inv.dueDate, locale)}</Td>
                      <Td dir="ltr" className="tabular-nums">{formatMoney(inv.totalAmount, inv.currencyCode, locale)}</Td>
                      <Td dir="ltr" className="tabular-nums">{inv.status === 'ISSUED' ? formatMoney(inv.outstandingAmount, inv.currencyCode, locale) : '—'}</Td>
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
