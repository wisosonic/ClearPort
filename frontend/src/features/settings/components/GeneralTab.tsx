import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { can } from '@/lib/permissions';
import { FONT_SIZES, THEMES, setFontSize, setTheme, useFontSize, useTheme, type FontSize, type Theme } from '@/lib/appearance';
import { formatNumber, type Locale } from '@/lib/format';
import { useAuth } from '@/features/auth/auth';
import type { Currency } from '@/features/clearance-files/components/invoices/types';
import { Alert, Button, Card, ErrorState, Field, Input, Select, Spinner, Switch } from '@/components/ui/primitives';

interface Office { defaultCurrency: string; notifyInApp: boolean; notifyEmail: boolean; notifySms: boolean }
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const RATE = /^\d+(\.\d{1,10})?$/;

function Section({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        {intro && <p className="text-xs text-slate-500">{intro}</p>}
      </div>
      {children}
    </Card>
  );
}

/** A group of mutually exclusive choices shown as buttons (a radio group). */
function Choice<T extends string>({ label, value, options, onChange, name }: { label: string; value: T; options: { value: T; text: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="space-y-1">
      <p className="text-sm font-medium text-slate-700">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value} type="button" role="radio" aria-checked={value === o.value} data-name={name} onClick={() => onChange(o.value)}
            className={cn('rounded-md border px-4 py-2 text-sm', value === o.value ? 'border-brand-600 bg-brand-50 font-medium text-brand-700' : 'border-slate-300 text-slate-700 hover:bg-slate-50')}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

// ───────────────────────────── appearance ─────────────────────────────

function Appearance() {
  const { t } = useTranslation();
  const theme = useTheme();
  const size = useFontSize();
  return (
    <Section title={t('general.appearance.title')} intro={t('general.appearance.intro')}>
      <Choice<Theme> name="theme" label={t('general.appearance.theme')} value={theme} onChange={setTheme} options={THEMES.map((v) => ({ value: v, text: t(`general.appearance.themes.${v}`) }))} />
      <Choice<FontSize> name="font" label={t('general.appearance.fontSize')} value={size} onChange={setFontSize} options={FONT_SIZES.map((v) => ({ value: v, text: t(`general.appearance.sizes.${v}`) }))} />
      <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-slate-700">{t('general.appearance.sample')}</p>
    </Section>
  );
}

// ───────────────────────────── currency ─────────────────────────────

function MainCurrency({ office, canManage }: { office: Office; canManage: boolean }) {
  const { t } = useTranslation();
  const { reloadMe } = useAuth();
  const qc = useQueryClient();
  const [pick, setPick] = useState(office.defaultCurrency);
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const change = useQuery({ queryKey: ['currency-change'], enabled: canManage, queryFn: () => api.get<{ canChange: boolean; blockers: string[] }>('/tenant/currency-change') });
  const save = useMutation({
    mutationFn: () => api.patch('/tenant', { defaultCurrency: pick }),
    onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: ['office'] }), qc.invalidateQueries({ queryKey: ['currency-change'] }), reloadMe()]); },
  });
  const locked = change.data ? !change.data.canChange : true;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('general.currency.main')} htmlFor="gen-main-currency">
          <Select id="gen-main-currency" className="w-56" value={pick} disabled={!canManage || locked} onChange={(e) => setPick(e.target.value)}>
            {(currencies.data ?? [{ code: office.defaultCurrency, name: office.defaultCurrency, decimalPlaces: 2 }]).filter((c) => (c as { isActive?: boolean }).isActive !== false).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
          </Select>
        </Field>
        {canManage && !locked && pick !== office.defaultCurrency && <Button loading={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>}
      </div>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      {save.isSuccess && <Alert tone="green">{t('settings.saved')}</Alert>}
      <p className="text-xs text-slate-500">{t('general.currency.mainHint')}</p>
      {canManage && change.data && locked && (
        <Alert tone="amber">
          {t('general.currency.locked')} {change.data.blockers.map((b) => t(`general.currency.blockers.${b}`, { defaultValue: b })).join(', ')}.
        </Alert>
      )}
    </div>
  );
}

