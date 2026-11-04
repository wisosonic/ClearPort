import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import type { Currency } from '@/features/clearance-files/components/invoices/types';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface Cash { id: string; name: string; accountType: 'CASHBOX' | 'BANK' | 'OTHER'; currencyCode: string; isActive: boolean; ledgerAccountCode: string | null; balance: string }
const KINDS = ['CASHBOX', 'BANK', 'OTHER'] as const;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function AddCash({ baseCurrency, onDone }: { baseCurrency: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('CASHBOX');
  const [currency, setCurrency] = useState(baseCurrency);
  const [touched, setTouched] = useState(false);
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const bad = name.trim().length < 2;
  const save = useMutation({
    mutationFn: () => api.post('/cash-accounts', { name: name.trim(), accountType: kind, currencyCode: currency }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['cash-accounts'] }), qc.invalidateQueries({ queryKey: ['ledger-accounts'] })]); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('acc.addCash')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('acc.name')} htmlFor="cash-name" error={touched && bad ? t('acc.nameShort') : undefined}><Input id="cash-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('files.type')} htmlFor="cash-kind"><Select id="cash-kind" value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>{KINDS.map((k) => <option key={k} value={k}>{t(`acc.cashKinds.${k}`)}</option>)}</Select></Field>
          <Field label={t('inv.currency')} htmlFor="cash-cur" hint={t('acc.cashCurrencyHint')}>
            <Select id="cash-cur" value={currency} onChange={(e) => setCurrency(e.target.value)}>{(currencies.data ?? [{ code: baseCurrency, name: baseCurrency, decimalPlaces: 2 }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select>
          </Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function CashRow({ a, canPost }: { a: Cash; canPost: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [problem, setProblem] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (patch: { name?: string; isActive?: boolean }) => api.patch(`/cash-accounts/${a.id}`, patch),
    onSuccess: async () => { setEditing(false); setProblem(null); await qc.invalidateQueries({ queryKey: ['cash-accounts'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr className={a.isActive ? '' : 'text-slate-400'}>
        <Td dir="auto">
          {editing ? (
            <div className="flex gap-2">
              <Input aria-label={`${t('acc.name')} ${a.name}`} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
              <Button disabled={name.trim().length < 2} loading={update.isPending} onClick={() => update.mutate({ name: name.trim() })}>{t('common.save')}</Button>
              <Button variant="secondary" onClick={() => { setEditing(false); setName(a.name); }}>{t('common.cancel')}</Button>
            </div>
          ) : <span className="font-medium">{a.name}</span>}
        </Td>
        <Td>{t(`acc.cashKinds.${a.accountType}`)}</Td>
        <Td dir="ltr">{a.currencyCode}</Td>
        <Td dir="ltr" className="tabular-nums">{a.ledgerAccountCode ?? '—'}</Td>
        <Td dir="ltr" className="tabular-nums">{formatMoney(a.balance, a.currencyCode, locale)}</Td>
        <Td><Badge tone={a.isActive ? 'green' : 'neutral'}>{a.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          {canPost && !editing && (
            <div className="flex gap-1">
              <Button variant="ghost" aria-label={`${t('common.edit')} ${a.name}`} onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button variant="ghost" aria-label={`${a.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${a.name}`} loading={update.isPending} onClick={() => update.mutate({ isActive: !a.isActive })}>{a.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
            </div>
          )}
        </Td>
      </tr>
      {problem && <tr><td colSpan={7} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

export function CashAccountsTab({ baseCurrency }: { baseCurrency: string }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [adding, setAdding] = useState(false);
  const canPost = can(permissions, 'accounting.post');
  const q = useQuery({ queryKey: ['cash-accounts', 'all'], queryFn: ({ signal }) => api.get<Cash[]>('/cash-accounts', { includeInactive: 'true' }, signal) });
  return (
    <div className="space-y-4">
      {canPost && !adding && <div><Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('acc.addCash')}</Button></div>}
      {adding && <AddCash baseCurrency={baseCurrency} onDone={() => setAdding(false)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('acc.noCash')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr><Th>{t('acc.name')}</Th><Th>{t('files.type')}</Th><Th>{t('inv.currency')}</Th><Th>{t('acc.ledger')}</Th><Th>{t('acc.balance')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">{q.data.map((a) => <CashRow key={a.id} a={a} canPost={canPost} />)}</tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
