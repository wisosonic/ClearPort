import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Card, ErrorState, Field, Input, Spinner } from '@/components/ui/primitives';

interface Tax { enabled: boolean; name: string; ratePercent: string }

function TaxForm({ tax }: { tax: Tax }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(tax.enabled);
  const [name, setName] = useState(tax.name);
  const [rate, setRate] = useState(tax.ratePercent.replace(/\.?0+$/, '') || '0');
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const rateBad = !/^\d+(\.\d{1,4})?$/.test(rate.trim()) || Number(rate) > 100;
  const nameBad = !name.trim() || name.trim().length > 30;
  const rateZeroWhenOn = enabled && !rateBad && Number(rate) === 0;
  const save = useMutation({
    mutationFn: () => api.put('/settings/tax', { enabled, name: name.trim(), ratePercent: rate.trim() }),
    onSuccess: async () => { setSaved(true); await qc.invalidateQueries({ queryKey: ['tax'] }); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); setSaved(false); if (!rateBad && !nameBad) save.mutate(); }} className="max-w-xl space-y-4" noValidate>
        <p className="text-sm text-slate-600">{t('settings.taxIntro')}</p>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        {saved && !save.isPending && !save.isError && <Alert tone="green">{t('settings.saved')}</Alert>}
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('settings.taxEnabled')}</label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.taxName')} htmlFor="tax-name" error={touched && nameBad ? t('settings.taxNameInvalid') : undefined}><Input id="tax-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('settings.taxRate')} htmlFor="tax-rate" error={touched && rateBad ? t('settings.taxRateInvalid') : undefined}><Input id="tax-rate" inputMode="decimal" dir="ltr" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        </div>
        {rateZeroWhenOn && <Alert tone="amber">{t('settings.taxZeroWarning')}</Alert>}
        <p className="text-xs text-slate-500">{t('settings.taxNewInvoicesOnly')}</p>
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
      </form>
    </Card>
  );
}

export function TaxTab() {
  const q = useQuery({ queryKey: ['tax'], queryFn: ({ signal }) => api.get<Tax>('/settings/tax', undefined, signal) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <TaxForm tax={q.data} />;
}
