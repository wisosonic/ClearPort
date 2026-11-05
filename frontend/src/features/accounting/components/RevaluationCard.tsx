import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { Alert, Button, Card, Field, Input, Td, Th } from '@/components/ui/primitives';

interface Result {
  asOf: string; baseCurrency: string; netGainLoss: string; entry: { id: string; entryNumber: string } | null;
  adjustments: { accountCode: string; accountName: string; currency: string; foreignBalance: string; carriedBase: string; revaluedBase: string; difference: string }[];
  skipped: { accountCode: string; currency: string; reason: string }[];
}
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Period-end revaluation: shows what the foreign balances are worth at the rates on file, then books the difference as an unrealised exchange gain or loss. */
export function RevaluationCard() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const [asOf, setAsOf] = useState(localToday());
  const [result, setResult] = useState<Result | null>(null);
  const run = useMutation({
    mutationFn: (preview: boolean) => api.post<Result>('/accounting/revaluation', { asOf, preview }),
    onSuccess: async (r, preview) => {
      setResult(r);
      if (!preview) await Promise.all([qc.invalidateQueries({ queryKey: ['journal'] }), qc.invalidateQueries({ queryKey: ['trial-balance'] }), qc.invalidateQueries({ queryKey: ['accounts'] })]);
    },
  });
  const money = (v: string) => formatMoney(v, result?.baseCurrency, locale);
  const posted = result?.entry ?? null;
  return (
    <Card className="space-y-3 p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">{t('acc.reval.title')}</h2>
        <p className="text-xs text-slate-500">{t('acc.reval.intro')}</p>
      </div>
      {run.isError && <Alert>{run.error instanceof ApiError ? run.error.message : t('common.error')}</Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('acc.reval.asOf')} htmlFor="reval-date"><Input id="reval-date" type="date" className="w-44" value={asOf} onChange={(e) => { setAsOf(e.target.value); setResult(null); }} /></Field>
        <Button variant="secondary" disabled={!asOf} loading={run.isPending && run.variables === true} onClick={() => run.mutate(true)}>{t('acc.reval.preview')}</Button>
      </div>

      {result && (
        <div className="space-y-3">
          {posted && <Alert tone="green">{t('acc.reval.posted', { number: posted.entryNumber })}</Alert>}
          {result.skipped.map((s) => <Alert key={`${s.accountCode}${s.currency}`} tone="amber">{s.reason} ({s.accountCode})</Alert>)}
          {result.adjustments.length === 0 ? <p className="text-sm text-slate-600">{t('acc.reval.nothing')}</p> : (
            <>
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full">
                  <thead className="bg-slate-50"><tr><Th>{t('acc.account')}</Th><Th>{t('inv.currency')}</Th><Th>{t('acc.reval.foreign')}</Th><Th>{t('acc.reval.carried', { currency: result.baseCurrency })}</Th><Th>{t('acc.reval.worth', { currency: result.baseCurrency })}</Th><Th>{t('acc.reval.difference')}</Th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.adjustments.map((a) => (
                      <tr key={`${a.accountCode}${a.currency}`}>
                        <Td dir="ltr">{a.accountCode} <span className="text-xs text-slate-500">{a.accountName}</span></Td>
                        <Td dir="ltr">{a.currency}</Td>
                        <Td dir="ltr" className="tabular-nums">{formatMoney(a.foreignBalance, a.currency, locale)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(a.carriedBase)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(a.revaluedBase)}</Td>
                        <Td dir="ltr" className="tabular-nums font-medium">{money(a.difference)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm font-medium">{!result.netGainLoss.startsWith('-') ? t('acc.reval.gain', { amount: money(result.netGainLoss) }) : t('acc.reval.loss', { amount: money(result.netGainLoss.replace('-', '')) })}</p>
              {!posted && <Button loading={run.isPending && run.variables === false} onClick={() => run.mutate(false)}>{t('acc.reval.post')}</Button>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}
