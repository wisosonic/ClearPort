import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Pagination, Select, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import type { FileDetail } from '../../lib';
import type { CashAccount } from '../payments/types';
import { ExpenseForm, type Expense } from './ExpenseForm';

const statusTone = { DRAFT: 'neutral', APPROVED: 'green', CANCELLED: 'red' } as const;
const payTone = { UNPAID: 'amber', PARTIALLY_PAID: 'amber', PAID: 'green' } as const;
const LIMIT = 20;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function useRefresh(fileId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['file-expenses', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-expenses-billable', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
  ]);
}

type Mode = 'approve' | 'pay' | 'cancel' | 'edit' | null;

/** One expense with the actions its state allows. */
function ExpenseRow({ e, fileId, baseCurrency, editable }: { e: Expense; fileId: string; baseCurrency: string; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const refresh = useRefresh(fileId);
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState('');
  const [cashId, setCashId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const canApprove = editable && can(permissions, 'expenses.approve');
  const canEdit = editable && can(permissions, 'expenses.create') && e.status === 'DRAFT';
  const canSeeAccounts = can(permissions, 'payments.view');
  const accounts = useQuery({ queryKey: ['cash-accounts'], queryFn: () => api.get<CashAccount[]>('/cash-accounts'), enabled: canSeeAccounts && (mode === 'approve' || mode === 'pay') });
  const matching = (accounts.data ?? []).filter((a) => a.isActive && a.currencyCode === e.currencyCode);
  const done = async () => { setMode(null); setReason(''); setCashId(''); setProblem(null); await refresh(); };
  const fail = (x: unknown) => setProblem(errText(x, t('common.error')));

  const approve = useMutation({ mutationFn: () => api.post(`/expenses/${e.id}/approve`, cashId ? { cashAccountId: cashId } : {}), onSuccess: done, onError: fail });
  const pay = useMutation({ mutationFn: () => api.post(`/expenses/${e.id}/pay`, { cashAccountId: cashId }), onSuccess: done, onError: fail });
  const cancel = useMutation({ mutationFn: () => api.post(`/expenses/${e.id}/cancel`, { reason: reason.trim() }), onSuccess: done, onError: fail });

  const close = () => { setMode(null); setProblem(null); setReason(''); setCashId(''); };
  const accountPicker = (
    <Field label={t('exp.payFrom')} htmlFor={`exp-cash-${e.id}`} hint={mode === 'approve' ? t('exp.payFromHint') : (matching.length === 0 && accounts.data ? t('pay.noAccount', { currency: e.currencyCode }) : undefined)}>
      <Select id={`exp-cash-${e.id}`} value={cashId} onChange={(x) => setCashId(x.target.value)}>
        <option value="">{mode === 'approve' ? t('exp.leaveUnpaid') : ''}</option>
        {matching.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </Field>
  );

  return (
    <>
      <tr>
        <Td dir="auto"><span className="font-medium">{e.description}</span><span className="block text-xs text-slate-500">{e.category?.name}</span></Td>
        <Td>{formatDate(e.expenseDate, locale)}</Td>
        <Td dir="ltr" className="tabular-nums">{formatMoney(e.amount, e.currencyCode, locale)}</Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            <Badge tone={statusTone[e.status]}>{t(`exp.statuses.${e.status}`)}</Badge>
            {e.status === 'APPROVED' && <Badge tone={payTone[e.paymentStatus]}>{t(`inv.payStatuses.${e.paymentStatus}`)}</Badge>}
            {e.isBilled && <Badge tone="blue">{t('exp.billedOn', { number: e.billedOn?.invoiceNumber })}</Badge>}
          </div>
        </Td>
        <Td>
          <div className="flex flex-wrap gap-1">
            {canEdit && <Button variant="ghost" aria-label={`${t('common.edit')} ${e.description}`} onClick={() => setMode('edit')}>{t('common.edit')}</Button>}
            {canApprove && e.status === 'DRAFT' && <Button variant="ghost" aria-label={`${t('exp.approve')} ${e.description}`} onClick={() => setMode('approve')}>{t('exp.approve')}</Button>}
            {canApprove && e.status === 'APPROVED' && e.paymentStatus !== 'PAID' && canSeeAccounts && <Button variant="ghost" aria-label={`${t('exp.markPaid')} ${e.description}`} onClick={() => setMode('pay')}>{t('exp.markPaid')}</Button>}
            {canApprove && e.status !== 'CANCELLED' && !e.isBilled && <Button variant="ghost" aria-label={`${t('exp.cancel')} ${e.description}`} onClick={() => setMode('cancel')}>{t('exp.cancel')}</Button>}
          </div>
        </Td>
      </tr>
      {(mode !== null && mode !== 'edit' || problem) && (
        <tr>
          <td colSpan={5} className="space-y-2 bg-slate-50 px-5 py-3">
            {problem && <Alert>{problem}</Alert>}
            {(mode === 'approve' || mode === 'pay') && (
              <div className="max-w-sm space-y-2">
                {canSeeAccounts && accountPicker}
                <div className="flex gap-2">
                  <Button loading={approve.isPending || pay.isPending} disabled={mode === 'pay' && !cashId} onClick={() => (mode === 'approve' ? approve.mutate() : pay.mutate())}>
                    {mode === 'approve' ? t('exp.approve') : t('exp.markPaid')}
                  </Button>
                  <Button variant="secondary" onClick={close}>{t('common.back')}</Button>
                </div>
              </div>
            )}
            {mode === 'cancel' && (
              <div className="space-y-2">
                <label htmlFor={`exp-reason-${e.id}`} className="block text-sm font-medium">{t('exp.cancelReason')}</label>
                <Textarea id={`exp-reason-${e.id}`} dir="auto" value={reason} onChange={(x) => setReason(x.target.value)} />
                <div className="flex gap-2">
                  <Button disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>{t('exp.cancel')}</Button>
                  <Button variant="secondary" onClick={close}>{t('common.back')}</Button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
      {mode === 'edit' && (
        <tr><td colSpan={5} className="bg-slate-50 px-5 py-4"><ExpenseForm fileId={fileId} expense={e} baseCurrency={baseCurrency} onCancel={close} onSaved={done} /></td></tr>
      )}
    </>
  );
}

export function ExpensesTab({ file }: { file: FileDetail }) {
  const { t } = useTranslation();
  const { permissions, me } = useAuth();
  const refresh = useRefresh(file.id);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const editable = file.status === 'OPEN' || file.status === 'ON_HOLD';
  const canCreate = editable && can(permissions, 'expenses.create');
  const base = me?.tenant.defaultCurrency ?? 'USD';
  const q = useQuery({
    queryKey: ['file-expenses', file.id, page],
    queryFn: ({ signal }) => api.list<Expense>('/expenses', { clearanceFileId: file.id, page, limit: LIMIT }, signal),
  });

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="blue">{t('exp.readOnly')}</Alert>}
      {creating && <ExpenseForm fileId={file.id} baseCurrency={base} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t('exp.title')}</h2>
          {canCreate && !creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('exp.record')}</Button>}
        </div>
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('exp.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('inv.description')}</Th><Th>{t('pay.date')}</Th><Th>{t('pay.amount')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((e) => <ExpenseRow key={e.id} e={e} fileId={file.id} baseCurrency={base} editable={editable} />)}
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
