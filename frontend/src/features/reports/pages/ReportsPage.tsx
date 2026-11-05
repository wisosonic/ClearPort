import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, download, type PageMeta } from '@/lib/api-client';
import { formatDate, formatMoney, formatNumber, type Locale } from '@/lib/format';
import { can, canAny } from '@/lib/permissions';
import { saveBlob } from '@/lib/save-blob';
import { useAuth } from '@/features/auth/auth';
import { useDebounced } from '@/hooks/useDebounced';
import { FinancialSummary } from './FinancialSummary';
import { Alert, Button, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';

type ReportKey = 'clearance-files' | 'client-balances' | 'expenses' | 'revenue' | 'employee-performance' | 'profitability' | 'financial-summary';
interface Column { key: string; header: { en: string; ar: string }; type: 'text' | 'money' | 'int' | 'date' | 'percent' }
interface ReportMeta extends PageMeta {
  title: { en: string; ar: string }; columns: Column[]; totals: Record<string, unknown> | null; baseCurrency?: string; note?: string;
  totalsByCurrency?: Record<string, Record<string, string>>;
}

/** What each report needs (the API checks the same permissions) and which filters it understands. */
const REPORTS: { key: ReportKey; all: string[]; search?: boolean; group?: boolean; onlyOpen?: boolean }[] = [
  { key: 'clearance-files', all: ['reports.view', 'clearance_files.view'], search: true },
  { key: 'client-balances', all: ['reports.view', 'invoices.view', 'payments.view'], onlyOpen: true },
  { key: 'expenses', all: ['reports.view', 'expenses.view'], search: true },
  { key: 'revenue', all: ['reports.view'], group: true },
  { key: 'employee-performance', all: ['reports.view', 'users.manage'] },
  { key: 'profitability', all: ['reports.view'] },
  { key: 'financial-summary', all: ['reports.view'] },
];
/** Profitability comes back as plain rows; these are its columns (amounts are in the base currency, named in each header). */
const PROFIT_COLUMNS: { key: string; type: Column['type'] }[] = [
  { key: 'fileNumber', type: 'text' }, { key: 'client', type: 'text' }, { key: 'status', type: 'text' }, { key: 'serviceRevenue', type: 'money' },
  { key: 'officeCosts', type: 'money' }, { key: 'profit', type: 'money' }, { key: 'marginPercent', type: 'percent' },
  { key: 'unrecoveredDisbursements', type: 'money' }, { key: 'fxGainLoss', type: 'money' },
];
const LIMIT = 20;
const ENUM_KEYS: Record<string, string> = { status: 'files.statuses', fileType: 'files.types', priority: 'files.priorities', paymentStatus: 'inv.payStatuses' };
/** Expense statuses are not file statuses. */
const enumNs = (report: ReportKey, key: string) => (report === 'expenses' && key === 'status' ? 'exp.statuses' : ENUM_KEYS[key]);

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const available = REPORTS.filter((r) => can(permissions, ...r.all));
  const [key, setKey] = useState<ReportKey>(available[0]?.key ?? 'revenue');
  const def = REPORTS.find((r) => r.key === key) ?? REPORTS[0];
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('month');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const filters = {
    from, to, search: def.search ? term : undefined, groupBy: def.group ? groupBy : undefined, onlyOpen: def.onlyOpen ? String(onlyOpen) : undefined,
  };

  const q = useQuery({
    queryKey: ['report', key, filters, page],
    queryFn: ({ signal }) => api.list<Record<string, unknown>>(`/reports/${key}`, { ...filters, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
    enabled: available.length > 0 && key !== 'financial-summary',
  });
  const exportFile = useMutation({
    mutationFn: async (format: 'xlsx' | 'csv' | 'pdf') => {
      const { blob, filename } = await download('/reports/export', { ...filters, report: key, format, locale });
      saveBlob(blob, filename ?? `${key}.${format}`);
    },
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const raw = q.data?.meta as ReportMeta | undefined;
  const rawBase = raw?.baseCurrency;
  const meta: ReportMeta | undefined = raw && key === 'profitability'
    ? {
      ...raw, title: { en: t('reports.names.profitability'), ar: t('reports.names.profitability') },
      columns: PROFIT_COLUMNS.map((c) => { const h = t(`reports.cols.${c.key}`) + (c.type === 'money' ? ` (${rawBase})` : ''); return { ...c, header: { en: h, ar: h } }; }),
    }
    : raw;
  const rows = key === 'profitability' ? (q.data?.data ?? []).map((r) => ({ ...r, client: (r.client as { name?: string } | null)?.name })) : q.data?.data ?? [];
  const base = meta?.baseCurrency;

  const cell = (c: Column, row: Record<string, unknown>) => {
    const v = row[c.key];
    if (v === null || v === undefined || v === '') return '—';
    switch (c.type) {
      case 'date': return formatDate(String(v), locale);
      case 'int': return formatNumber(String(v), locale);
      case 'percent': return `${formatNumber(String(v), locale)}%`;
      case 'money': {
        // Base-currency reports say so in the column header; transaction-currency rows carry their own currency.
        const cur = typeof row.currency === 'string' && c.key !== 'baseAmount' && c.key !== 'exchangeRate' ? row.currency : undefined;
        if (c.key === 'exchangeRate') return String(Number(v));
        return cur ? formatMoney(String(v), cur, locale) : formatMoney(String(v), base === 'LBP' ? 'LBP' : undefined, locale).replace(/ LBP$/, '');
      }
      default: {
        if (c.key === 'stage' && locale === 'ar' && typeof row.stageAr === 'string') return row.stageAr;
        const ns = enumNs(key, c.key);
        return ns ? t(`${ns}.${String(v)}`, { defaultValue: String(v) }) : String(v);
      }
    }
  };

  const totalLabel = (v: unknown) => (v === undefined || v === null || v === '' ? t('reports.total') : `${t('reports.total')} (${String(v)})`);

  if (available.length === 0) return <p role="alert" className="p-8 text-center text-slate-600">{t('common.forbidden')}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('reports.title')}</h1>
        {can(permissions, 'reports.export') && (
          <div className="flex gap-2">
            {(['xlsx', 'csv', 'pdf'] as const).map((f) => (
              <Button key={f} variant="secondary" loading={exportFile.isPending && exportFile.variables === f} onClick={() => exportFile.mutate(f)}>
                <Download className="size-4" aria-hidden />{t(`reports.export.${f}`)}
              </Button>
            ))}
          </div>
        )}
      </div>
      {exportFile.isError && <Alert>{exportFile.error instanceof ApiError ? exportFile.error.message : t('common.error')}</Alert>}

      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label={t('reports.report')} className="w-56" value={key} onChange={(e) => { setKey(e.target.value as ReportKey); setPage(1); setSearch(''); }}>
          {available.map((r) => <option key={r.key} value={r.key}>{t(`reports.names.${r.key}`)}</option>)}
        </Select>
        {def.search && (
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
            <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('common.search')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
          </div>
        )}
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        {def.group && (
          <Select aria-label={t('reports.groupBy')} className="w-40" value={groupBy} onChange={(e) => reset(setGroupBy)(e.target.value)}>
            <option value="month">{t('reports.byMonth')}</option>
            <option value="client">{t('reports.byClient')}</option>
          </Select>
        )}
        {def.onlyOpen && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyOpen} onChange={(e) => reset(setOnlyOpen)(e.target.checked)} />{t('reports.onlyOpen')}</label>}
      </div>

      {key === 'financial-summary' ? <FinancialSummary from={from} to={to} /> : (
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && meta && (
          <>
            <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">{meta.title[locale]}</h2>
            {meta.note && <p className="px-5 pt-3 text-xs text-slate-500">{meta.note}</p>}
            {rows.length === 0 ? <EmptyState>{t('reports.empty')}</EmptyState> : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-slate-200 bg-slate-50">
                      <tr>{meta.columns.map((c) => <Th key={c.key}>{c.header[locale]}</Th>)}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((row, i) => (
                        <tr key={i} className="hover:bg-slate-50">
                          {meta.columns.map((c) => <Td key={c.key} dir={c.type === 'text' ? 'auto' : 'ltr'} className={c.type === 'text' ? '' : 'tabular-nums'}>{cell(c, row)}</Td>)}
                        </tr>
                      ))}
                    </tbody>
                    {meta.totals && (
                      <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-medium">
                        <tr>{meta.columns.map((c, i) => <Td key={c.key} dir={c.type === 'text' ? 'auto' : 'ltr'} className="tabular-nums">{i === 0 && c.type === 'text' ? totalLabel(meta.totals?.[c.key]) : meta.totals?.[c.key] === undefined ? '' : cell(c, meta.totals as Record<string, unknown>)}</Td>)}</tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
              </>
            )}
            {meta.totalsByCurrency && (
              <div className="border-t border-slate-200 px-5 py-3 text-sm">
                <p className="mb-1 font-medium">{t('reports.totalsByCurrency')}</p>
                <ul className="space-y-0.5 text-slate-700">
                  {Object.entries(meta.totalsByCurrency).map(([metric, byCur]) => (
                    <li key={metric}>{meta.columns.find((c) => c.key === metric)?.header[locale] ?? metric}:{' '}
                      <span dir="ltr">{Object.entries(byCur).map(([c, v]) => formatMoney(v, c, locale)).join(' · ') || '—'}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </Card>
      )}
      {can(permissions, 'reports.view') && !canAny(permissions, 'reports.export') && <p className="text-xs text-slate-500">{t('reports.noExport')}</p>}
    </div>
  );
}
