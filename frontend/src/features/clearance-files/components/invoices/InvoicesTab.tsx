import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Pagination, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import type { FileDetail } from '../../lib';
import { InvoiceForm } from './InvoiceForm';
import type { Invoice } from './types';

const statusTone = { DRAFT: 'neutral', ISSUED: 'blue', CANCELLED: 'red' } as const;
const payTone = { UNPAID: 'amber', PARTIALLY_PAID: 'amber', PAID: 'green' } as const;
const LIMIT = 20;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function useRefresh(fileId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['file-invoices', fileId] }),
    qc.invalidateQueries({ queryKey: ['invoice'] }),
    qc.invalidateQueries({ queryKey: ['file-expenses-billable', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-closure', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
  ]);
}

function Totals({ inv, locale }: { inv: Invoice; locale: Locale }) {
  const { t } = useTranslation();
  const m = (v: string) => formatMoney(v, inv.currencyCode, locale);
  const rows: [string, string][] = [[t('inv.subtotal'), inv.subtotal], [t('inv.discount'), inv.discount], [t('inv.tax'), inv.taxAmount], [t('inv.total'), inv.totalAmount]];
  if (inv.status === 'ISSUED') rows.push([t('inv.paid'), inv.paidAmount], [t('inv.outstanding'), inv.outstandingAmount]);
  return (
    <dl className="ms-auto grid max-w-xs grid-cols-2 gap-x-6 gap-y-1 text-sm">
      {rows.map(([label, v]) => (
        <div key={label} className="contents"><dt className="text-slate-600">{label}</dt><dd dir="ltr" className="text-end tabular-nums">{m(v)}</dd></div>
      ))}
    </dl>
  );
}

