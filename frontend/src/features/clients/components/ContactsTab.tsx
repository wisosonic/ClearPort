import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, EmptyState, Field, Input } from '@/components/ui/primitives';
import type { ClientDetail, Contact } from '../types';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ContactForm({ clientId, contact, onDone }: { clientId: string; contact?: Contact; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(contact?.name ?? '');
  const [position, setPosition] = useState(contact?.position ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [primary, setPrimary] = useState(contact?.isPrimary ?? false);
  const [touched, setTouched] = useState(false);
  const emailBad = email.trim() !== '' && !EMAIL.test(email.trim());
  const valid = name.trim() !== '' && !emailBad;
  const save = useMutation({
    mutationFn: () => (contact
      ? api.patch(`/clients/${clientId}/contacts/${contact.id}`, { name: name.trim(), position: position.trim(), phone: phone.trim(), email: email.trim() || null, ...(primary && !contact.isPrimary ? { isPrimary: true } : {}) })
      : api.post(`/clients/${clientId}/contacts`, { name: name.trim(), position: position.trim(), phone: phone.trim(), ...(email.trim() ? { email: email.trim() } : {}), isPrimary: primary })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['client', clientId] }); onDone(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4" noValidate>
      {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} htmlFor="contact-name" error={touched && !name.trim() ? t('clients.nameRequired') : undefined}><Input id="contact-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('clients.position')} htmlFor="contact-position"><Input id="contact-position" dir="auto" value={position} onChange={(e) => setPosition(e.target.value)} /></Field>
        <Field label={t('clients.phone')} htmlFor="contact-phone"><Input id="contact-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label={t('clients.email')} htmlFor="contact-email" error={touched && emailBad ? t('clients.emailInvalid') : undefined}><Input id="contact-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      {!contact?.isPrimary && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />{t('clients.makePrimary')}</label>
      )}
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
        <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

function ContactItem({ clientId, c, canManage }: { clientId: string; c: Contact; canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => api.delete(`/clients/${clientId}/contacts/${c.id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['client', clientId] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  if (editing) return <li className="py-3"><ContactForm clientId={clientId} contact={c} onDone={() => setEditing(false)} /></li>;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-sm">
          <span dir="auto" className="font-medium">{c.name}</span>
          {c.isPrimary && <Badge tone="blue" className="ms-2">{t('clients.primary')}</Badge>}
          {c.position && <span dir="auto" className="block text-xs text-slate-500">{c.position}</span>}
          <span className="block text-slate-600" dir="ltr">{[c.phone, c.email].filter(Boolean).join(' · ') || '—'}</span>
        </div>
        {canManage && (
          <div className="flex gap-1">
            <Button variant="ghost" aria-label={`${t('common.edit')} ${c.name}`} onClick={() => setEditing(true)}>{t('common.edit')}</Button>
            <Button variant="ghost" aria-label={`${t('clients.removeContact')} ${c.name}`} onClick={() => setConfirm(true)}>{t('clients.removeContact')}</Button>
          </div>
        )}
      </div>
      {problem && <Alert>{problem}</Alert>}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t('clients.removeConfirm', { name: c.name })}</span>
          <Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('clients.removeContact')}</Button>
          <Button variant="secondary" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
        </div>
      )}
    </li>
  );
}

export function ContactsTab({ client, canManage }: { client: ClientDetail; canManage: boolean }) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">{t('clients.contacts')}</h2>
        {canManage && !adding && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('clients.addContact')}</Button>}
      </div>
      {adding && <ContactForm clientId={client.id} onDone={() => setAdding(false)} />}
      {client.contacts.length === 0 && !adding ? <EmptyState>{t('clients.noContacts')}</EmptyState> : (
        <ul className="divide-y divide-slate-100">{client.contacts.map((c) => <ContactItem key={c.id} clientId={client.id} c={c} canManage={canManage} />)}</ul>
      )}
    </Card>
  );
}
