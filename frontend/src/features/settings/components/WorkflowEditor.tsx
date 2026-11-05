import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Field, Input, Select, Td, Th } from '@/components/ui/primitives';

export interface Stage { id: string; code: string; nameEn: string; nameAr: string; sequence: number; isTerminal: boolean }
export interface Transition {
  id: string; fromStageId: string; toStageId: string; requiredPermission: string | null;
  requiresDocumentCheck: boolean; requiresApproval: boolean; requiresReason: boolean; requiredTaskCheck: boolean;
}
export interface Template { id: string; name: string; fileType: 'IMPORT' | 'EXPORT' | 'OTHER'; description: string | null; isActive: boolean; stages: Stage[]; transitions: Transition[] }

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const FLAGS = ['requiresDocumentCheck', 'requiresApproval', 'requiresReason', 'requiredTaskCheck'] as const;
type Flag = (typeof FLAGS)[number];
const CODE = /^[A-Za-z][A-Za-z0-9_]{1,49}$/;

function useRefreshWorkflows() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['workflow-templates'] });
}

// ───────────────────────────── stages ─────────────────────────────

function StageRow({ s, templateId, order }: { s: Stage; templateId: string; order: string[] }) {
  const { t } = useTranslation();
  const refresh = useRefreshWorkflows();
  const [editing, setEditing] = useState(false);
  const [nameEn, setNameEn] = useState(s.nameEn);
  const [nameAr, setNameAr] = useState(s.nameAr);
  const [terminal, setTerminal] = useState(s.isTerminal);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const at = order.indexOf(s.id);
  const move = useMutation({
    mutationFn: (dir: -1 | 1) => {
      const next = [...order];
      [next[at], next[at + dir]] = [next[at + dir]!, next[at]!];
      return api.post(`/workflow-templates/${templateId}/stages/reorder`, { stageIds: next });
    },
    onSuccess: async () => { setProblem(null); await refresh(); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workflow-templates/${templateId}/stages/${s.id}`),
    onSuccess: async () => { setConfirm(false); setProblem(null); await refresh(); },
    onError: (e) => { setConfirm(false); setProblem(errText(e, t('common.error'))); },
  });
  const save = useMutation({
    mutationFn: () => api.patch(`/workflow-templates/${templateId}/stages/${s.id}`, { nameEn: nameEn.trim(), nameAr: nameAr.trim(), isTerminal: terminal }),
    onSuccess: async () => { setEditing(false); setProblem(null); await refresh(); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr>
        <Td dir="ltr" className="tabular-nums">{s.sequence}</Td>
        <Td dir="ltr" className="font-mono text-xs">{s.code}</Td>
        <Td>
          {editing ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label={`${t('wf.nameEn')} ${s.code}`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
              <Input aria-label={`${t('wf.nameAr')} ${s.code}`} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
            </div>
          ) : <><span>{s.nameEn}</span><span className="block text-xs text-slate-500" dir="rtl">{s.nameAr}</span></>}
        </Td>
        <Td>
          {editing ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={terminal} onChange={(e) => setTerminal(e.target.checked)} />{t('wf.terminal')}</label>
            : s.isTerminal ? <Badge tone="neutral">{t('wf.terminal')}</Badge> : '—'}
        </Td>
        <Td>
          {editing ? (
            <div className="flex gap-1">
              <Button disabled={!nameEn.trim() || !nameAr.trim()} loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
              <Button variant="secondary" onClick={() => { setEditing(false); setNameEn(s.nameEn); setNameAr(s.nameAr); setTerminal(s.isTerminal); setProblem(null); }}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              <Button variant="ghost" aria-label={`${t('wf.moveUp')} ${s.code}`} disabled={at <= 0 || move.isPending} onClick={() => move.mutate(-1)}><ArrowUp className="size-4" aria-hidden /></Button>
              <Button variant="ghost" aria-label={`${t('wf.moveDown')} ${s.code}`} disabled={at < 0 || at >= order.length - 1 || move.isPending} onClick={() => move.mutate(1)}><ArrowDown className="size-4" aria-hidden /></Button>
              <Button variant="ghost" aria-label={`${t('common.edit')} ${s.code}`} onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button variant="ghost" aria-label={`${t('wf.removeTransition')} ${s.code}`} onClick={() => setConfirm(true)}>{t('wf.removeTransition')}</Button>
            </div>
          )}
        </Td>
      </tr>
      {(problem || confirm) && (
        <tr><td colSpan={5} className="space-y-2 px-4 py-2">
          {problem && <Alert>{problem}</Alert>}
          {confirm && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t('wf.removeStageConfirm', { name: s.nameEn })}</span><Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('wf.removeTransition')}</Button><Button variant="secondary" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button></div>}
        </td></tr>
      )}
    </>
  );
}

function AddStage({ templateId, onDone }: { templateId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshWorkflows();
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [touched, setTouched] = useState(false);
  const bad = !CODE.test(code.trim()) || !nameEn.trim() || !nameAr.trim();
  const save = useMutation({
    mutationFn: () => api.post(`/workflow-templates/${templateId}/stages`, { code: code.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim(), isTerminal: terminal }),
    onSuccess: async () => { await refresh(); onDone(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad) save.mutate(); }} className="space-y-3 rounded-md border border-slate-200 bg-white p-4" noValidate>
      <h4 className="text-sm font-medium">{t('wf.addStage')}</h4>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('wf.stageCode')} htmlFor={`st-code-${templateId}`} hint={t('wf.stageCodeHint')} error={touched && !CODE.test(code.trim()) ? t('wf.stageCodeInvalid') : undefined}><Input id={`st-code-${templateId}`} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label={t('wf.nameEn')} htmlFor={`st-en-${templateId}`} error={touched && !nameEn.trim() ? t('wf.nameRequired') : undefined}><Input id={`st-en-${templateId}`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} /></Field>
        <Field label={t('wf.nameAr')} htmlFor={`st-ar-${templateId}`} error={touched && !nameAr.trim() ? t('wf.nameRequired') : undefined}><Input id={`st-ar-${templateId}`} dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={terminal} onChange={(e) => setTerminal(e.target.checked)} />{t('wf.terminalHint')}</label>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

// ───────────────────────────── transitions ─────────────────────────────

function FlagBoxes({ value, onChange }: { value: Record<Flag, boolean>; onChange: (f: Flag, v: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {FLAGS.map((f) => <label key={f} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value[f]} onChange={(e) => onChange(f, e.target.checked)} />{t(`wf.flags.${f}`)}</label>)}
    </div>
  );
}

function PermissionInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const list = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<{ code: string }[]>('/permissions'), enabled: can(permissions, 'roles.manage') });
  return (
    <Field label={t('wf.requiredPermission')} htmlFor={id} hint={t('wf.requiredPermissionHint')}>
      <Input id={id} dir="ltr" list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={`${id}-list`}>{(list.data ?? []).map((p) => <option key={p.code} value={p.code} />)}</datalist>
    </Field>
  );
}

function TransitionRow({ tr, stages, templateId }: { tr: Transition; stages: Stage[]; templateId: string }) {
  const { t } = useTranslation();
  const refresh = useRefreshWorkflows();
  const [editing, setEditing] = useState(false);
  const [flags, setFlags] = useState<Record<Flag, boolean>>({ requiresDocumentCheck: tr.requiresDocumentCheck, requiresApproval: tr.requiresApproval, requiresReason: tr.requiresReason, requiredTaskCheck: tr.requiredTaskCheck });
  const [permission, setPermission] = useState(tr.requiredPermission ?? '');
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = (id: string) => stages.find((s) => s.id === id)?.nameEn ?? '?';
  const save = useMutation({
    mutationFn: () => api.patch(`/workflow-templates/${templateId}/transitions/${tr.id}`, { ...flags, requiredPermission: permission.trim() || null }),
    onSuccess: async () => { setEditing(false); setProblem(null); await refresh(); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/workflow-templates/${templateId}/transitions/${tr.id}`),
    onSuccess: async () => { setConfirm(false); await refresh(); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  const label = `${name(tr.fromStageId)} → ${name(tr.toStageId)}`;
  const active = FLAGS.filter((f) => tr[f]);
  return (
    <>
      <tr>
        <Td><span className="inline-flex items-center gap-2">{name(tr.fromStageId)}<ArrowRight className="size-4 text-slate-400 rtl:rotate-180" aria-hidden />{name(tr.toStageId)}</span></Td>
        <Td>
          {editing ? (
            <div className="space-y-2">
              <FlagBoxes value={flags} onChange={(f, v) => setFlags((x) => ({ ...x, [f]: v }))} />
              <PermissionInput id={`perm-${tr.id}`} value={permission} onChange={setPermission} />
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {active.map((f) => <Badge key={f} tone="blue">{t(`wf.flags.${f}`)}</Badge>)}
              {tr.requiredPermission && <Badge tone="amber"><span dir="ltr" className="font-mono">{tr.requiredPermission}</span></Badge>}
              {active.length === 0 && !tr.requiredPermission && <span className="text-slate-400">—</span>}
            </div>
          )}
        </Td>
        <Td>
          {editing ? (
            <div className="flex gap-1">
              <Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
              <Button variant="secondary" onClick={() => { setEditing(false); setProblem(null); }}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <div className="flex gap-1">
              <Button variant="ghost" aria-label={`${t('common.edit')} ${label}`} onClick={() => setEditing(true)}>{t('common.edit')}</Button>
              <Button variant="ghost" aria-label={`${t('wf.removeTransition')} ${label}`} onClick={() => setConfirm(true)}>{t('wf.removeTransition')}</Button>
            </div>
          )}
        </Td>
      </tr>
      {(problem || confirm) && (
        <tr><td colSpan={3} className="space-y-2 px-4 py-2">
          {problem && <Alert>{problem}</Alert>}
          {confirm && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t('wf.removeConfirm', { transition: label })}</span><Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('wf.removeTransition')}</Button><Button variant="secondary" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button></div>}
        </td></tr>
      )}
    </>
  );
}

function AddTransition({ template, onDone }: { template: Template; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefreshWorkflows();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [flags, setFlags] = useState<Record<Flag, boolean>>({ requiresDocumentCheck: false, requiresApproval: false, requiresReason: false, requiredTaskCheck: false });
  const [permission, setPermission] = useState('');
  const [touched, setTouched] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post(`/workflow-templates/${template.id}/transitions`, { fromStageId: from, toStageId: to, ...flags, ...(permission.trim() ? { requiredPermission: permission.trim() } : {}) }),
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const bad = !from || !to || from === to;
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad) save.mutate(); }} className="space-y-3 rounded-md border border-slate-200 bg-white p-4" noValidate>
      <h4 className="text-sm font-medium">{t('wf.addTransition')}</h4>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('wf.from')} htmlFor={`tr-from-${template.id}`} error={touched && !from ? t('wf.pickStage') : undefined}>
          <Select id={`tr-from-${template.id}`} value={from} onChange={(e) => setFrom(e.target.value)}><option value="" />{template.stages.filter((s) => !s.isTerminal).map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}</Select>
        </Field>
        <Field label={t('wf.to')} htmlFor={`tr-to-${template.id}`} error={touched && (!to || to === from) ? t('wf.pickDifferentStage') : undefined}>
          <Select id={`tr-to-${template.id}`} value={to} onChange={(e) => setTo(e.target.value)}><option value="" />{template.stages.map((s) => <option key={s.id} value={s.id}>{s.nameEn}</option>)}</Select>
        </Field>
      </div>
      <FlagBoxes value={flags} onChange={(f, v) => setFlags((x) => ({ ...x, [f]: v }))} />
      <PermissionInput id={`perm-new-${template.id}`} value={permission} onChange={setPermission} />
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

