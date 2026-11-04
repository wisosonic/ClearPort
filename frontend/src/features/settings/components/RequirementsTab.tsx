import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import type { Locale } from '@/lib/format';
import type { DocType } from '@/features/clearance-files/components/documents/types';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { Template } from './WorkflowEditor';

interface Requirement {
  id: string; fileType: 'IMPORT' | 'EXPORT' | 'OTHER'; documentTypeId: string; isRequired: boolean; isRequiredBeforeStageId: string | null; appliesTo: string | null;
  documentType: { id: string; code: string; nameEn: string; nameAr: string }; requiredBefore: { id: string; code: string; nameEn: string; nameAr: string | null } | null;
}
const TYPES = ['IMPORT', 'EXPORT', 'OTHER'] as const;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const name = (x: { nameEn: string; nameAr: string | null }, locale: Locale) => (locale === 'ar' && x.nameAr ? x.nameAr : x.nameEn);

/** Stages a document can be required before: those of the file type's workflows (the one in use first). */
function useStages(fileType: string) {
  const q = useQuery({ queryKey: ['workflow-templates'], queryFn: () => api.get<Template[]>('/workflow-templates') });
  const templates = (q.data ?? []).filter((x) => x.fileType === fileType).sort((a, b) => Number(b.isActive) - Number(a.isActive));
  return templates.flatMap((tpl) => tpl.stages.map((s) => ({ ...s, template: tpl.name, inUse: tpl.isActive })));
}

function RequirementForm({ req, onDone }: { req?: Requirement; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const [fileType, setFileType] = useState<string>(req?.fileType ?? 'IMPORT');
  const [typeId, setTypeId] = useState(req?.documentTypeId ?? '');
  const [required, setRequired] = useState(req?.isRequired ?? true);
  const [stageId, setStageId] = useState(req?.isRequiredBeforeStageId ?? '');
  const [appliesTo, setAppliesTo] = useState(req?.appliesTo ?? '');
  const [touched, setTouched] = useState(false);
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api.get<DocType[]>('/document-types') });
  const stages = useStages(fileType);
  const save = useMutation({
    mutationFn: () => (req
      ? api.patch(`/document-requirements/${req.id}`, { isRequired: required, isRequiredBeforeStageId: stageId || null, appliesTo: appliesTo.trim() || null })
      : api.post('/document-requirements', { fileType, documentTypeId: typeId, isRequired: required, ...(stageId ? { isRequiredBeforeStageId: stageId } : {}), ...(appliesTo.trim() ? { appliesTo: appliesTo.trim() } : {}) })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['document-requirements'] }); await qc.invalidateQueries({ queryKey: ['file-checklist'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (req || typeId) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{req ? t('reqs.edit') : t('reqs.add')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('wf.fileType')} htmlFor="rq-file-type">
            <Select id="rq-file-type" value={fileType} disabled={!!req} onChange={(e) => { setFileType(e.target.value); setStageId(''); }}>{TYPES.map((x) => <option key={x} value={x}>{t(`files.types.${x}`)}</option>)}</Select>
          </Field>
          <Field label={t('docs.type')} htmlFor="rq-doc-type" error={touched && !req && !typeId ? t('docs.typeRequired') : undefined}>
            <Select id="rq-doc-type" value={typeId} disabled={!!req} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">{t('docs.pickType')}</option>
              {(types.data ?? []).filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{name({ nameEn: x.nameEn, nameAr: x.nameAr }, locale)}</option>)}
            </Select>
          </Field>
          <Field label={t('reqs.beforeStage')} htmlFor="rq-stage" hint={t('reqs.beforeStageHint')}>
            <Select id="rq-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">{t('reqs.beforeFinished')}</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{name(s, locale)}{s.inUse ? '' : ` (${s.template})`}</option>)}
            </Select>
          </Field>
          <Field label={t('reqs.appliesTo')} htmlFor="rq-applies" hint={t('reqs.appliesToHint')}><Input id="rq-applies" dir="auto" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value)} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />{t('reqs.mandatory')}</label>
        {req && <p className="text-xs text-slate-500">{t('reqs.fixed')}</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function RequirementRow({ r, onEdit }: { r: Requirement; onEdit: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const label = name(r.documentType, locale);
  const remove = useMutation({
    mutationFn: () => api.delete(`/document-requirements/${r.id}`),
    onSuccess: async () => { setConfirm(false); await qc.invalidateQueries({ queryKey: ['document-requirements'] }); await qc.invalidateQueries({ queryKey: ['file-checklist'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr>
        <Td dir="auto" className="font-medium">{label}{r.appliesTo && <span className="block text-xs text-slate-500">{r.appliesTo}</span>}</Td>
        <Td><Badge tone={r.isRequired ? 'amber' : 'neutral'}>{r.isRequired ? t('docs.required') : t('docs.optional')}</Badge></Td>
        <Td>{r.requiredBefore ? t('reqs.beforeNamed', { stage: name(r.requiredBefore, locale) }) : t('reqs.beforeFinished')}</Td>
        <Td>
          <div className="flex gap-1">
            <Button variant="ghost" aria-label={`${t('common.edit')} ${label}`} onClick={onEdit}>{t('common.edit')}</Button>
            <Button variant="ghost" aria-label={`${t('wf.removeTransition')} ${label}`} onClick={() => setConfirm(true)}>{t('wf.removeTransition')}</Button>
          </div>
        </Td>
      </tr>
      {(confirm || problem) && (
        <tr><td colSpan={4} className="space-y-2 px-4 py-2">
          {problem && <Alert>{problem}</Alert>}
          {confirm && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t('reqs.removeConfirm', { name: label })}</span><Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('wf.removeTransition')}</Button><Button variant="secondary" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button></div>}
        </td></tr>
      )}
    </>
  );
}

/** Which documents each kind of file needs, and by which stage. New files are checked against this list. */
export function RequirementsTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState<'new' | Requirement | null>(null);
  const q = useQuery({ queryKey: ['document-requirements'], queryFn: ({ signal }) => api.get<Requirement[]>('/document-requirements', undefined, signal) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('reqs.intro')}</p>
      {!form && <div><Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('reqs.add')}</Button></div>}
      {form && <RequirementForm req={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState>{t('reqs.none')}</EmptyState>}
      {q.data && TYPES.map((ft) => {
        const rows = q.data.filter((r) => r.fileType === ft);
        if (rows.length === 0) return null;
        return (
          <Card key={ft} className="overflow-hidden">
            <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">{t('reqs.forFiles', { type: t(`files.types.${ft}`) })}</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50"><tr><Th>{t('docs.type')}</Th><Th>{t('reqs.need')}</Th><Th>{t('reqs.when')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
                <tbody className="divide-y divide-slate-100">{rows.map((r) => <RequirementRow key={r.id} r={r} onEdit={() => setForm(r)} />)}</tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
