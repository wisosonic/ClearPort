import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Spinner, Td, Th } from '@/components/ui/primitives';

interface Branch { id: string; code: string; name: string; address: string | null; phone: string | null; isActive: boolean }
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function BranchForm({ branch, onDone }: { branch?: Branch; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(branch?.name ?? '');
  const [address, setAddress] = useState(branch?.address ?? '');
  const [phone, setPhone] = useState(branch?.phone ?? '');
  const [touched, setTouched] = useState(false);
  const codeBad = !branch && !/^[A-Za-z0-9_-]{1,20}$/.test(code.trim());
  const nameBad = !name.trim();
  const save = useMutation({
    mutationFn: () => (branch
      ? api.patch(`/branches/${branch.id}`, { name: name.trim(), address: address.trim() || null, phone: phone.trim() || null })
      : api.post('/branches', { code: code.trim(), name: name.trim(), ...(address.trim() ? { address: address.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}) })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['branches'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!codeBad && !nameBad) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{branch ? t('settings.editBranch') : t('settings.addBranch')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!branch && <Field label={t('clients.code')} htmlFor="br-code" hint={t('settings.branchCodeHint')} error={touched && codeBad ? t('settings.branchCodeInvalid') : undefined}><Input id="br-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
          <Field label={t('common.name')} htmlFor="br-name" error={touched && nameBad ? t('clients.nameRequired') : undefined}><Input id="br-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('clients.phone')} htmlFor="br-phone"><Input id="br-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label={t('clients.address')} htmlFor="br-address"><Input id="br-address" dir="auto" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function BranchRow({ b, onEdit }: { b: Branch; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: () => api.patch(`/branches/${b.id}`, { isActive: !b.isActive }),
    onSuccess: async () => { setProblem(null); await qc.invalidateQueries({ queryKey: ['branches'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr className={b.isActive ? '' : 'text-slate-400'}>
        <Td dir="ltr" className="tabular-nums">{b.code}</Td>
        <Td dir="auto" className="font-medium">{b.name}</Td>
        <Td dir="ltr">{b.phone ?? '—'}</Td>
        <Td dir="auto">{b.address ?? '—'}</Td>
        <Td><Badge tone={b.isActive ? 'green' : 'neutral'}>{b.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          <div className="flex gap-1">
            <Button variant="ghost" aria-label={`${t('common.edit')} ${b.name}`} onClick={onEdit}>{t('common.edit')}</Button>
            <Button variant="ghost" aria-label={`${b.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${b.name}`} loading={toggle.isPending} onClick={() => toggle.mutate()}>{b.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
          </div>
        </Td>
      </tr>
      {problem && <tr><td colSpan={6} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

export function BranchesTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState<'new' | Branch | null>(null);
  const q = useQuery({ queryKey: ['branches'], queryFn: ({ signal }) => api.get<Branch[]>('/branches', undefined, signal) });
  return (
    <div className="space-y-4">
      {!form && <div><Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('settings.addBranch')}</Button></div>}
      {form && <BranchForm branch={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('settings.noBranches')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50"><tr><Th>{t('clients.code')}</Th><Th>{t('common.name')}</Th><Th>{t('clients.phone')}</Th><Th>{t('clients.address')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{q.data.map((b) => <BranchRow key={b.id} b={b} onEdit={() => setForm(b)} />)}</tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
