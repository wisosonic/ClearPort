import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Badge, Card, ErrorState, Spinner } from '@/components/ui/primitives';
import { AssignControl } from '../components/AssignControl';
import { ActivityTab, StageHistoryTab } from '../components/HistoryTabs';
import { FileTasksTab } from '../components/FileTasksTab';
import { OverviewTab } from '../components/OverviewTab';
import { ExpensesTab } from '../components/expenses/ExpensesTab';
import { PaymentsTab } from '../components/payments/PaymentsTab';
import { InvoicesTab } from '../components/invoices/InvoicesTab';
import { DocumentsTab } from '../components/documents/DocumentsTab';
import { ShipmentsTab } from '../components/shipments/ShipmentsTab';
import { StagePanel } from '../components/StagePanel';
import { priorityTone, statusTone, type FileDetail } from '../lib';

const ALL_TABS = [
  { key: 'overview' }, { key: 'shipments' }, { key: 'documents', permission: 'documents.view' }, { key: 'tasks', permission: 'tasks.view' }, { key: 'invoices', permission: 'invoices.view' }, { key: 'payments', permission: 'payments.view' }, { key: 'expenses', permission: 'expenses.view' }, { key: 'activity' }, { key: 'stages' },
] as const;
type Tab = (typeof ALL_TABS)[number]['key'];

export function FileDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { permissions } = useAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const tabs = ALL_TABS.filter((x) => !('permission' in x) || can(permissions, x.permission));
  const q = useQuery({ queryKey: ['file', id], queryFn: ({ signal }) => api.get<FileDetail>(`/clearance-files/${id}`, undefined, signal) });

  if (q.isPending) return <Spinner />;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <p className="p-8 text-center text-slate-600">{t('files.notFound')}</p>;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const file = q.data;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link to="/files" className="text-sm text-brand-700 hover:underline">{t('files.title')}</Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tabular-nums" dir="ltr">{file.fileNumber}</h1>
          <Badge tone={statusTone[file.status]}>{t(`files.statuses.${file.status}`)}</Badge>
          <Badge tone={priorityTone[file.priority as keyof typeof priorityTone] ?? 'neutral'}>{t(`files.priorities.${file.priority}`)}</Badge>
          <span className="text-sm text-slate-600" dir="auto">{file.client.name}</span>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><StagePanel file={file} /></div>
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">{t('files.assignee')}</h2>
          <AssignControl file={file} />
        </Card>
      </div>

      <div role="tablist" aria-label={t('files.sections')} className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ key: k }) => (
          <button
            key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
          >
            {t(`files.tabs.${k}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'overview' && <OverviewTab file={file} />}
        {tab === 'shipments' && <ShipmentsTab file={file} />}
        {tab === 'documents' && <DocumentsTab file={file} />}
        {tab === 'tasks' && <FileTasksTab file={file} />}
        {tab === 'invoices' && <InvoicesTab file={file} />}
        {tab === 'payments' && <PaymentsTab file={file} />}
        {tab === 'expenses' && <ExpensesTab file={file} />}
        {tab === 'activity' && <ActivityTab fileId={file.id} />}
        {tab === 'stages' && <StageHistoryTab fileId={file.id} />}
      </div>
    </div>
  );
}
