import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { Alert, Badge, Card, EmptyState, ErrorState, Field, Input, Spinner, Td, Th } from '@/components/ui/primitives';
import type { TrialBalance } from '../types';

/** Every ledger account's debits, credits and balance in the office's base currency, up to a date. */
export function TrialBalanceTab() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [asOf, setAsOf] = useState('');
  const q = useQuery({
    queryKey: ['trial-balance', asOf],
    queryFn: ({ signal }) => api.get<TrialBalance>('/accounting/trial-balance', { asOf: asOf || undefined }, signal),
  });
  const m = (v: string) => formatMoney(v, q.data?.baseCurrency, locale);

  return (
    <div className="space-y-4">
      <div className="max-w-xs"><Field label={t('acc.asOf')} htmlFor="tb-asof"><Input id="tb-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field></div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (
          <>
            {!q.data.balanced && <Alert>{t('acc.unbalanced')}</Alert>}
            {q.data.lines.length === 0 ? <EmptyState>{t('acc.noEntries')}</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr><Th>{t('acc.account')}</Th><Th>{t('acc.name')}</Th><Th>{t('files.type')}</Th><Th>{t('acc.debit')}</Th><Th>{t('acc.credit')}</Th><Th>{t('acc.balance')}</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {q.data.lines.map((l) => (
                      <tr key={l.accountCode} className={l.isActive ? '' : 'text-slate-400'}>
                        <Td dir="ltr" className="tabular-nums">{l.accountCode}</Td>
                        <Td dir="auto">{l.name}</Td>
                        <Td>{t(`acc.types.${l.accountType}`)}</Td>
                        <Td dir="ltr" className="tabular-nums">{m(l.debit)}</Td>
                        <Td dir="ltr" className="tabular-nums">{m(l.credit)}</Td>
                        <Td dir="ltr" className="tabular-nums">{m(l.balance)}</Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-medium">
                    <tr>
                      <td colSpan={3} className="px-4 py-3 text-sm">{t('reports.total')} <Badge tone={q.data.balanced ? 'green' : 'red'} className="ms-2">{q.data.balanced ? t('acc.balanced') : t('acc.notBalanced')}</Badge></td>
                      <Td dir="ltr" className="tabular-nums">{m(q.data.totals.debit)}</Td>
                      <Td dir="ltr" className="tabular-nums">{m(q.data.totals.credit)}</Td>
                      <Td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
