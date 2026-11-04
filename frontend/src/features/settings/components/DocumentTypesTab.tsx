import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import type { DocType } from '@/features/clearance-files/components/documents/types';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Spinner, Td, Th } from '@/components/ui/primitives';

interface DocTypeRow extends DocType { tenantId: string | null; description: string | null }
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const CODE = /^[A-Za-z][A-Za-z0-9_]{1,49}$/;

function TypeForm({ type, onDone }: { type?: DocTypeRow; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState(type?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(type?.nameAr ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [touched, setTouched] = useState(false);
  const errors = {
    code: !type && !CODE.test(code.trim()) ? t('wf.stageCodeInvalid') : undefined,
    nameEn: !nameEn.trim() ? t('wf.nameRequired') : undefined,
    nameAr: !nameAr.trim() ? t('wf.nameRequired') : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);
  const save = useMutation({
    mutationFn: () => (type
      ? api.patch(`/document-types/${type.id}`, { nameEn: nameEn.trim(), nameAr: nameAr.trim(), description: description.trim() || null })
      : api.post('/document-types', { code: code.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim(), ...(description.trim() ? { description: description.trim() } : {}) })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['document-types'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{type ? t('dtypes.edit') : t('dtypes.add')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          {!type && <Field label={t('wf.stageCode')} htmlFor="dt-code" hint={t('wf.stageCodeHint')} error={touched ? errors.code : undefined}><Input id="dt-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
          <Field label={t('wf.nameEn')} htmlFor="dt-en" error={touched ? errors.nameEn : undefined}><Input id="dt-en" value={nameEn} onChange={(e) => setNameEn(e.target.value)} /></Field>
          <Field label={t('wf.nameAr')} htmlFor="dt-ar" error={touched ? errors.nameAr : undefined}><Input id="dt-ar" dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></Field>
        </div>
        <Field label={t('inv.description')} htmlFor="dt-desc"><Input id="dt-desc" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function TypeRow({ d, onEdit }: { d: DocTypeRow; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const system = d.tenantId === null;
  const toggle = useMutation({
    mutationFn: () => api.patch(`/document-types/${d.id}`, { isActive: !d.isActive }),
    onSuccess: async () => { setProblem(null); await qc.invalidateQueries({ queryKey: ['document-types'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr className={d.isActive ? '' : 'text-slate-400'}>
        <Td dir="ltr" className="font-mono text-xs">{d.code}</Td>
        <Td><span>{d.nameEn}</span><span className="block text-xs text-slate-500" dir="rtl">{d.nameAr}</span></Td>
        <Td dir="auto">{d.description ?? '—'}</Td>
        <Td><Badge tone={system ? 'blue' : 'neutral'}>{system ? t('users.systemRole') : t('users.customRole')}</Badge></Td>
        <Td><Badge tone={d.isActive ? 'green' : 'neutral'}>{d.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          {!system && (
            <div className="flex gap-1">
              <Button variant="ghost" aria-label={`${t('common.edit')} ${d.code}`} onClick={onEdit}>{t('common.edit')}</Button>
              <Button variant="ghost" aria-label={`${d.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${d.code}`} loading={toggle.isPending} onClick={() => toggle.mutate()}>{d.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
            </div>
          )}
        </Td>
      </tr>
      {problem && <tr><td colSpan={6} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

/** The kinds of document an office collects. Built-in kinds are read-only; an office adds its own. */
export function DocumentTypesTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState<'new' | DocTypeRow | null>(null);
  const q = useQuery({ queryKey: ['document-types', 'all'], queryFn: ({ signal }) => api.get<DocTypeRow[]>('/document-types', undefined, signal) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('dtypes.intro')}</p>
      {!form && <div><Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('dtypes.add')}</Button></div>}
      {form && <TypeForm type={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('dtypes.none')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50"><tr><Th>{t('wf.stageCode')}</Th><Th>{t('common.name')}</Th><Th>{t('inv.description')}</Th><Th>{t('files.type')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{q.data.map((d) => <TypeRow key={d.id} d={d} onEdit={() => setForm(d)} />)}</tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
