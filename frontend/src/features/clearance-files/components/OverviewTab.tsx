import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api-client';
import { formatDate, fullName, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { dateToIso, isoToDate, type FileDetail } from '../lib';

const schema = z.object({
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  expectedArrivalAt: z.string(),
  customsReference: z.string().max(100, 'files.tooLong'),
  internalNotes: z.string().max(5000, 'files.tooLong'),
});
type Form = z.infer<typeof schema>;

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

function EditForm({ file, onDone }: { file: FileDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      priority: file.priority as Form['priority'], expectedArrivalAt: isoToDate(file.expectedArrivalAt),
      customsReference: file.customsReference ?? '', internalNotes: file.internalNotes ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: Form) => api.patch(`/clearance-files/${file.id}`, {
      priority: v.priority,
      expectedArrivalAt: v.expectedArrivalAt ? dateToIso(v.expectedArrivalAt) : null,
      customsReference: v.customsReference.trim(),
      internalNotes: v.internalNotes.trim(),
    }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['file', file.id] }),
        qc.invalidateQueries({ queryKey: ['file-timeline', file.id] }),
        qc.invalidateQueries({ queryKey: ['files'] }),
      ]);
      onDone();
    },
  });
  const msg = (e?: { message?: string }) => (e?.message ? t(e.message) : undefined);

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
      {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('files.priority')} htmlFor="e-priority">
          <Select id="e-priority" {...register('priority')}>
            {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((v) => <option key={v} value={v}>{t(`files.priorities.${v}`)}</option>)}
          </Select>
        </Field>
        <Field label={t('files.arrival')} htmlFor="e-arrival"><Input id="e-arrival" type="date" {...register('expectedArrivalAt')} /></Field>
      </div>
      <Field label={t('files.customsReference')} htmlFor="e-ref" error={msg(errors.customsReference)}><Input id="e-ref" dir="ltr" {...register('customsReference')} /></Field>
      <Field label={t('files.internalNotes')} htmlFor="e-notes" error={msg(errors.internalNotes)}><Textarea id="e-notes" dir="auto" {...register('internalNotes')} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

export function OverviewTab({ file }: { file: FileDetail }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const [editing, setEditing] = useState(false);
  const canEdit = can(permissions, 'clearance_files.update') && (file.status === 'OPEN' || file.status === 'ON_HOLD');
  const summary = useQuery({
    queryKey: ['file-summary', file.id],
    queryFn: () => api.get<{ counts: { shipments: number; containers: number; goodsLines: number; documents: number; openTasks: number } }>(`/clearance-files/${file.id}/summary`),
  });
  const counts = summary.data?.counts;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="space-y-4 p-5 lg:col-span-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-700">{t('files.details')}</h2>
          {canEdit && !editing && <Button variant="secondary" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}
        </div>
        {editing ? <EditForm file={file} onDone={() => setEditing(false)} /> : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <Item label={t('files.client')}><span dir="auto">{file.client.name}</span> <span className="text-slate-400" dir="ltr">({file.client.clientCode})</span></Item>
            <Item label={t('files.type')}>{t(`files.types.${file.fileType}`)}</Item>
            <Item label={t('files.branch')}>{file.branch ? <span dir="auto">{file.branch.name}</span> : '—'}</Item>
            <Item label={t('files.priority')}>{t(`files.priorities.${file.priority}`)}</Item>
            <Item label={t('files.arrival')}>{formatDate(file.expectedArrivalAt, locale)}</Item>
            <Item label={t('files.customsReference')}><span dir="ltr">{file.customsReference ?? '—'}</span></Item>
            <Item label={t('files.openedAt')}>{formatDate(file.openedAt, locale)}</Item>
            <Item label={t('files.createdBy')}>{file.createdBy ? fullName(file.createdBy) : '—'}</Item>
            {file.closedAt && <Item label={t('files.closedAt')}>{formatDate(file.closedAt, locale)}</Item>}
            <Item label={t('files.workflow')}>{file.workflowTemplate?.name ?? '—'}</Item>
            <div className="sm:col-span-2"><Item label={t('files.internalNotes')}><span className="whitespace-pre-wrap" dir="auto">{file.internalNotes || '—'}</span></Item></div>
          </dl>
        )}
      </Card>

      <div className="space-y-4">
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">{t('files.summary.title')}</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {(['shipments', 'containers', 'goodsLines', 'documents', 'openTasks'] as const).map((k) => (
              <div key={k}>
                <dt className="text-xs text-slate-500">{t(`files.summary.${k}`)}</dt>
                <dd className="text-lg font-semibold tabular-nums">{counts ? counts[k] : '…'}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">{t('files.shipments')}</h2>
          {file.shipments.length === 0 ? <p className="text-sm text-slate-500">{t('files.noShipments')}</p> : (
            <ul className="space-y-2 text-sm">
              {file.shipments.map((s) => (
                <li key={s.id} className="flex flex-wrap justify-between gap-2">
                  <span dir="auto">{t(`files.shipmentTypes.${s.shipmentType}`)}{s.vesselName ? ` · ${s.vesselName}` : ''}{s.billOfLadingNumber ? ` · ${s.billOfLadingNumber}` : ''}</span>
                  <span className="text-slate-500">{s._count.containers} / {s._count.goodsItems}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
