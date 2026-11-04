import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { Expense } from '@/features/clearance-files/components/expenses/ExpenseForm';
import type { Category } from '@/features/clearance-files/components/invoices/types';

type Row = Expense & { clearanceFile: { id: string; fileNumber: string } | null; vendor: { id: string; name: string } | null };
const statusTone = { DRAFT: 'neutral', APPROVED: 'green', CANCELLED: 'red' } as const;
const payTone = { UNPAID: 'amber', PARTIALLY_PAID: 'amber', PAID: 'green' } as const;
const LIMIT = 20;

/** Every expense in the office. Recording and approving happen on the file page, which each row links to. */
export function ExpensesPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [paymentStatus, setPaymentStatus] = useState('');
  const [billed, setBilled] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const categories = useQuery({ queryKey: ['financial-categories'], queryFn: () => api.get<Category[]>('/financial-categories') });
  const q = useQuery({
    queryKey: ['expenses', { term, status, paymentStatus, billed, categoryId, from, to, page }],
    queryFn: ({ signal }) => api.list<Row>('/expenses', { search: term, status, paymentStatus, billed, categoryId, from, to, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('exp.title')}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('lists.expenseSearch')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('common.status')} className="w-36" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['DRAFT', 'APPROVED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`exp.statuses.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('lists.paid')} className="w-40" value={paymentStatus} onChange={(e) => reset(setPaymentStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['UNPAID', 'PARTIALLY_PAID', 'PAID'].map((s) => <option key={s} value={s}>{t(`inv.payStatuses.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('lists.rebilled')} className="w-44" value={billed} onChange={(e) => reset(setBilled)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          <option value="false">{t('lists.notBilled')}</option>
          <option value="true">{t('lists.billed')}</option>
        </Select>
        <Select aria-label={t('inv.category')} className="w-48" value={categoryId} onChange={(e) => reset(setCategoryId)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {(categories.data ?? []).filter((c) => c.costTreatment !== 'OFFICE_REVENUE').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('lists.noExpenses')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('pay.date')}</Th><Th>{t('inv.description')}</Th><Th>{t('files.number')}</Th><Th>{t('inv.category')}</Th><Th>{t('pay.amount')}</Th><Th>{t('common.status')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <Td>{formatDate(e.expenseDate, locale)}</Td>
                      <Td dir="auto" className="font-medium">{e.description}</Td>
                      <Td dir="ltr" className="tabular-nums">{e.clearanceFile ? <Link to={`/files/${e.clearanceFile.id}`} className="text-brand-700 hover:underline">{e.clearanceFile.fileNumber}</Link> : '—'}</Td>
                      <Td dir="auto">{e.category?.name ?? '—'}</Td>
                      <Td dir="ltr" className="tabular-nums">{formatMoney(e.amount, e.currencyCode, locale)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={statusTone[e.status]}>{t(`exp.statuses.${e.status}`)}</Badge>
                          {e.status === 'APPROVED' && <Badge tone={payTone[e.paymentStatus]}>{t(`inv.payStatuses.${e.paymentStatus}`)}</Badge>}
                          {e.isBilled && <Badge tone="blue">{t('exp.billedOn', { number: e.billedOn?.invoiceNumber })}</Badge>}
                        </div>
                      </Td>
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
