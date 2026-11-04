import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Spinner, Textarea } from '@/components/ui/primitives';
import { permissionArea, type Permission, type Role } from '../types';

/** The permission checkboxes, grouped by area. The user can only grant what they hold themselves (the API enforces it too). */
function PermissionPicker({ all, held, value, onChange }: { all: Permission[]; held: ReadonlySet<string>; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useTranslation();
  const areas = [...new Set(all.map((p) => permissionArea(p.code)))];
  const toggle = (code: string) => onChange(value.includes(code) ? value.filter((c) => c !== code) : [...value, code]);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {areas.map((area) => (
        <fieldset key={area} className="space-y-1 rounded-md border border-slate-200 bg-white p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t(`users.areas.${area}`, { defaultValue: area })}</legend>
          {all.filter((p) => permissionArea(p.code) === area).map((p) => (
            <label key={p.code} className="flex items-start gap-2 text-sm" title={held.has(p.code) ? undefined : t('users.cannotGrant')}>
              <input type="checkbox" className="mt-1" checked={value.includes(p.code)} disabled={!held.has(p.code) && !value.includes(p.code)} onChange={() => toggle(p.code)} />
              <span><span dir="ltr" className="font-mono text-xs">{p.code}</span>{p.description && <span className="block text-xs text-slate-500">{p.description}</span>}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function RoleEditor({ role, all, onDone }: { role?: Role; all: Permission[]; onDone: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [codes, setCodes] = useState<string[]>(role?.permissionCodes ?? []);
  const [touched, setTouched] = useState(false);
  const codeBad = !role && !/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(code.trim());
  const nameBad = !role && name.trim().length < 2;
  const save = useMutation({
    mutationFn: () => (role
      ? api.put(`/roles/${role.id}/permissions`, { permissionCodes: codes })
      : api.post('/roles', { code: code.trim(), name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), permissionCodes: codes })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['roles'] }); onDone(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!codeBad && !nameBad) save.mutate(); }} className="space-y-4" noValidate>
      <h3 className="text-sm font-semibold text-slate-700">{role ? t('users.editPermissions', { name: role.name }) : t('users.newRole')}</h3>
      {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
      {!role && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('users.roleCode')} htmlFor="role-code" hint={t('users.roleCodeHint')} error={touched && codeBad ? t('users.roleCodeInvalid') : undefined}><Input id="role-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Field label={t('common.name')} htmlFor="role-name" error={touched && nameBad ? t('acc.nameShort') : undefined}><Input id="role-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="sm:col-span-2"><Field label={t('inv.description')} htmlFor="role-desc"><Textarea id="role-desc" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        </div>
      )}
      <PermissionPicker all={all} held={permissions} value={codes} onChange={setCodes} />
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

export function RolesTab() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const canManage = can(permissions, 'roles.manage');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const roles = useQuery({ queryKey: ['roles'], queryFn: ({ signal }) => api.get<Role[]>('/roles', undefined, signal) });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions'), enabled: canManage });

  return (
    <div className="space-y-4">
      {canManage && editing === null && <div><Button onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden />{t('users.newRole')}</Button></div>}
      {editing === 'new' && perms.data && <Card className="p-5"><RoleEditor all={perms.data} onDone={() => setEditing(null)} /></Card>}
      {roles.isPending && <Spinner />}
      {roles.isError && <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />}
      {roles.data && roles.data.length === 0 && <EmptyState>{t('users.noRoles')}</EmptyState>}
      {roles.data?.map((r) => (
        <Card key={r.id} className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900" dir="auto">{r.name} <Badge tone={r.isSystem ? 'blue' : 'neutral'} className="ms-2">{r.isSystem ? t('users.systemRole') : t('users.customRole')}</Badge></h2>
              {r.description && <p className="text-sm text-slate-600" dir="auto">{r.description}</p>}
              <p className="text-xs text-slate-500">{t('users.permissionCount', { count: r.permissionCodes.length })}</p>
            </div>
            <div className="flex gap-1">
              <Button variant="ghost" aria-expanded={open === r.id} aria-label={`${open === r.id ? t('inv.hide') : t('users.showPermissions')} ${r.name}`} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? t('inv.hide') : t('users.showPermissions')}</Button>
              {canManage && !r.isSystem && editing === null && <Button variant="ghost" aria-label={`${t('common.edit')} ${r.name}`} onClick={() => setEditing(r.id)}>{t('common.edit')}</Button>}
            </div>
          </div>
          {open === r.id && editing !== r.id && (
            <ul className="flex flex-wrap gap-1">{r.permissionCodes.map((c) => <li key={c}><Badge tone="neutral"><span dir="ltr" className="font-mono">{c}</span></Badge></li>)}</ul>
          )}
          {editing === r.id && perms.data && <RoleEditor role={r} all={perms.data} onDone={() => setEditing(null)} />}
        </Card>
      ))}
      {!canManage && <p className="text-xs text-slate-500">{t('users.rolesReadOnly')}</p>}
    </div>
  );
}
