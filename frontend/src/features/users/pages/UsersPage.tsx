import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { RolesTab } from '../components/RolesTab';
import { UsersTab } from '../components/UsersTab';

// The API lists users and roles for `users.manage`; `roles.manage` alone cannot list them.
const ALL_TABS = [{ key: 'users', permission: 'users.manage' }, { key: 'roles', permission: 'users.manage' }] as const;
type Tab = (typeof ALL_TABS)[number]['key'];

export function UsersPage() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [tab, setTab] = useState<Tab>('users');
  const tabs = ALL_TABS.filter((x) => can(permissions, x.permission));
  if (tabs.length === 0) return <p role="alert" className="p-8 text-center text-slate-600">{t('users.needUsersManage')}</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('users.title')}</h1>
      <div role="tablist" aria-label={t('files.sections')} className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ key: k }) => (
          <button
            key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
          >
            {t(`users.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'users' ? <UsersTab /> : <RolesTab />}</div>
    </div>
  );
}
