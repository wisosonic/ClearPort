import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { BranchesTab } from '../components/BranchesTab';
import { CategoriesTab } from '../components/CategoriesTab';
import { DocumentTypesTab } from '../components/DocumentTypesTab';
import { OfficeTab } from '../components/OfficeTab';
import { RequirementsTab } from '../components/RequirementsTab';
import { TaxTab } from '../components/TaxTab';
import { WorkflowsTab } from '../components/WorkflowsTab';

// Each tab needs the permission the API asks for: office settings, or workflow configuration.
const ALL_TABS = [
  { key: 'office', permission: 'settings.manage' }, { key: 'branches', permission: 'settings.manage' }, { key: 'tax', permission: 'settings.manage' },
  { key: 'categories', permission: 'settings.manage' }, { key: 'documentTypes', permission: 'settings.manage' },
  { key: 'workflows', permission: 'workflows.manage' }, { key: 'requirements', permission: 'workflows.manage' },
] as const;
type Tab = (typeof ALL_TABS)[number]['key'];

export function SettingsPage() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const tabs = ALL_TABS.filter((x) => can(permissions, x.permission));
  const [chosen, setTab] = useState<Tab | null>(null);
  const tab = chosen && tabs.some((x) => x.key === chosen) ? chosen : tabs[0]?.key;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('settings.title')}</h1>
      <div role="tablist" aria-label={t('files.sections')} className="flex flex-wrap gap-1 border-b border-slate-200">
        {tabs.map(({ key: k }) => (
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
        {tab === 'documentTypes' && <DocumentTypesTab />}
        {tab === 'workflows' && <WorkflowsTab />}
        {tab === 'requirements' && <RequirementsTab />}
      </div>
    </div>
  );
}
