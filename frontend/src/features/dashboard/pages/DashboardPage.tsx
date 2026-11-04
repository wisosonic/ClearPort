import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatMoney, formatNumber, type Locale } from '@/lib/format';
import { Card, ErrorState, Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/auth';

interface Overview {
  files: { open: number; onHold: number; closed: number; cancelled: number; highPriority: number; unassigned: number; openedThisMonth: number; closedThisMonth: number };
  tasks?: { myOpen: number; myOverdue: number; officeOverdue: number };
  documents?: { pendingReview: number };
  finance?: {
    baseCurrency: string; receivables: string; clientAdvancesHeld: string; unrecoveredDisbursements: string; cashAndBankBase: string;
    unpaidInvoices: { count: number; outstandingByCurrency: Record<string, string> };
    overdueInvoices: { count: number; outstandingByCurrency: Record<string, string> };
  };
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-700' : 'text-slate-900'}`} dir="auto">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500" dir="auto">{sub}</div>}
    </Card>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-3"><h2 className="text-sm font-semibold text-slate-600">{title}</h2><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{children}</div></section>
);

/** "100.00 USD · 5,000,000 LBP": totals are never added across currencies. */
const perCurrency = (m: Record<string, string>, locale: Locale) => Object.entries(m).map(([c, v]) => formatMoney(v, c, locale)).join(' · ') || '—';

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const { me } = useAuth();
  const locale = i18n.language as Locale;
  const q = useQuery({ queryKey: ['dashboard', 'overview', me?.tenant.id], queryFn: () => api.get<Overview>('/dashboard/overview') });
  const n = (v: number) => formatNumber(v, locale);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t('dashboard.title')}</h1>
        <p className="text-sm text-slate-500">{t('dashboard.welcome', { name: me?.user.firstName })}</p>
      </div>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <>
          <Section title={t('dashboard.operations')}>
            <Stat label={t('dashboard.filesOpen')} value={n(q.data.files.open)} sub={`${t('dashboard.openedThisMonth')}: ${n(q.data.files.openedThisMonth)}`} />
            <Stat label={t('dashboard.filesOnHold')} value={n(q.data.files.onHold)} />
            <Stat label={t('dashboard.filesHighPriority')} value={n(q.data.files.highPriority)} tone={q.data.files.highPriority > 0 ? 'warn' : undefined} />
            <Stat label={t('dashboard.filesUnassigned')} value={n(q.data.files.unassigned)} sub={`${t('dashboard.closedThisMonth')}: ${n(q.data.files.closedThisMonth)}`} />
          </Section>
          {(q.data.tasks || q.data.documents) && (
            <Section title={t('dashboard.tasksAndDocs')}>
              {q.data.tasks && <>
                <Stat label={t('dashboard.myTasks')} value={n(q.data.tasks.myOpen)} />
                <Stat label={t('dashboard.myOverdue')} value={n(q.data.tasks.myOverdue)} tone={q.data.tasks.myOverdue > 0 ? 'warn' : undefined} />
                <Stat label={t('dashboard.officeOverdue')} value={n(q.data.tasks.officeOverdue)} tone={q.data.tasks.officeOverdue > 0 ? 'warn' : undefined} />
              </>}
              {q.data.documents && <Stat label={t('dashboard.pendingReview')} value={n(q.data.documents.pendingReview)} />}
            </Section>
          )}
          {q.data.finance && (
            <Section title={t('dashboard.financial')}>
              <Stat label={t('dashboard.receivables')} value={formatMoney(q.data.finance.receivables, q.data.finance.baseCurrency, locale)} />
              <Stat label={t('dashboard.advances')} value={formatMoney(q.data.finance.clientAdvancesHeld, q.data.finance.baseCurrency, locale)} />
              <Stat label={t('dashboard.unrecovered')} value={formatMoney(q.data.finance.unrecoveredDisbursements, q.data.finance.baseCurrency, locale)} />
              <Stat label={t('dashboard.cash')} value={formatMoney(q.data.finance.cashAndBankBase, q.data.finance.baseCurrency, locale)} />
              <Stat label={t('dashboard.unpaidInvoices')} value={n(q.data.finance.unpaidInvoices.count)} sub={perCurrency(q.data.finance.unpaidInvoices.outstandingByCurrency, locale)} />
              <Stat label={t('dashboard.overdueInvoices')} value={n(q.data.finance.overdueInvoices.count)} sub={perCurrency(q.data.finance.overdueInvoices.outstandingByCurrency, locale)} tone={q.data.finance.overdueInvoices.count > 0 ? 'warn' : undefined} />
            </Section>
          )}
        </>
      )}
    </div>
  );
}
