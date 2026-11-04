import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, Field, Input } from '@/components/ui/primitives';

function ChangePassword() {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState(false);
  const errors = {
    current: !current ? t('account.currentRequired') : undefined,
    next: next.length < 10 ? t('users.passwordShort') : next === current ? t('account.mustDiffer') : undefined,
    again: again !== next ? t('account.mismatch') : undefined,
  };
  const valid = !errors.current && !errors.next && !errors.again;
  const save = useMutation({ mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }) });

  if (save.isSuccess) {
    // The API ends every session of this person when the password changes, so they sign in again with the new one.
    return (
      <div className="space-y-3">
        <Alert tone="green">{t('account.changed')}</Alert>
        <Button onClick={() => void logout()}>{t('account.signInAgain')}</Button>
      </div>
    );
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="max-w-md space-y-4" noValidate>
      {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
      <Field label={t('account.currentPassword')} htmlFor="pw-current" error={touched ? errors.current : undefined}>
        <Input id="pw-current" type="password" autoComplete="current-password" dir="ltr" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={t('account.newPassword')} htmlFor="pw-new" hint={t('account.newPasswordHint')} error={touched ? errors.next : undefined}>
        <Input id="pw-new" type="password" autoComplete="new-password" dir="ltr" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={t('account.repeatPassword')} htmlFor="pw-again" error={touched ? errors.again : undefined}>
        <Input id="pw-again" type="password" autoComplete="new-password" dir="ltr" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <p className="text-xs text-slate-500">{t('account.signOutNote')}</p>
      <Button type="submit" loading={save.isPending}>{t('account.changePassword')}</Button>
    </form>
  );
}

/** The signed-in person: who they are here, and their password. */
export function AccountPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">{t('account.title')}</h1>
      <Card className="space-y-3 p-5">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">{t('common.name')}</dt><dd className="text-sm" dir="auto">{me.user.firstName} {me.user.lastName}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('clients.email')}</dt><dd className="text-sm" dir="ltr">{me.user.email}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('auth.office')}</dt><dd className="text-sm" dir="auto">{me.tenant.name}</dd></div>
          <div><dt className="text-xs text-slate-500">{t('users.branch')}</dt><dd className="text-sm" dir="auto">{me.branch?.name ?? '—'}</dd></div>
        </dl>
        <div>
          <div className="mb-1 text-xs text-slate-500">{t('users.roles')}</div>
          <div className="flex flex-wrap gap-1">{me.roles.map((r) => <Badge key={r.id} tone="neutral">{r.name}</Badge>)}</div>
        </div>
      </Card>
      <Card className="space-y-3 p-5">
        <h2 className="text-sm font-semibold text-slate-700">{t('account.changePassword')}</h2>
        <ChangePassword />
      </Card>
    </div>
  );
}