function RateCard({ base, canRecord }: { base: string; canRecord: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const others = (currencies.data ?? []).filter((c) => c.code !== base);
  const [chosen, setChosen] = useState('');
  const other = chosen && others.some((c) => c.code === chosen) ? chosen : (others.find((c) => c.code === (base === 'USD' ? 'LBP' : 'USD')) ?? others[0])?.code ?? '';
  const [rate, setRate] = useState('');
  const [touched, setTouched] = useState(false);
  const current = useQuery({
    queryKey: ['latest-rate', other], enabled: !!other, retry: false,
    queryFn: () => api.get<{ rate: string; convention: 'BASE_PER_FOREIGN' | 'FOREIGN_PER_BASE'; source: string }>('/exchange-rates/latest', { currency: other }),
  });
  const bad = !RATE.test(rate.trim()) || Number(rate) <= 0;
  const save = useMutation({
    // "1 base = rate other" is by definition the FOREIGN_PER_BASE convention
    mutationFn: () => api.post('/exchange-rates', { currency: other, rate: rate.trim(), convention: 'FOREIGN_PER_BASE', source: 'Settings' }),
    onSuccess: async () => { setRate(''); setTouched(false); await Promise.all([qc.invalidateQueries({ queryKey: ['latest-rate'] }), qc.invalidateQueries({ queryKey: ['rates'] })]); },
  });
  if (others.length === 0) return null;
  const c = current.data;
  const sentence = c ? (c.convention === 'FOREIGN_PER_BASE'
    ? t('general.currency.currentRate', { from: base, amount: formatNumber(c.rate, locale), to: other })
    : t('general.currency.currentRate', { from: other, amount: formatNumber(c.rate, locale), to: base })) : null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-slate-700">{t('general.currency.rateTitle', { base, other })}</h3>
      <p className="text-sm text-slate-600" dir="ltr">{current.isPending ? '…' : sentence ?? <span dir="auto">{t('general.currency.noRate', { other })}</span>}</p>
      {canRecord ? (
        <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!bad && other) save.mutate(); }} className="flex flex-wrap items-end gap-3" noValidate>
          <Field label={t('general.currency.newRate')} htmlFor="gen-rate" error={touched && bad ? t('acc.rateInvalid') : undefined}>
            <div className="flex items-center gap-2" dir="ltr">
              <span className="text-sm text-slate-600">1 {base} =</span>
              <Input id="gen-rate" inputMode="decimal" className="w-36" value={rate} onChange={(e) => setRate(e.target.value)} />
              <Select aria-label={t('inv.currency')} className="w-28" value={other} onChange={(e) => setChosen(e.target.value)}>
                {others.map((o) => <option key={o.code} value={o.code}>{o.code}</option>)}
              </Select>
            </div>
          </Field>
          <Button type="submit" loading={save.isPending}>{t('general.currency.recordRate')}</Button>
        </form>
      ) : <p className="text-xs text-slate-500">{t('general.currency.rateReadOnly')}</p>}
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      {save.isSuccess && <Alert tone="green">{t('general.currency.rateSaved')}</Alert>}
      <p className="text-xs text-slate-500">{t('acc.rateAppendOnly')}</p>
    </div>
  );
}

function CurrencySection({ office }: { office: Office }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  return (
    <Section title={t('general.currency.title')} intro={t('general.currency.intro')}>
      <MainCurrency office={office} canManage={can(permissions, 'settings.manage')} />
      <hr className="border-slate-200" />
      <RateCard base={office.defaultCurrency} canRecord={can(permissions, 'accounting.post')} />
    </Section>
  );
}

// ───────────────────────────── notifications ─────────────────────────────

const CHANNELS = [
  { key: 'notifyInApp', label: 'inApp', hint: 'inAppHint' }, { key: 'notifyEmail', label: 'email', hint: 'emailHint' }, { key: 'notifySms', label: 'sms', hint: 'smsHint' },
] as const;

function Notifications({ office }: { office: Office }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const canManage = can(permissions, 'settings.manage');
  const save = useMutation({
    mutationFn: (patch: Partial<Office>) => api.patch('/tenant', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['office'] }),
  });
  return (
    <Section title={t('general.notifications.title')} intro={t('general.notifications.intro')}>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      <ul className="divide-y divide-slate-100">
        {CHANNELS.map((c) => (
          <li key={c.key} className="py-3 first:pt-0 last:pb-0">
            <Switch
              label={t(`general.notifications.${c.label}`)} hint={t(`general.notifications.${c.hint}`)}
              checked={save.isPending && save.variables && c.key in save.variables ? !!save.variables[c.key] : office[c.key]}
              disabled={!canManage || save.isPending} onChange={(v) => save.mutate({ [c.key]: v })}
            />
          </li>
        ))}
      </ul>
      {!canManage && <p className="text-xs text-slate-500">{t('general.notifications.readOnly')}</p>}
    </Section>
  );
}

/** Settings → General: how the app looks for you, the office's main currency and exchange rate, and which notifications it sends. */
export function GeneralTab() {
  const q = useQuery({ queryKey: ['office'], queryFn: ({ signal }) => api.get<Office>('/tenant', undefined, signal) });
  return (
    <div className="space-y-4">
      <Appearance />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && <><CurrencySection office={q.data} /><Notifications office={q.data} /></>}
    </div>
  );
}
