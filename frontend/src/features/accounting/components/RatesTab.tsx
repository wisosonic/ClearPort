import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import type { Currency } from '@/features/clearance-files/components/invoices/types';
import { Alert, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface Rate { id: string; fromCurrency: string; toCurrency: string; rate: string; convention: 'BASE_PER_FOREIGN' | 'FOREIGN_PER_BASE'; effectiveAt: string; source: string | null }
const RATE = /^\d+(\.\d{1,10})?$/;
/** "89500.0000000000" -> "89500", "1.0850000000" -> "1.085" */
const plain = (r: string) => r.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function AddRate({ base, onDone }: { base: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [currency, setCurrency] = useState('');
  const [rate, setRate] = useState('');
  const [convention, setConvention] = useState('');
  const [source, setSource] = useState('');
  const [touched, setTouched] = useState(false);
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const foreign = (currencies.data ?? []).filter((c) => c.code !== base);
  const rateBad = !RATE.test(rate.trim()) || Number(rate) <= 0;
  const save = useMutation({
    mutationFn: () => api.post('/exchange-rates', { currency, rate: rate.trim(), ...(convention ? { convention } : {}), ...(source.trim() ? { source: source.trim() } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['rates'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (currency && !rateBad) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('acc.recordRate')}</h2>
        <p className="text-xs text-slate-500">{t('acc.rateAppendOnly')}</p>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t('inv.currency')} htmlFor="rate-cur" error={touched && !currency ? t('acc.pickCurrency') : undefined}>
            <Select id="rate-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}><option value="" />{foreign.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
          </Field>
          <Field label={t('acc.rate')} htmlFor="rate-value" error={touched && rateBad ? t('acc.rateInvalid') : undefined}><Input id="rate-value" inputMode="decimal" dir="ltr" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <Field label={t('acc.convention')} htmlFor="rate-conv" hint={t('acc.conventionHint')}>
            <Select id="rate-conv" value={convention} onChange={(e) => setConvention(e.target.value)}>
              <option value="">{t('acc.automatic')}</option>
              <option value="BASE_PER_FOREIGN">{t('acc.basePerForeign', { base })}</option>
              <option value="FOREIGN_PER_BASE">{t('acc.foreignPerBase', { base })}</option>
            </Select>
          </Field>
          <Field label={t('acc.rateSource')} htmlFor="rate-source"><Input id="rate-source" dir="auto" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

export function RatesTab({ baseCurrency }: { baseCurrency: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const canPost = can(permissions, 'accounting.post');
  const q = useQuery({ queryKey: ['rates', filter], queryFn: ({ signal }) => api.get<Rate[]>('/exchange-rates', { currency: filter || undefined }, signal) });
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const meaning = (r: Rate) => (r.convention === 'BASE_PER_FOREIGN' ? `1 ${r.fromCurrency} = ${plain(r.rate)} ${r.toCurrency}` : `1 ${r.toCurrency} = ${plain(r.rate)} ${r.fromCurrency}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label={t('inv.currency')} className="w-40" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {(currencies.data ?? []).filter((c) => c.code !== baseCurrency).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </Select>
        {canPost && !adding && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('acc.recordRate')}</Button>}
      </div>
      {adding && <AddRate base={baseCurrency} onDone={() => setAdding(false)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('acc.noRates')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr><Th>{t('inv.currency')}</Th><Th>{t('acc.rate')}</Th><Th>{t('acc.effective')}</Th><Th>{t('acc.rateSource')}</Th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.map((r) => (
                  <tr key={r.id}>
                    <Td dir="ltr" className="font-medium">{r.fromCurrency}</Td>
                    <Td dir="ltr" className="tabular-nums">{meaning(r)}</Td>
                    <Td>{formatDate(r.effectiveAt, locale, true)}</Td>
                    <Td dir="auto">{r.source ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
