import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface Entry {
  id: string; action: string; entityType: string; entityId: string | null; actor: { id: string; name: string | null; email: string | null } | null;
  before: unknown; after: unknown; ipAddress: string | null; userAgent: string | null; createdAt: string;
}
interface Person { id: string; firstName: string; lastName: string }

const LIMIT = 50;
/** The kinds of record the trail covers, for the filter. */
const ENTITY_TYPES = [
  'Branch', 'BusinessParty', 'CashAccount', 'ChartOfAccount', 'ClearanceFile', 'Client', 'Container', 'Document', 'DocumentRequirement', 'DocumentType', 'ExchangeRate', 'Expense', 'FinancialCategory',
  'GoodsItem', 'Invoice', 'JournalEntry', 'Payment', 'PaymentAllocation', 'Report', 'Role', 'Shipment', 'SystemSetting', 'Task', 'Tenant', 'User',
] as const;
/** Common actions, offered as suggestions; the filter takes any exact action code. */
const ACTIONS = [
  'AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'AUTH_PASSWORD_CHANGED', 'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'ROLE_PERMISSIONS_SET', 'CLEARANCE_FILE_STAGE_CHANGED', 'CLEARANCE_FILE_CLOSED', 'CLEARANCE_FILE_REOPENED',
  'DOCUMENT_UPLOADED', 'DOCUMENT_STATUS_CHANGED', 'DOCUMENT_VOIDED', 'DOCUMENT_DOWNLOADED', 'INVOICE_ISSUED', 'INVOICE_CANCELLED', 'PAYMENT_ALLOCATED', 'PAYMENT_CANCELLED', 'EXPENSE_APPROVED', 'EXPENSE_CANCELLED',
  'JOURNAL_ENTRY_POSTED', 'JOURNAL_ENTRY_REVERSED', 'EXCHANGE_RATE_RECORDED', 'TAX_SETTINGS_CHANGED', 'REPORT_EXPORTED', 'WORKFLOW_TRANSITION_CREATED',
];

/** "INVOICE_ISSUED" -> "Invoice issued"; "ClearanceFile" -> "Clearance file". */
export const humanize = (code: string) => {
  const words = code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const startOfDay = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 0, 0, 0).toISOString(); };
const endOfDay = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(); };

const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const show = (v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};
/** What changed: fields that differ between before and after, or all fields of a new record. Plumbing fields are left out. */
export function changedFields(before: unknown, after: unknown): { key: string; before: unknown; after: unknown }[] {
  const b = asRecord(before) ?? {};
  const a = asRecord(after) ?? {};
  const skip = new Set(['tenantId', 'updatedAt']);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k])).sort().map((key) => ({ key, before: b[key], after: a[key] }));
}

function Details({ e }: { e: Entry }) {
  const { t } = useTranslation();
  const rows = changedFields(e.before, e.after);
  return (
    <div className="space-y-3">
      {rows.length === 0 ? <p className="text-sm text-slate-500">{t('audit.noDetails')}</p> : (
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-white"><tr><Th>{t('audit.field')}</Th><Th>{t('audit.before')}</Th><Th>{t('audit.after')}</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.key}>
                <Td dir="ltr" className="font-mono text-xs">{r.key}</Td>
                <Td dir="auto" className="break-all">{show(r.before)}</Td>
                <Td dir="auto" className="break-all">{show(r.after)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
        <div><dt className="inline font-medium">{t('audit.ip')}: </dt><dd className="inline" dir="ltr">{e.ipAddress ?? '—'}</dd></div>
        <div className="break-all"><dt className="inline font-medium">{t('audit.device')}: </dt><dd className="inline" dir="ltr">{e.userAgent ?? '—'}</dd></div>
        {e.entityId && <div className="break-all"><dt className="inline font-medium">{t('audit.recordId')}: </dt><dd className="inline" dir="ltr">{e.entityId}</dd></div>}
      </dl>
    </div>
  );
}

/** The office's append-only trail of who did what. Read-only: nothing here can be changed or deleted. */
export function AuditPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actorUserId, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const people = useQuery({ queryKey: ['audit-actors'], queryFn: () => api.list<Person>('/users', { limit: 100 }), enabled: can(permissions, 'users.manage') });
  const q = useQuery({
    queryKey: ['audit', { action, entityType, actorUserId, from, to, page }],
    queryFn: ({ signal }) => api.list<Entry>('/audit-logs', {
      action: action.trim() || undefined, entityType, actorUserId, from: from ? startOfDay(from) : undefined, to: to ? endOfDay(to) : undefined, page, limit: LIMIT,
    }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('audit.title')}</h1>
        <p className="text-sm text-slate-600">{t('audit.intro')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Input aria-label={t('audit.action')} placeholder={t('audit.action')} list="audit-actions" dir="ltr" className="w-64" value={action} onChange={(e) => reset(setAction)(e.target.value)} />
          <datalist id="audit-actions">{ACTIONS.map((a) => <option key={a} value={a}>{humanize(a)}</option>)}</datalist>
        </div>
        <Select aria-label={t('audit.record')} className="w-48" value={entityType} onChange={(e) => reset(setEntityType)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {ENTITY_TYPES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </Select>
        {can(permissions, 'users.manage') && (
          <Select aria-label={t('audit.actor')} className="w-48" value={actorUserId} onChange={(e) => reset(setActor)(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {(people.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
          </Select>
        )}
        <Input type="date" aria-label={t('clients.from')} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={t('clients.to')} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('audit.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th><span className="sr-only">{t('inv.details')}</span></Th><Th>{t('audit.when')}</Th><Th>{t('audit.actor')}</Th><Th>{t('audit.action')}</Th><Th>{t('audit.record')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((e) => {
                    const expanded = open === e.id;
                    return (
                      <Fragment key={e.id}>
                        <tr className="hover:bg-slate-50">
                          <Td>
                            <Button variant="ghost" aria-expanded={expanded} aria-label={`${expanded ? t('inv.hide') : t('inv.details')} ${humanize(e.action)}`} onClick={() => setOpen(expanded ? null : e.id)}>
                              {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />}
                            </Button>
                          </Td>
                          <Td className="whitespace-nowrap">{formatDate(e.createdAt, locale, true)}</Td>
                          <Td dir="auto">{e.actor ? (e.actor.name ?? e.actor.email ?? '—') : <span className="text-slate-400">{t('audit.system')}</span>}{e.actor?.email && e.actor.name && <span className="block text-xs text-slate-500" dir="ltr">{e.actor.email}</span>}</Td>
                          <Td>{humanize(e.action)}</Td>
                          <Td>{humanize(e.entityType)}{e.entityId && <Badge tone="neutral" className="ms-2"><span dir="ltr" className="font-mono">{e.entityId.slice(0, 8)}</span></Badge>}</Td>
                        </tr>
                        {expanded && <tr><td colSpan={5} className="bg-slate-50 px-5 py-4"><Details e={e} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
          </>
        ))}
      </Card>
    </div>
  );
}
