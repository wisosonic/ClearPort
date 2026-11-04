import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import { ACCOUNT_TYPES, type AccountType, type LedgerAccount } from '../types';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function AddAccount({ accounts, onDone }: { accounts: LedgerAccount[]; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('ASSET');
  const [parent, setParent] = useState('');
  const [touched, setTouched] = useState(false);
  const codeBad = !/^[0-9]{3,10}$/.test(code.trim());
  const nameBad = name.trim().length < 2;
  const save = useMutation({
    mutationFn: () => api.post('/accounting/accounts', { accountCode: code.trim(), name: name.trim(), accountType: type, ...(parent ? { parentId: parent } : {}) }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['ledger-accounts'] }), qc.invalidateQueries({ queryKey: ['trial-balance'] })]); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!codeBad && !nameBad) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('acc.addAccount')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t('acc.code')} htmlFor="ca-code" hint={t('acc.codeHint')} error={touched && codeBad ? t('acc.codeInvalid') : undefined}><Input id="ca-code" inputMode="numeric" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label={t('acc.name')} htmlFor="ca-name" error={touched && nameBad ? t('acc.nameShort') : undefined}><Input id="ca-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('files.type')} htmlFor="ca-type"><Select id="ca-type" value={type} onChange={(e) => setType(e.target.value as AccountType)}>{ACCOUNT_TYPES.map((x) => <option key={x} value={x}>{t(`acc.types.${x}`)}</option>)}</Select></Field>
          <Field label={t('acc.parent')} htmlFor="ca-parent"><Select id="ca-parent" value={parent} onChange={(e) => setParent(e.target.value)}><option value="" />{accounts.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.accountCode} · {a.name}</option>)}</Select></Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function AccountRow({ a, parentCode, canPost }: { a: LedgerAccount; parentCode: string | null; canPost: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const [problem, setProblem] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (patch: { name?: string; isActive?: boolean }) => api.patch(`/accounting/accounts/${a.id}`, patch),
    onSuccess: async () => { setEditing(false); setProblem(null); await Promise.all([qc.invalidateQueries({ queryKey: ['ledger-accounts'] }), qc.invalidateQueries({ queryKey: ['trial-balance'] })]); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr className={a.isActive ? '' : 'text-slate-400'}>
        <Td dir="ltr" className="tabular-nums">{a.accountCode}</Td>
        <Td dir="auto">
          {editing ? (
            <div className="flex gap-2">
              <Input aria-label={`${t('acc.name')} ${a.accountCode}`} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
              <Button disabled={name.trim().length < 2} loading={update.isPending} onClick={() => update.mutate({ name: name.trim() })}>{t('common.save')}</Button>
              <Button variant="secondary" onClick={() => { setEditing(false); setName(a.name); }}>{t('common.cancel')}</Button>
            </div>
          ) : a.name}
        </Td>
        <Td>{t(`acc.types.${a.accountType}`)}</Td>
        <Td dir="ltr" className="tabular-nums">{parentCode ?? '—'}</Td>
        <Td><Badge tone={a.isActive ? 'green' : 'neutral'}>{a.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          {canPost && !editing && (
            <div className="flex gap-1">
              <Button variant="ghost" aria-label={`${t('common.edit')} ${a.accountCode}`} onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button variant="ghost" aria-label={`${a.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${a.accountCode}`} loading={update.isPending} onClick={() => update.mutate({ isActive: !a.isActive })}>{a.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
            </div>
          )}
        </Td>
      </tr>
      {problem && <tr><td colSpan={6} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

export function ChartTab() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [adding, setAdding] = useState(false);
  const canPost = can(permissions, 'accounting.post');
  const q = useQuery({ queryKey: ['ledger-accounts'], queryFn: ({ signal }) => api.get<LedgerAccount[]>('/accounting/accounts', undefined, signal) });
  const byId = new Map((q.data ?? []).map((a) => [a.id, a]));
  return (
    <div className="space-y-4">
      {canPost && !adding && <div><Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('acc.addAccount')}</Button></div>}
      {adding && q.data && <AddAccount accounts={q.data} onDone={() => setAdding(false)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('acc.noAccounts')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr><Th>{t('acc.code')}</Th><Th>{t('acc.name')}</Th><Th>{t('files.type')}</Th><Th>{t('acc.parent')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data.map((a) => <AccountRow key={a.id} a={a} parentCode={a.parentId ? byId.get(a.parentId)?.accountCode ?? null : null} canPost={canPost} />)}
              </tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
