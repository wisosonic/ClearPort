import { useMutation } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import type { ClientDetail } from '../types';

const schema = z.object({
  clientType: z.enum(['COMPANY', 'INDIVIDUAL']),
  name: z.string().trim().min(1, 'clients.nameRequired').max(200, 'files.tooLong'),
  clientCode: z.string().trim().refine((v) => v === '' || /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v), 'clients.codeInvalid').refine((v) => v.length <= 30, 'files.tooLong'),
  legalName: z.string().max(200, 'files.tooLong'),
  taxNumber: z.string().max(100, 'files.tooLong'),
  registrationNumber: z.string().max(100, 'files.tooLong'),
  phone: z.string().max(50, 'files.tooLong'),
  email: z.string().trim().refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'clients.emailInvalid'),
  address: z.string().max(500, 'files.tooLong'),
  countryCode: z.string().trim().refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), 'ship.invalidCountry'),
  paymentTermsDays: z.string().trim().refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 365, 'clients.termsInvalid'),
  creditLimit: z.string().trim().refine((v) => v === '' || /^\d+(\.\d{1,4})?$/.test(v), 'clients.creditInvalid'),
  notes: z.string().max(2000, 'files.tooLong'),
});
type Values = z.infer<typeof schema>;

const blank = (s: string) => s.trim();

/** Create a client, or edit one (`client`; the code is fixed once created). Calls `onSaved` with the saved client. */
export function ClientForm({ client, onSaved, onCancel }: { client?: ClientDetail; onSaved: (c: ClientDetail) => void | Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const { register, handleSubmit, formState: { errors } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      clientType: client?.clientType ?? 'COMPANY', name: client?.name ?? '', clientCode: '', legalName: client?.legalName ?? '', taxNumber: client?.taxNumber ?? '',
      registrationNumber: client?.registrationNumber ?? '', phone: client?.phone ?? '', email: client?.email ?? '', address: client?.address ?? '',
      countryCode: client?.countryCode ?? '', paymentTermsDays: String(client?.paymentTermsDays ?? 0), creditLimit: client?.creditLimit ? client.creditLimit.replace(/\.?0+$/, '') : '', notes: client?.notes ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: Values) => {
      const common = {
        clientType: v.clientType, name: blank(v.name), legalName: blank(v.legalName), taxNumber: blank(v.taxNumber), registrationNumber: blank(v.registrationNumber),
        phone: blank(v.phone), address: blank(v.address), notes: blank(v.notes), paymentTermsDays: Number(v.paymentTermsDays),
      };
      if (client) {
        return api.patch<ClientDetail>(`/clients/${client.id}`, {
          ...common, email: blank(v.email) || null, countryCode: blank(v.countryCode).toUpperCase() || null, creditLimit: blank(v.creditLimit) || null,
        });
      }
      return api.post<ClientDetail>('/clients', {
        ...common, ...(blank(v.clientCode) ? { clientCode: blank(v.clientCode) } : {}), ...(blank(v.email) ? { email: blank(v.email) } : {}),
        ...(blank(v.countryCode) ? { countryCode: blank(v.countryCode).toUpperCase() } : {}), ...(blank(v.creditLimit) ? { creditLimit: blank(v.creditLimit) } : {}),
      });
    },
    onSuccess: async (c) => { await onSaved(c); },
  });
  const msg = (e?: { message?: string }) => (e?.message ? t(e.message) : undefined);

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
      {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('common.name')} htmlFor="client-name" error={msg(errors.name)}><Input id="client-name" dir="auto" {...register('name')} /></Field>
        <Field label={t('files.type')} htmlFor="client-type">
          <Select id="client-type" {...register('clientType')}>{['COMPANY', 'INDIVIDUAL'].map((x) => <option key={x} value={x}>{t(`clients.types.${x}`)}</option>)}</Select>
        </Field>
        {!client && (
          <Field label={t('clients.code')} htmlFor="client-code" hint={t('clients.codeHint')} error={msg(errors.clientCode)}><Input id="client-code" dir="ltr" {...register('clientCode')} /></Field>
        )}
        <Field label={t('clients.legalName')} htmlFor="client-legal" error={msg(errors.legalName)}><Input id="client-legal" dir="auto" {...register('legalName')} /></Field>
        <Field label={t('clients.taxNumber')} htmlFor="client-tax" error={msg(errors.taxNumber)}><Input id="client-tax" dir="ltr" {...register('taxNumber')} /></Field>
        <Field label={t('clients.registrationNumber')} htmlFor="client-reg" error={msg(errors.registrationNumber)}><Input id="client-reg" dir="ltr" {...register('registrationNumber')} /></Field>
        <Field label={t('clients.phone')} htmlFor="client-phone" error={msg(errors.phone)}><Input id="client-phone" dir="ltr" {...register('phone')} /></Field>
        <Field label={t('clients.email')} htmlFor="client-email" error={msg(errors.email)}><Input id="client-email" type="email" dir="ltr" {...register('email')} /></Field>
        <Field label={t('clients.country')} htmlFor="client-country" hint={t('clients.countryHint')} error={msg(errors.countryCode)}><Input id="client-country" dir="ltr" maxLength={2} {...register('countryCode')} /></Field>
        <Field label={t('clients.paymentTerms')} htmlFor="client-terms" hint={t('clients.paymentTermsHint')} error={msg(errors.paymentTermsDays)}><Input id="client-terms" inputMode="numeric" dir="ltr" {...register('paymentTermsDays')} /></Field>
        <Field label={t('clients.creditLimit')} htmlFor="client-credit" hint={t('clients.creditLimitHint')} error={msg(errors.creditLimit)}><Input id="client-credit" inputMode="decimal" dir="ltr" {...register('creditLimit')} /></Field>
      </div>
      <Field label={t('clients.address')} htmlFor="client-address" error={msg(errors.address)}><Textarea id="client-address" dir="auto" {...register('address')} /></Field>
      <Field label={t('clients.notes')} htmlFor="client-notes" error={msg(errors.notes)}><Textarea id="client-notes" dir="auto" {...register('notes')} /></Field>
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
