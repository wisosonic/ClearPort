import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth';
import { Alert, Button, Card, ErrorState, Field, Input, Select, Spinner, Textarea } from '@/components/ui/primitives';

interface Office {
  id: string; name: string; slug: string; legalName: string | null; email: string | null; phone: string | null; address: string | null;
  defaultCurrency: string; timezone: string; locale: 'en' | 'ar'; allowSelfApproval?: boolean; status: string;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const zones = (): string[] => { try { return (Intl as any).supportedValuesOf?.('timeZone') ?? []; } catch { return []; } };

function OfficeForm({ office }: { office: Office }) {
  const { t } = useTranslation();
  const { reloadMe } = useAuth();
  const [name, setName] = useState(office.name);
  const [legalName, setLegalName] = useState(office.legalName ?? '');
  const [email, setEmail] = useState(office.email ?? '');
  const [phone, setPhone] = useState(office.phone ?? '');
  const [address, setAddress] = useState(office.address ?? '');
  const [timezone, setTimezone] = useState(office.timezone);
  const [locale, setLocale] = useState(office.locale);
  const [selfApproval, setSelfApproval] = useState(office.allowSelfApproval ?? true);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const known = zones();
  const errors = {
    name: name.trim().length < 2 ? t('settings.nameShort') : undefined,
    email: email.trim() !== '' && !EMAIL.test(email.trim()) ? t('clients.emailInvalid') : undefined,
    timezone: !timezone.trim() || (known.length > 0 && !known.includes(timezone.trim())) ? t('settings.timezoneInvalid') : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);
  const save = useMutation({
    mutationFn: () => api.patch('/tenant', {
      name: name.trim(), legalName: legalName.trim() || null, email: email.trim() || null, phone: phone.trim() || null, address: address.trim() || null,
      timezone: timezone.trim(), locale, allowSelfApproval: selfApproval,
    }),
    onSuccess: async () => { setSaved(true); await reloadMe(); },
  });

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); setSaved(false); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        {saved && !save.isPending && !save.isError && <Alert tone="green">{t('settings.saved')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.officeName')} htmlFor="off-name" error={touched ? errors.name : undefined}><Input id="off-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('clients.legalName')} htmlFor="off-legal"><Input id="off-legal" dir="auto" value={legalName} onChange={(e) => setLegalName(e.target.value)} /></Field>
          <Field label={t('clients.email')} htmlFor="off-email" error={touched ? errors.email : undefined}><Input id="off-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('clients.phone')} htmlFor="off-phone"><Input id="off-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label={t('settings.timezone')} htmlFor="off-tz" error={touched ? errors.timezone : undefined}>
            <Input id="off-tz" dir="ltr" list="timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            <datalist id="timezones">{known.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
          <Field label={t('settings.officeLanguage')} htmlFor="off-locale">
            <Select id="off-locale" value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'ar')}><option value="en">English</option><option value="ar">العربية</option></Select>
          </Field>
        </div>
        <Field label={t('clients.address')} htmlFor="off-address"><Textarea id="off-address" dir="auto" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={!selfApproval} onChange={(e) => setSelfApproval(!e.target.checked)} />
          <span>{t('settings.separateApproval')}<span className="block text-xs text-slate-500">{t('settings.separateApprovalHint')}</span></span>
        </label>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">{t('settings.baseCurrency')}</dt><dd dir="ltr">{office.defaultCurrency}</dd><p className="text-xs text-slate-500">{t('settings.baseCurrencyHint')}</p></div>
          <div><dt className="text-xs text-slate-500">{t('settings.slug')}</dt><dd dir="ltr">{office.slug}</dd></div>
        </dl>
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
      </form>
    </Card>
  );
}

export function OfficeTab() {
  const q = useQuery({ queryKey: ['office'], queryFn: ({ signal }) => api.get<Office>('/tenant', undefined, signal) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <OfficeForm office={q.data} />;
}