// ───────────────────────────── the editor ─────────────────────────────

export function WorkflowEditor({ template }: { template: Template }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<'stage' | 'transition' | null>(null);
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">{t('wf.stages')}</h3>
          {adding === null && <Button variant="secondary" onClick={() => setAdding('stage')}><Plus className="size-4" aria-hidden />{t('wf.addStage')}</Button>}
        </div>
        {adding === 'stage' && <AddStage templateId={template.id} onDone={() => setAdding(null)} />}
        {template.stages.length === 0 ? <p className="text-sm text-slate-500">{t('wf.noStages')}</p> : (
          <div className="overflow-x-auto"><table className="w-full">
            <thead className="border-b border-slate-200"><tr><Th>#</Th><Th>{t('wf.stageCode')}</Th><Th>{t('common.name')}</Th><Th>{t('wf.terminal')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
            <tbody className="divide-y divide-slate-100">{template.stages.map((s) => <StageRow key={s.id} s={s} templateId={template.id} order={template.stages.map((x) => x.id)} />)}</tbody>
          </table></div>
        )}
      </section>
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">{t('wf.transitions')}</h3>
          {adding === null && template.stages.length >= 2 && <Button variant="secondary" onClick={() => setAdding('transition')}><Plus className="size-4" aria-hidden />{t('wf.addTransition')}</Button>}
        </div>
        <p className="text-xs text-slate-500">{t('wf.transitionsHint')}</p>
        {adding === 'transition' && <AddTransition template={template} onDone={() => setAdding(null)} />}
        {template.transitions.length === 0 ? <p className="text-sm text-slate-500">{t('wf.noTransitions')}</p> : (
          <div className="overflow-x-auto"><table className="w-full">
            <thead className="border-b border-slate-200"><tr><Th>{t('wf.move')}</Th><Th>{t('wf.rules')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
            <tbody className="divide-y divide-slate-100">{template.transitions.map((tr) => <TransitionRow key={tr.id} tr={tr} stages={template.stages} templateId={template.id} />)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
