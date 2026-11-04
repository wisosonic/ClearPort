import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { useAuth } from '@/features/auth/auth';
import { JournalTab } from '../components/JournalTab';
import { TrialBalanceTab } from '../components/TrialBalanceTab';

const TABS = ['journal', 'trial'] as const;
type Tab = (typeof TABS)[number];

export function AccountingPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [tab, setTab] = useState<Tab>('journal');
  const base = me?.tenant.defaultCurrency ?? 'USD';
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('acc.title')}</h1>
      <div role="tablist" aria-label={t('files.sections')} className="flex gap-1 border-b border-slate-200">
        {TABS.map((k) => (
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
      </div>
    </div>
  );
}
