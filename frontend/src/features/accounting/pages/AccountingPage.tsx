import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { CashAccountsTab } from '../components/CashAccountsTab';
import { ChartTab } from '../components/ChartTab';
import { JournalTab } from '../components/JournalTab';
import { RatesTab } from '../components/RatesTab';
import { TrialBalanceTab } from '../components/TrialBalanceTab';

const ALL_TABS = [
  { key: 'journal' }, { key: 'trial' }, { key: 'chart' }, { key: 'cash', permission: 'payments.view' }, { key: 'rates' },
] as const;
type Tab = (typeof ALL_TABS)[number]['key'];

export function AccountingPage() {
  const { t } = useTranslation();
  const { me, permissions } = useAuth();
  const [tab, setTab] = useState<Tab>('journal');
  const base = me?.tenant.defaultCurrency ?? 'USD';
  const tabs = ALL_TABS.filter((x) => !('permission' in x) || can(permissions, x.permission));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('acc.title')}</h1>
      <div role="tablist" aria-label={t('files.sections')} className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(({ key: k }) => (
          <button
            key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
          >
            {t(`acc.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'journal' && <JournalTab baseCurrency={base} />}
        {tab === 'trial' && <TrialBalanceTab />}
        {tab === 'chart' && <ChartTab />}
        {tab === 'cash' && <CashAccountsTab baseCurrency={base} />}
        {tab === 'rates' && <RatesTab baseCurrency={base} />}
      </div>
    </div>
  );
}
