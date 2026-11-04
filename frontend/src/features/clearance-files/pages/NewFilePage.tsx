import { useMutation, useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { ClientPicker } from '../components/ClientPicker';
import { dateToIso } from '../lib';

const schema = z.object({
  clientId: z.string().min(1, 'files.clientRequired'),
  fileType: z.enum(['IMPORT', 'EXPORT', 'OTHER']),
  branchId: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
  expectedArrivalAt: z.string(),
  customsReference: z.string().max(100, 'files.tooLong'),
  internalNotes: z.string().max(5000, 'files.tooLong'),
});
type Form = z.infer<typeof schema>;

export function NewFilePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<{ id: string; code: string; name: string; isActive: boolean }[]>('/branches') });
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { clientId: '', fileType: 'IMPORT', branchId: '', priority: 'NORMAL', expectedArrivalAt: '', customsReference: '', internalNotes: '' },
  });
  const { register, control, handleSubmit, formState: { errors } } = form;

  const create = useMutation({
    mutationFn: (v: Form) => api.post<{ id: string }>('/clearance-files', {
      clientId: v.clientId, fileType: v.fileType, priority: v.priority,
      branchId: v.branchId || undefined,
      expectedArrivalAt: dateToIso(v.expectedArrivalAt),
      customsReference: v.customsReference.trim() || undefined,
      internalNotes: v.internalNotes.trim() || undefined,
    }),
    onSuccess: (file) => navigate(`/files/${file.id}`),
  });
  const msg = (e?: { message?: string }) => (e?.message ? t(e.message) : undefined);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('files.createTitle')}</h1>
        <Link to="/files" className="text-sm text-brand-700 hover:underline">{t('common.back')}</Link>
      </div>
      <Card className="p-5">
        <form onSubmit={handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
          {create.isError && <Alert>{create.error instanceof ApiError ? create.error.message : t('common.error')}</Alert>}

          <Field label={t('files.client')} htmlFor="clientId" error={msg(errors.clientId)}>
            <Controller control={control} name="clientId" render={({ field }) => <ClientPicker id="clientId" value={field.value} onChange={field.onChange} invalid={!!errors.clientId} />} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('files.type')} htmlFor="fileType">
              <Select id="fileType" {...register('fileType')}>
                {['IMPORT', 'EXPORT', 'OTHER'].map((v) => <option key={v} value={v}>{t(`files.types.${v}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('files.priority')} htmlFor="priority">
              <Select id="priority" {...register('priority')}>
                {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((v) => <option key={v} value={v}>{t(`files.priorities.${v}`)}</option>)}
              </Select>
            </Field>
            <Field label={t('files.branch')} htmlFor="branchId">
              <Select id="branchId" {...register('branchId')}>
                <option value="">{t('files.noBranch')}</option>
                {(branches.data ?? []).filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label={t('files.arrival')} htmlFor="expectedArrivalAt">
              <Input id="expectedArrivalAt" type="date" {...register('expectedArrivalAt')} />
            </Field>
          </div>

          <Field label={t('files.customsReference')} htmlFor="customsReference" error={msg(errors.customsReference)}>
            <Input id="customsReference" dir="ltr" {...register('customsReference')} />
          </Field>
          <Field label={t('files.internalNotes')} htmlFor="internalNotes" hint={t('files.internalNotesHint')} error={msg(errors.internalNotes)}>
            <Textarea id="internalNotes" dir="auto" {...register('internalNotes')} />
          </Field>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => navigate('/files')}>{t('common.cancel')}</Button>
            <Button type="submit" loading={create.isPending}>{t('files.create')}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
