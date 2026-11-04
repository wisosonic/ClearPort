import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Pagination, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import type { FileDetail } from '../../lib';
import { PaymentForm } from './PaymentForm';
import { POSITIVE, type OpenInvoice, type Payment } from './types';

const statusTone = { DRAFT: 'neutral', POSTED: 'green', CANCELLED: 'red', REVERSED: 'red' } as const;
const LIMIT = 20;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const isReceipt = (p: Payment) => p.paymentType === 'CLIENT_PAYMENT' || p.paymentType === 'CLIENT_ADVANCE';

function useRefresh(fileId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['file-payments', fileId] }),
    qc.invalidateQueries({ queryKey: ['payment'] }),
    qc.invalidateQueries({ queryKey: ['file-invoices', fileId] }),
    qc.invalidateQueries({ queryKey: ['invoice'] }),
    qc.invalidateQueries({ queryKey: ['file-closure', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
  ]);
}

/** Apply some of a payment's unallocated money to the client's issued invoices on this file. */
function AllocateForm({ payment, fileId, onDone }: { payment: Payment; fileId: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const refresh = useRefresh(fileId);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [credited, setCredited] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const q = useQuery({
    queryKey: ['file-open-invoices', fileId],
    queryFn: () => api.list<OpenInvoice>(`/clearance-files/${fileId}/invoices`, { status: 'ISSUED', limit: 100 }),
  });
  const open = (q.data?.data ?? []).filter((i) => i.invoiceType !== 'ADVANCE' && Number(i.outstandingAmount) > 0);
  const filled = open.filter((i) => (amounts[i.id] ?? '').trim() !== '');
  const invalid = (i: OpenInvoice) => !POSITIVE(amounts[i.id] ?? '') || ((credited[i.id] ?? '').trim() !== '' && !POSITIVE(credited[i.id]));
  const valid = filled.length > 0 && filled.every((i) => !invalid(i));

  const save = useMutation({
    mutationFn: () => api.post(`/payments/${payment.id}/allocate`, {
      allocations: filled.map((i) => ({
        invoiceId: i.id, amount: amounts[i.id].trim(),
        ...((credited[i.id] ?? '').trim() && i.currencyCode !== payment.currencyCode ? { invoiceAmount: credited[i.id].trim() } : {}),
      })),
    }),
    onSuccess: async () => { await refresh(); onDone(); },
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-3" noValidate>
      <h3 className="text-sm font-medium text-slate-700">{t('pay.applyTitle', { amount: formatMoney(payment.unallocatedAmount, payment.currencyCode, locale) })}</h3>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && open.length === 0 && <p className="text-sm text-slate-500">{t('pay.noOpenInvoices')}</p>}
      {open.map((i) => {
        const cross = i.currencyCode !== payment.currencyCode;
        const bad = touched && (amounts[i.id] ?? '').trim() !== '' && invalid(i);
        return (
          <div key={i.id} className="grid items-end gap-3 rounded-md border border-slate-200 bg-white p-3 sm:grid-cols-3">
            <div className="text-sm"><span dir="ltr" className="font-medium tabular-nums">{i.invoiceNumber}</span>
              <span className="block text-xs text-slate-500">{t('inv.outstanding')}: <span dir="ltr">{formatMoney(i.outstandingAmount, i.currencyCode, locale)}</span></span></div>
            <Field label={t('pay.applyAmount', { currency: payment.currencyCode })} htmlFor={`alloc-${i.id}`} error={bad ? t('pay.amountInvalid') : undefined}>
              <Input id={`alloc-${i.id}`} inputMode="decimal" dir="ltr" value={amounts[i.id] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: e.target.value }))} />
            </Field>
            {cross && (
              <Field label={t('pay.creditedAmount', { currency: i.currencyCode })} htmlFor={`cred-${i.id}`} hint={t('pay.creditedHint')}>
                <Input id={`cred-${i.id}`} inputMode="decimal" dir="ltr" value={credited[i.id] ?? ''} onChange={(e) => setCredited((a) => ({ ...a, [i.id]: e.target.value }))} />
              </Field>
            )}
          </div>
        );
      })}
      {touched && filled.length === 0 && <p role="alert" className="text-xs text-red-700">{t('pay.pickInvoice')}</p>}
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending} disabled={open.length === 0}>{t('pay.apply')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

function PaymentDetail({ id, fileId, editable, onClose }: { id: string; fileId: string; editable: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const refresh = useRefresh(fileId);
  const [mode, setMode] = useState<'apply' | 'cancel' | { reverse: string } | null>(null);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['payment', id], queryFn: ({ signal }) => api.get<Payment>(`/payments/${id}`, undefined, signal) });
  const fail = (e: unknown) => setProblem(errText(e, t('common.error')));
  const done = async () => { setMode(null); setReason(''); setProblem(null); await refresh(); };
  const cancel = useMutation({ mutationFn: () => api.post(`/payments/${id}/cancel`, { reason: reason.trim() }), onSuccess: done, onError: fail });
  const reverse = useMutation({
    mutationFn: (allocationId: string) => api.post(`/payments/${id}/allocations/${allocationId}/reverse`, { reason: reason.trim() }),
    onSuccess: done, onError: fail,
  });

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const canAct = editable && can(permissions, 'payments.create') && p.status === 'POSTED';
  const canApply = canAct && isReceipt(p) && Number(p.unallocatedAmount) > 0 && can(permissions, 'invoices.view');
  const live = (p.allocations ?? []).filter((a) => !a.reversedAt);
  const askReason = typeof mode === 'object' && mode !== null ? 'reverse' : mode === 'cancel' ? 'cancel' : null;

  return (
    <div className="space-y-3">
      {problem && <Alert>{problem}</Alert>}
      {isReceipt(p) && p.status === 'POSTED' && (
        <p className="text-sm text-slate-700">{t('pay.heldLine', { applied: formatMoney(p.allocatedAmount, p.currencyCode, locale), held: formatMoney(p.unallocatedAmount, p.currencyCode, locale) })}</p>
      )}
      {(p.allocations ?? []).length > 0 && (
        <table className="w-full">
          <thead className="border-b border-slate-200 bg-white"><tr><Th>{t('pay.invoice')}</Th><Th>{t('pay.fromPayment')}</Th><Th>{t('pay.toInvoice')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {(p.allocations ?? []).map((a) => (
              <tr key={a.id}>
                <Td dir="ltr" className="tabular-nums">{a.invoice.invoiceNumber}{a.reversedAt && <Badge tone="neutral" className="ms-2">{t('pay.reversed')}</Badge>}</Td>
                <Td dir="ltr">{formatMoney(a.paymentAmount, p.currencyCode, locale)}</Td>
                <Td dir="ltr">{formatMoney(a.allocatedAmount, a.currencyCode, locale)}</Td>
                <Td>{canAct && !a.reversedAt && <Button variant="ghost" aria-label={`${t('pay.reverse')} ${a.invoice.invoiceNumber}`} onClick={() => { setReason(''); setMode({ reverse: a.id }); }}>{t('pay.reverse')}</Button>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mode === 'apply' && <AllocateForm payment={p} fileId={fileId} onDone={() => setMode(null)} />}
      {askReason && (
        <div className="space-y-2">
          <label htmlFor={`pay-reason-${id}`} className="block text-sm font-medium">{askReason === 'cancel' ? t('pay.cancelReason') : t('pay.reverseReason')}</label>
          <Textarea id={`pay-reason-${id}`} dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button disabled={reason.trim().length < 3} loading={cancel.isPending || reverse.isPending}
              onClick={() => (typeof mode === 'object' && mode ? reverse.mutate(mode.reverse) : cancel.mutate())}>
              {askReason === 'cancel' ? t('pay.cancelPayment') : t('pay.reverse')}
            </Button>
            <Button variant="secondary" onClick={() => setMode(null)}>{t('common.back')}</Button>
          </div>
        </div>
      )}
      {mode === null && (
        <div className="flex flex-wrap gap-2">
          {canApply && <Button onClick={() => setMode('apply')}>{t('pay.apply')}</Button>}
          {canAct && live.length === 0 && <Button variant="secondary" onClick={() => { setReason(''); setMode('cancel'); }}>{t('pay.cancelPayment')}</Button>}
          <Button variant="ghost" onClick={onClose}>{t('inv.hide')}</Button>
        </div>
      )}
    </div>
  );
}

export function PaymentsTab({ file }: { file: FileDetail }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions, me } = useAuth();
  const refresh = useRefresh(file.id);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const editable = file.status === 'OPEN' || file.status === 'ON_HOLD';
  const canCreate = editable && can(permissions, 'payments.create');
  const base = me?.tenant.defaultCurrency ?? 'USD';
  const q = useQuery({
    queryKey: ['file-payments', file.id, page],
    queryFn: ({ signal }) => api.list<Payment>('/payments', { clearanceFileId: file.id, page, limit: LIMIT }, signal),
  });

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="blue">{t('pay.readOnly')}</Alert>}
      {creating && <PaymentForm fileId={file.id} clientId={file.client.id} baseCurrency={base} onCancel={() => setCreating(false)} onSaved={async () => { setCreating(false); await refresh(); }} />}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t('pay.title')}</h2>
          {canCreate && !creating && <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('pay.record')}</Button>}
        </div>
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('pay.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th><span className="sr-only">{t('inv.details')}</span></Th><Th>{t('inv.number')}</Th><Th>{t('pay.type')}</Th><Th>{t('pay.date')}</Th><Th>{t('pay.method')}</Th><Th>{t('pay.amount')}</Th><Th>{t('common.status')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((p) => {
                    const expanded = open === p.id;
                    return (
                      <Fragment key={p.id}>
                        <tr>
                          <Td>
                            <Button variant="ghost" aria-expanded={expanded} aria-label={`${expanded ? t('inv.hide') : t('inv.details')} ${p.paymentNumber}`} onClick={() => setOpen(expanded ? null : p.id)}>
                              {expanded ? <ChevronDown className="size-4" aria-hidden /> : <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />}
                            </Button>
                          </Td>
                          <Td dir="ltr" className="font-medium tabular-nums">{p.paymentNumber}</Td>
                          <Td>{t(`pay.types.${p.paymentType}`)}</Td>
                          <Td>{formatDate(p.paymentDate, locale)}</Td>
                          <Td dir="auto">{t(`pay.methods.${p.paymentMethod}`, { defaultValue: p.paymentMethod })}{p.referenceNumber && <span className="block text-xs text-slate-500" dir="auto">{p.referenceNumber}</span>}</Td>
                          <Td dir="ltr" className="tabular-nums">{formatMoney(p.amount, p.currencyCode, locale)}</Td>
                          <Td>
                            <div className="flex flex-wrap gap-1">
                              <Badge tone={statusTone[p.status]}>{t(`pay.statuses.${p.status}`)}</Badge>
                              {isReceipt(p) && p.status === 'POSTED' && Number(p.unallocatedAmount) > 0 && <Badge tone="amber">{t('pay.unapplied')}</Badge>}
                            </div>
                          </Td>
                        </tr>
                        {expanded && <tr><td colSpan={7} className="bg-slate-50 px-5 py-4"><PaymentDetail id={p.id} fileId={file.id} editable={editable} onClose={() => setOpen(null)} /></td></tr>}
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
