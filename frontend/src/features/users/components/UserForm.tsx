import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { PasswordInput, Alert, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import type { Branch, Role, UserRow } from '../types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add a user to the office, or edit one (`user`; the e-mail is their sign-in and cannot change here). */
export function UserForm({ user, onSaved, onCancel }: { user?: UserRow; onSaved: () => void | Promise<void>; onCancel: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [password, setPassword] = useState('');
  const [branchId, setBranchId] = useState(user?.branch?.id ?? '');
  const [roleIds, setRoleIds] = useState<string[]>(user?.roles.map((r) => r.id) ?? []);
  const [touched, setTouched] = useState(false);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => api.get<Branch[]>('/branches') });

  const errors = {
    email: !user && !EMAIL.test(email.trim()) ? t('clients.emailInvalid') : undefined,
    firstName: !firstName.trim() ? t('users.firstNameRequired') : undefined,
    lastName: !lastName.trim() ? t('users.lastNameRequired') : undefined,
    password: !user && password !== '' && password.length < 10 ? t('users.passwordShort') : undefined,
    roles: roleIds.length === 0 ? t('users.roleRequired') : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);

  const save = useMutation({
    mutationFn: () => {
      if (!user) {
        return api.post('/users', {
          email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim(), roleIds,
          ...(phone.trim() ? { phone: phone.trim() } : {}), ...(password ? { password } : {}), ...(branchId ? { branchId } : {}),
        });
      }
      // The profile belongs to the person and may be shared by several offices, so it is sent only when it changed.
      const profileChanged = firstName.trim() !== user.firstName || lastName.trim() !== user.lastName || phone.trim() !== (user.phone ?? '');
      return api.patch(`/users/${user.id}`, {
        ...(profileChanged ? { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim() || null } : {}),
        branchId: branchId || null, roleIds,
      });
    },
    onSuccess: async () => { await onSaved(); },
  });
  const toggle = (id: string) => setRoleIds((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{user ? t('users.editUser') : t('users.addUser')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!user && <Field label={t('clients.email')} htmlFor="user-email" error={touched ? errors.email : undefined}><Input id="user-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}
          {!user && (
            <Field label={t('users.password')} htmlFor="user-password" hint={t('users.passwordHint')} error={touched ? errors.password : undefined}>
              <PasswordInput id="user-password" autoComplete="new-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          )}
          <Field label={t('users.firstName')} htmlFor="user-first" error={touched ? errors.firstName : undefined}><Input id="user-first" dir="auto" value={firstName} onChange={(e) => setFirstName(e.target.value)} /></Field>
          <Field label={t('users.lastName')} htmlFor="user-last" error={touched ? errors.lastName : undefined}><Input id="user-last" dir="auto" value={lastName} onChange={(e) => setLastName(e.target.value)} /></Field>
          <Field label={t('clients.phone')} htmlFor="user-phone"><Input id="user-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label={t('users.branch')} htmlFor="user-branch">
            <Select id="user-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t('users.noBranch')}</option>
              {(branches.data ?? []).filter((b) => b.isActive || b.id === branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700">{t('users.roles')}</legend>
          {(roles.data ?? []).map((r) => (
            <label key={r.id} className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={roleIds.includes(r.id)} onChange={() => toggle(r.id)} />
              <span><span className="font-medium">{r.name}</span>{r.description && <span className="block text-xs text-slate-500">{r.description}</span>}</span>
            </label>
          ))}
          {touched && errors.roles && <p role="alert" className="text-xs text-red-700">{errors.roles}</p>}
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
