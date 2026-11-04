import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Textarea } from '@/components/ui/primitives';
import { WorkflowEditor, type Template } from './WorkflowEditor';

const TYPES = ['IMPORT', 'EXPORT', 'OTHER'] as const;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

function TemplateForm({ template, onDone }: { template?: Template; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? '');
  const [fileType, setFileType] = useState<string>(template?.fileType ?? 'IMPORT');
  const [description, setDescription] = useState(template?.description ?? '');
  const [touched, setTouched] = useState(false);
  const bad = name.trim().length < 2;
  const save = useMutation({
    mutationFn: () => (template
      ? api.patch(`/workflow-templates/${template.id}`, { name: name.trim(), description: description.trim() || null })
      : api.post('/workflow-templates', { name: name.trim(), fileType, ...(description.trim() ? { description: description.trim() } : {}) })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['workflow-templates'] }); onDone(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad) save.mutate(); }} className="space-y-3" noValidate>
      <h3 className="text-sm font-semibold text-slate-700">{template ? t('wf.renameTemplate') : t('wf.newTemplate')}</h3>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} htmlFor={`tpl-name-${template?.id ?? 'new'}`} error={touched && bad ? t('acc.nameShort') : undefined}><Input id={`tpl-name-${template?.id ?? 'new'}`} dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {!template && (
          <Field label={t('wf.fileType')} htmlFor="tpl-type" hint={t('wf.startsInactive')}>
            <Select id="tpl-type" value={fileType} onChange={(e) => setFileType(e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{t(`files.types.${x}`)}</option>)}</Select>
          </Field>
        )}
      </div>
      <Field label={t('inv.description')} htmlFor={`tpl-desc-${template?.id ?? 'new'}`}><Textarea id={`tpl-desc-${template?.id ?? 'new'}`} dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

function TemplateCard({ tpl }: { tpl: Template }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'edit' | 'rename' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: () => api.patch(`/workflow-templates/${tpl.id}`, { isActive: !tpl.isActive }),
    onSuccess: async () => { setProblem(null); await qc.invalidateQueries({ queryKey: ['workflow-templates'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900" dir="auto">{tpl.name}
            <Badge tone="neutral" className="ms-2">{t(`files.types.${tpl.fileType}`)}</Badge>
            <Badge tone={tpl.isActive ? 'green' : 'neutral'} className="ms-2">{tpl.isActive ? t('wf.inUse') : t('wf.notInUse')}</Badge>
          </h2>
          {tpl.description && <p className="text-sm text-slate-600" dir="auto">{tpl.description}</p>}
          <p className="text-xs text-slate-500">{t('wf.counts', { stages: tpl.stages.length, transitions: tpl.transitions.length })}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button variant="secondary" aria-label={`${tpl.isActive ? t('wf.stopUsing') : t('wf.startUsing')} ${tpl.name}`} loading={toggle.isPending} onClick={() => toggle.mutate()}>{tpl.isActive ? t('wf.stopUsing') : t('wf.startUsing')}</Button>
          <Button variant="ghost" aria-label={`${t('wf.renameTemplate')} ${tpl.name}`} onClick={() => setMode(mode === 'rename' ? null : 'rename')}>{t('wf.renameTemplate')}</Button>
          <Button variant="ghost" aria-expanded={mode === 'edit'} aria-label={`${mode === 'edit' ? t('inv.hide') : t('wf.editStages')} ${tpl.name}`} onClick={() => setMode(mode === 'edit' ? null : 'edit')}>{mode === 'edit' ? t('inv.hide') : t('wf.editStages')}</Button>
        </div>
      </div>
      {problem && <Alert>{problem}</Alert>}
      {mode === 'rename' && <TemplateForm template={tpl} onDone={() => setMode(null)} />}
      {mode === 'edit' && <WorkflowEditor template={tpl} />}
    </Card>
  );
}

export function WorkflowsTab() {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['workflow-templates'], queryFn: ({ signal }) => api.get<Template[]>('/workflow-templates', undefined, signal) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('wf.intro')}</p>
      {!creating && <div><Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('wf.newTemplate')}</Button></div>}
      {creating && <Card className="p-5"><TemplateForm onDone={() => setCreating(false)} /></Card>}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && !creating && <EmptyState>{t('wf.none')}</EmptyState>}
      {q.data?.map((tpl) => <TemplateCard key={tpl.id} tpl={tpl} />)}
    </div>
  );
}
