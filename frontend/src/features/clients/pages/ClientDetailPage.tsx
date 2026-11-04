import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, ErrorState, Spinner } from '@/components/ui/primitives';
import { AccountTab } from '../components/AccountTab';
import { ClientFilesTab } from '../components/ClientFilesTab';
import { ClientForm } from '../components/ClientForm';
import { ContactsTab } from '../components/ContactsTab';
import type { ClientDetail } from '../types';

const ALL_TABS = [
  { key: 'details' }, { key: 'contacts' }, { key: 'files', permission: ['clearance_files.view'] }, { key: 'account', permission: ['invoices.view', 'payments.view'] },
] as const;
type Tab = (typeof ALL_TABS)[number]['key'];

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-slate-500">{label}</dt><dd className="text-sm text-slate-900" dir="auto">{children || '—'}</dd></div>;
}

export function ClientDetailPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { id = '' } = useParams();
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('details');
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canManage = can(permissions, 'clients.manage');
  const tabs = ALL_TABS.filter((x) => !('permission' in x) || can(permissions, ...x.permission));
  const q = useQuery({ queryKey: ['client', id], queryFn: ({ signal }) => api.get<ClientDetail>(`/clients/${id}`, undefined, signal) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['client', id] }), qc.invalidateQueries({ queryKey: ['clients'] })]);
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => api.patch(`/clients/${id}`, { isActive }),
    onSuccess: async () => { setProblem(null); await refresh(); },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : t('common.error')),
  });

  if (q.isPending) return <Spinner />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <p className="p-8 text-center text-slate-600">{t('clients.notFound')}</p>;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const c = q.data;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link to="/clients" className="text-sm text-brand-700 hover:underline">{t('clients.title')}</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold" dir="auto">{c.name}</h1>
          <span className="text-sm tabular-nums text-slate-600" dir="ltr">{c.clientCode}</span>
          <Badge tone={c.isActive ? 'green' : 'neutral'}>{c.isActive ? t('common.active') : t('common.inactive')}</Badge>
          {canManage && (
            <Button variant="secondary" loading={toggle.isPending} onClick={() => toggle.mutate(!c.isActive)}>{c.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
          )}
        </div>
      </div>
      {problem && <Alert>{problem}</Alert>}

      <div role="tablist" aria-label={t('files.sections')} className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ key: k }) => (
          <button
            key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
          >
            {t(`clients.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'details' && (
          <Card className="p-5">
            {editing ? (
              <ClientForm client={c} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} />
            ) : (
              <div className="space-y-4">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <Item label={t('files.type')}>{t(`clients.types.${c.clientType}`)}</Item>
                  <Item label={t('clients.legalName')}>{c.legalName}</Item>
                  <Item label={t('clients.country')}><span dir="ltr">{c.countryCode}</span></Item>
                  <Item label={t('clients.taxNumber')}><span dir="ltr">{c.taxNumber}</span></Item>
                  <Item label={t('clients.registrationNumber')}><span dir="ltr">{c.registrationNumber}</span></Item>
                  <Item label={t('clients.phone')}><span dir="ltr">{c.phone}</span></Item>
                  <Item label={t('clients.email')}><span dir="ltr">{c.email}</span></Item>
                  <Item label={t('clients.paymentTerms')}>{t('clients.days', { count: c.paymentTermsDays })}</Item>
                  <Item label={t('clients.creditLimit')}>{c.creditLimit ? <span dir="ltr">{formatMoney(c.creditLimit, undefined, locale)}</span> : null}</Item>
                  <div className="sm:col-span-3"><Item label={t('clients.address')}>{c.address}</Item></div>
                  <div className="sm:col-span-3"><Item label={t('clients.notes')}>{c.notes}</Item></div>
                </dl>
                {canManage && <Button variant="secondary" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
              </div>
            )}
          </Card>
        )}
        {tab === 'contacts' && <ContactsTab client={c} canManage={canManage} />}
        {tab === 'files' && <ClientFilesTab clientId={c.id} />}
        {tab === 'account' && <AccountTab clientId={c.id} />}
      </div>
    </div>
  );
}
