import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatMoney, formatNumber, type Locale } from '@/lib/format';
import { Card, ErrorState, Spinner, Td, Th } from '@/components/ui/primitives';
import type { FileDetail } from '../lib';

interface Costs {
  baseCurrency: string;
  profitability: { serviceRevenue: string; officeCosts: string; profit: string; marginPercent: string | null };
  passThrough: { disbursed: string; reBilled: string; unrecovered: string; unbilledExpenses: { id: string; description: string; amount: string; currencyCode: string; baseAmount: string }[] };
  taxCollected: string;
  fxGainLoss: string;
  receivables: { outstandingBase: string };
  invoices: { count: number; invoicedByCurrency: Record<string, string>; paidByCurrency: Record<string, string>; outstandingByCurrency: Record<string, string> };
}

const perCurrency = (m: Record<string, string>, locale: Locale) => Object.entries(m).map(([c, v]) => formatMoney(v, c, locale)).join(' · ') || '—';

/** What this one file earned and cost the office, straight from the books. Pass-through money is shown apart from profit. */
export function CostsTab({ file }: { file: FileDetail }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const q = useQuery({ queryKey: ['file-costs', file.id], queryFn: ({ signal }) => api.get<Costs>(`/clearance-files/${file.id}/costs`, undefined, signal) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const money = (v: string) => formatMoney(v, c.baseCurrency, locale);
  const Row = ({ label, value, strong }: { label: string; value: string; strong?: boolean }) => (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 text-sm ${strong ? 'border-t border-slate-200 font-semibold' : ''}`}>
      <dt className="text-slate-600">{label}</dt><dd dir="ltr" className="tabular-nums">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('costs.profit')}</h2>
          <dl>
            <Row label={t('costs.serviceRevenue')} value={money(c.profitability.serviceRevenue)} />
            <Row label={t('costs.officeCosts')} value={money(c.profitability.officeCosts)} />
            <Row strong label={t('costs.profitLine')} value={money(c.profitability.profit)} />
            <Row label={t('costs.margin')} value={c.profitability.marginPercent === null ? '—' : `${formatNumber(c.profitability.marginPercent, locale)}%`} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">{t('costs.profitNote', { currency: c.baseCurrency })}</p>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('costs.passThrough')}</h2>
          <dl>
            <Row label={t('costs.disbursed')} value={money(c.passThrough.disbursed)} />
            <Row label={t('costs.reBilled')} value={money(c.passThrough.reBilled)} />
            <Row strong label={t('costs.unrecovered')} value={money(c.passThrough.unrecovered)} />
            <Row label={t('costs.tax')} value={money(c.taxCollected)} />
            <Row label={t('costs.fx')} value={money(c.fxGainLoss)} />
          </dl>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('costs.invoicing', { count: c.invoices.count })}</h2>
        <dl>
          <Row label={t('costs.invoiced')} value={perCurrency(c.invoices.invoicedByCurrency, locale)} />
          <Row label={t('costs.paid')} value={perCurrency(c.invoices.paidByCurrency, locale)} />
          <Row strong label={t('costs.outstanding')} value={perCurrency(c.invoices.outstandingByCurrency, locale)} />
        </dl>
      </Card>

      {c.passThrough.unbilledExpenses.length > 0 && (
        <Card className="overflow-hidden">
          <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">{t('costs.unbilled')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50"><tr><Th>{t('inv.description')}</Th><Th>{t('inv.amount')}</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {c.passThrough.unbilledExpenses.map((e) => (
                  <tr key={e.id}><Td dir="auto">{e.description}</Td><Td dir="ltr" className="tabular-nums">{formatMoney(e.amount, e.currencyCode, locale)}</Td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
