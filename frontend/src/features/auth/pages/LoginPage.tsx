import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError } from '@/lib/api-client';
import { setLocale } from '@/i18n';
import type { Locale } from '@/lib/format';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { useAuth } from '../auth';

const schema = z.object({ email: z.string().trim().email(), password: z.string().min(1), office: z.string().optional() });
type Form = z.infer<typeof schema>;

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { status, login, sessionExpired } = useAuth();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [offices, setOffices] = useState<{ id: string; slug: string; name: string }[] | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema) });
  const locale = i18n.language as Locale;

  if (status === 'authenticated') return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await login(v.email, v.password, v.office);
      if (r.status === 'choose-office') setOffices(r.offices);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setError(t('auth.rateLimited'));
      else if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setError(t('auth.invalid'));
      else setError(e instanceof Error ? e.message : t('common.error'));
    }
  });

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-brand-700">{t('app.name')}</h1>
          <p className="text-sm text-slate-500">{t('app.tagline')}</p>
        </div>
        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {sessionExpired && <p role="status" className="rounded bg-amber-50 p-2 text-sm text-amber-800">{t('auth.sessionExpired')}</p>}
            {error && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            <Field label={t('auth.email')} htmlFor="email" error={errors.email ? t('auth.invalid') : undefined}>
              <Input id="email" type="email" autoComplete="username" dir="ltr" {...register('email')} />
            </Field>
            <Field label={t('auth.password')} htmlFor="password" error={errors.password ? t('auth.invalid') : undefined}>
              <Input id="password" type="password" autoComplete="current-password" dir="ltr" {...register('password')} />
            </Field>
            {offices && (
              <Field label={t('auth.chooseOffice')} htmlFor="office">
                <Select id="office" defaultValue="" {...register('office')}>
                  <option value="" disabled>—</option>
                  {offices.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}
                </Select>
              </Field>
            )}
            <Button type="submit" className="w-full" loading={isSubmitting}>{isSubmitting ? t('auth.signingIn') : t('auth.signIn')}</Button>
          </form>
        </Card>
        <div className="text-center">
          <button className="text-sm text-slate-500 underline" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>{locale === 'ar' ? 'English' : 'العربية'}</button>
        </div>
      </div>
    </div>
  );
}
