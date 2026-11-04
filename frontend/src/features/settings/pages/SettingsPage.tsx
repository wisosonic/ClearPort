import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { BranchesTab } from '../components/BranchesTab';
import { CategoriesTab } from '../components/CategoriesTab';
import { OfficeTab } from '../components/OfficeTab';
import { TaxTab } from '../components/TaxTab';

const TABS = ['office', 'branches', 'tax', 'categories'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('office');
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
      <div role="tablist" aria-label={t('files.sections')} className="flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((k) => (
          <button
            key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
          >
            {t(`settings.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'office' && <OfficeTab />}
        {tab === 'branches' && <BranchesTab />}
        {tab === 'tax' && <TaxTab />}
        {tab === 'categories' && <CategoriesTab />}
      </div>
    </div>
  );
}