function InvoiceDetail({ id, fileId, baseCurrency, editable, onClose }: { id: string; fileId: string; baseCurrency: string; editable: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const refresh = useRefresh(fileId);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['invoice', id], queryFn: ({ signal }) => api.get<Invoice>(`/invoices/${id}`, undefined, signal) });
  const fail = (e: unknown) => setProblem(errText(e, t('common.error')));

  const issue = useMutation({ mutationFn: () => api.post(`/invoices/${id}/issue`, {}), onSuccess: async () => { setProblem(null); await refresh(); }, onError: fail });
  const cancel = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/cancel`, { reason: reason.trim() }),
    onSuccess: async () => { setCancelling(false); setReason(''); setProblem(null); await refresh(); }, onError: fail,
  });

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const inv = q.data;
  const canCreate = editable && can(permissions, 'invoices.create');
  const canIssue = editable && can(permissions, 'invoices.issue');

  if (editing) {
    return <InvoiceForm fileId={fileId} invoice={inv} baseCurrency={baseCurrency} onCancel={() => setEditing(false)} onSaved={async () => { setEditing(false); await refresh(); }} />;
  }

  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      {inv.status === 'CANCELLED' && inv.cancelReason && <Alert tone="amber">{t('inv.cancelledBecause', { reason: inv.cancelReason })}</Alert>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-white">
            <tr><Th>{t('inv.description')}</Th><Th>{t('inv.category')}</Th><Th>{t('inv.quantity')}</Th><Th>{t('inv.unitPrice')}</Th><Th>{t('inv.amount')}</Th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(inv.items ?? []).map((it) => (
              <tr key={it.id}>
                <Td dir="auto">{it.description}{it.expenseId && <span className="ms-2 text-xs text-slate-500">({t('inv.atCost')})</span>}</Td>
                <Td dir="auto">{it.category?.name ?? '—'}</Td>
                <Td dir="ltr">{Number(it.quantity)}</Td>
                <Td dir="ltr">{formatMoney(it.unitPrice, inv.currencyCode, locale)}</Td>
                <Td dir="ltr">{formatMoney(it.amount, inv.currencyCode, locale)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Totals inv={inv} locale={locale} />
      {inv.invoiceType === 'ADVANCE' && <p className="text-xs text-slate-500">{t('inv.advanceNote')}</p>}

      {cancelling && (
        <div className="space-y-2">
          <label htmlFor={`cancel-${id}`} className="block text-sm font-medium">{t('inv.cancelReason')}</label>
          <Textarea id={`cancel-${id}`} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('inv.cancelInvoice')}</Button>
            <Button variant="secondary" onClick={() => { setCancelling(false); setReason(''); }}>{t('common.back')}</Button>
          </div>
        </div>
      )}
      {!cancelling && (
        <div className="flex flex-wrap gap-2">
          {inv.status === 'DRAFT' && canCreate && <Button variant="secondary" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
          {inv.status === 'DRAFT' && canIssue && <Button loading={issue.isPending} onClick={() => issue.mutate()}>{t('inv.issue')}</Button>}
          {inv.status !== 'CANCELLED' && canIssue && <Button variant="secondary" onClick={() => setCancelling(true)}>{inv.status === 'DRAFT' ? t('inv.discard') : t('inv.cancelInvoice')}</Button>}
          <Button variant="ghost" onClick={onClose}>{t('inv.hide')}</Button>
        </div>
      )}
    </div>
  );
}

export function InvoicesTab({ file }: { file: FileDetail }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions, me } = useAuth();
  const refresh = useRefresh(file.id);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const editable = file.status === 'OPEN' || file.status === 'ON_HOLD';
  const canCreate = editable && can(permissions, 'invoices.create');
  const base = me?.tenant.defaultCurrency ?? 'USD';
  const q = useQuery({
    queryKey: ['file-invoices', file.id, page],
    queryFn: ({ signal }) => api.list<Invoice>(`/clearance-files/${file.id}/invoices`, { page, limit: LIMIT }, signal),
  });

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="blue">{t('inv.readOnly')}</Alert>}
      {creating && <InvoiceForm fileId={file.id} baseCurrency={base} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t('inv.title')}</h2>
          {canCreate && !creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('inv.newDraft')}</Button>}
        </div>
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('inv.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th><span className="sr-only">{t('inv.details')}</span></Th><Th>{t('inv.number')}</Th><Th>{t('inv.type')}</Th><Th>{t('common.status')}</Th><Th>{t('inv.dueDate')}</Th><Th>{t('inv.total')}</Th><Th>{t('inv.outstanding')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((inv) => {
                    const expanded = open === inv.id;
                    const label = inv.status === 'DRAFT' ? t('inv.draft') : inv.invoiceNumber;
                    return (
                      <Fragment key={inv.id}>
                        <tr>
                          <Td>
                            <Button variant="ghost" aria-expanded={expanded} aria-label={`${expanded ? t('inv.hide') : t('inv.details')} ${label}`} onClick={() => setOpen(expanded ? null : inv.id)}>
                              {expanded ? <ChevronDown className="size-4 rtl:rotate-0" aria-hidden /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />}
                            </Button>
                          </Td>
                          <Td dir="ltr" className="font-medium tabular-nums">{label}</Td>
                          <Td>{t(`inv.types.${inv.invoiceType}`)}</Td>
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              <Badge tone={statusTone[inv.status]}>{t(`inv.statuses.${inv.status}`)}</Badge>
                              {inv.paymentStatus && <Badge tone={payTone[inv.paymentStatus]}>{t(`inv.payStatuses.${inv.paymentStatus}`)}</Badge>}
                              {inv.isOverdue && <Badge tone="red">{t('inv.overdue')}</Badge>}
                            </div>
                          </Td>
                          <Td>{formatDate(inv.dueDate, locale)}</Td>
                          <Td dir="ltr" className="tabular-nums">{formatMoney(inv.totalAmount, inv.currencyCode, locale)}</Td>
                          <Td dir="ltr" className="tabular-nums">{inv.status === 'ISSUED' ? formatMoney(inv.outstandingAmount, inv.currencyCode, locale) : '—'}</Td>
                        </tr>
                        {expanded && (
                          <tr><td colSpan={7} className="bg-slate-50 px-5 py-4"><InvoiceDetail id={inv.id} fileId={file.id} baseCurrency={base} editable={editable} onClose={() => setOpen(null)} /></td></tr>
                        )}
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

