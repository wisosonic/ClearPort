import { Fragment, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useDebounced } from '@/hooks/useDebounced';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import { SOURCES, type JournalEntry } from '../types';
import { JournalEntryForm } from './JournalEntryForm';

const statusTone = { DRAFT: 'neutral', POSTED: 'green', REVERSED: 'amber' } as const;
const LIMIT = 20;

function EntryDetail({ e, baseCurrency, onDone }: { e: JournalEntry; baseCurrency: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reverse = useMutation({
    mutationFn: () => api.post(`/accounting/journal-entries/${e.id}/reverse`, { reason: reason.trim() }),
    onSuccess: async () => { setReversing(false); setReason(''); setProblem(null); await Promise.all([qc.invalidateQueries({ queryKey: ['journal'] }), qc.invalidateQueries({ queryKey: ['trial-balance'] })]); onDone(); },
    onError: (x) => setProblem(x instanceof ApiError ? x.message : t('common.error')),
  });
  const canReverse = can(permissions, 'accounting.post') && e.sourceType === 'MANUAL' && e.status === 'POSTED';
  const m = (v: string, c: string) => (Number(v) ? formatMoney(v, c, locale) : '');

  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      <table className="w-full">
        <thead className="border-b border-slate-200 bg-white">
          <tr><Th>{t('acc.account')}</Th><Th>{t('inv.currency')}</Th><Th>{t('acc.debit')}</Th><Th>{t('acc.credit')}</Th><Th>{t('acc.debit')} ({baseCurrency})</Th><Th>{t('acc.credit')} ({baseCurrency})</Th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {e.lines.map((l) => (
            <tr key={l.id}>
              <Td dir="auto"><span dir="ltr" className="tabular-nums">{l.accountCode}</span> · {l.accountName}</Td>
              <Td dir="ltr">{l.currencyCode}</Td>
              <Td dir="ltr" className="tabular-nums">{m(l.debit, l.currencyCode)}</Td>
              <Td dir="ltr" className="tabular-nums">{m(l.credit, l.currencyCode)}</Td>
              <Td dir="ltr" className="tabular-nums">{m(l.baseDebit, baseCurrency)}</Td>
              <Td dir="ltr" className="tabular-nums">{m(l.baseCredit, baseCurrency)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.sourceType && e.sourceType !== 'MANUAL' && e.sourceType !== 'REVERSAL' && <p className="text-xs text-slate-500">{t('acc.sourceManaged', { source: t(`acc.sources.${e.sourceType}`, { defaultValue: e.sourceType }) })}</p>}
      {reversing ? (
        <div className="space-y-2">
          <label htmlFor={`rev-${e.id}`} className="block text-sm font-medium">{t('acc.reverseReason')}</label>
          <Textarea id={`rev-${e.id}`} dir="auto" value={reason} onChange={(x) => setReason(x.target.value)} />
          <div className="flex gap-2">
            <Button disabled={reason.trim().length < 3} loading={reverse.isPending} onClick={() => reverse.mutate()}>{t('acc.reverse')}</Button>
            <Button variant="secondary" onClick={() => { setReversing(false); setReason(''); }}>{t('common.back')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          {canReverse && <Button variant="secondary" onClick={() => setReversing(true)}>{t('acc.reverse')}</Button>}
          <Button variant="ghost" onClick={onDone}>{t('inv.hide')}</Button>
        </div>
      )}
    </div>
  );
}

export function JournalTab({ baseCurrency }: { baseCurrency: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['journal', { term, status, source, from, to, page }],
    queryFn: ({ signal }) => api.list<JournalEntry>('/accounting/journal-entries', { search: term, status, sourceType: source, from, to, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      {creating && <JournalEntryForm baseCurrency={baseCurrency} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await Promise.all([qc.invalidateQueries({ queryKey: ['journal'] }), qc.invalidateQueries({ queryKey: ['trial-balance'] })]); }} />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('acc.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('common.status')} className="w-36" value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {['POSTED', 'REVERSED'].map((s) => <option key={s} value={s}>{t(`acc.statuses.${s}`)}</option>)}
        </Select>
        <Select aria-label={t('acc.source')} className="w-40" value={source} onChange={(e) => reset(setSource)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {SOURCES.map((s) => <option key={s} value={s}>{t(`acc.sources.${s}`)}</option>)}
        </Select>
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        {can(permissions, 'accounting.post') && !creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('acc.newEntry')}</Button>}
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('acc.noEntries')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th><span className="sr-only">{t('inv.details')}</span></Th><Th>{t('inv.number')}</Th><Th>{t('pay.date')}</Th><Th>{t('inv.description')}</Th><Th>{t('acc.source')}</Th><Th>{t('common.status')}</Th><Th>{t('inv.total')} ({baseCurrency})</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((e) => {
                    const expanded = open === e.id;
                    return (
                      <Fragment key={e.id}>
                        <tr className="hover:bg-slate-50">
                          <Td>
                            <Button variant="ghost" aria-expanded={expanded} aria-label={`${expanded ? t('inv.hide') : t('inv.details')} ${e.entryNumber}`} onClick={() => setOpen(expanded ? null : e.id)}>
                              {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />}
                            </Button>
                          </Td>
                          <Td dir="ltr" className="font-medium tabular-nums">{e.entryNumber}</Td>
                          <Td>{formatDate(e.entryDate, locale)}</Td>
                          <Td dir="auto" className="max-w-sm break-words">{e.description}</Td>
                          <Td>{e.sourceType ? t(`acc.sources.${e.sourceType}`, { defaultValue: e.sourceType }) : '—'}</Td>
                          <Td><Badge tone={statusTone[e.status]}>{t(`acc.statuses.${e.status}`)}</Badge></Td>
                          <Td dir="ltr" className="tabular-nums">{formatMoney(e.totals.baseDebit, baseCurrency, locale)}</Td>
                        </tr>
                        {expanded && <tr><td colSpan={7} className="bg-slate-50 px-5 py-4"><EntryDetail e={e} baseCurrency={baseCurrency} onDone={() => setOpen(null)} /></td></tr>}
                      </Fragment>
                    );
                  })}
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
