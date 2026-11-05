import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { Card, ErrorState, Spinner } from '@/components/ui/primitives';

interface Summary {
  baseCurrency: string;
  position: { receivables: string; clientAdvancesHeld: string; unrecoveredDisbursements: string; payables: string; taxesPayable: string; cashAndBankBase: string };
  results: { serviceRevenue: string; officeExpenses: string; operatingResult: string; fxGainLoss: string };
  transactionCurrency: { invoiced: Record<string, string>; received: Record<string, string>; refunded: Record<string, string> };
}

const perCurrency = (m: Record<string, string>, locale: Locale) => Object.entries(m).map(([c, v]) => formatMoney(v, c, locale)).join(' · ') || '—';

/** The office's position and results for a period, in the base currency; document totals stay in their own currencies. */
export function FinancialSummary({ from, to }: { from: string; to: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const q = useQuery({ queryKey: ['financial-summary', from, to], queryFn: ({ signal }) => api.get<Summary>('/reports/financial-summary', { from, to }, signal) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const money = (v: string) => formatMoney(v, s.baseCurrency, locale);
  const Block = ({ title, note, rows }: { title: string; note: string; rows: [string, string, boolean?][] }) => (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      <p className="mb-2 text-xs text-slate-500">{note}</p>
      <dl>{rows.map(([label, value, strong]) => (
        <div key={label} className={`flex items-baseline justify-between gap-4 py-1.5 text-sm ${strong ? 'border-t border-slate-200 font-semibold' : ''}`}>
          <dt className="text-slate-600">{label}</dt><dd dir="ltr" className="tabular-nums">{value}</dd>
        </div>
      ))}</dl>
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Block title={t('fin.position')} note={t('fin.positionNote', { currency: s.baseCurrency })} rows={[
          [t('fin.receivables'), money(s.position.receivables)], [t('fin.advances'), money(s.position.clientAdvancesHeld)],
          [t('fin.unrecovered'), money(s.position.unrecoveredDisbursements)], [t('fin.payables'), money(s.position.payables)],
          [t('fin.taxes'), money(s.position.taxesPayable)], [t('fin.cash'), money(s.position.cashAndBankBase), true],
        ]} />
        <Block title={t('fin.results')} note={t('fin.resultsNote', { currency: s.baseCurrency })} rows={[
          [t('fin.revenue'), money(s.results.serviceRevenue)], [t('fin.expenses'), money(s.results.officeExpenses)],
          [t('fin.operating'), money(s.results.operatingResult), true], [t('fin.fx'), money(s.results.fxGainLoss)],
        ]} />
      </div>
      <Block title={t('fin.documents')} note={t('fin.documentsNote')} rows={[
        [t('fin.invoiced'), perCurrency(s.transactionCurrency.invoiced, locale)], [t('fin.received'), perCurrency(s.transactionCurrency.received, locale)],
        [t('fin.refunded'), perCurrency(s.transactionCurrency.refunded, locale)],
      ]} />
    </div>
  );
}
