import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api-client';
import { useDebounced } from '@/hooks/useDebounced';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { PartyPicker } from '@/features/parties/PartyPicker';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { dateToIso, isoToDate } from '../../lib';
import type { Container, Goods, Shipment } from './types';

const decimal = z.string().trim().refine((v) => v === '' || /^\d+(\.\d+)?$/.test(v), 'ship.invalidNumber');
const SHIPMENT_TYPES = ['SEA', 'AIR', 'LAND', 'OTHER'] as const;
const CONTAINER_STATUSES = ['PLANNED', 'AT_PORT', 'RELEASED', 'DELIVERED', 'RETURNED'] as const;
const msg = (t: (k: string) => string, e?: { message?: string }) => (e?.message ? t(e.message) : undefined);
const text = (v: string) => v.trim() || undefined;
const nullable = (v: string) => (v.trim() ? v.trim() : null);
const stripNumber = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
const sameNumber = (a: string, b: string) => stripNumber(a) === stripNumber(b);

/** Shows what the server said, or a generic line. */
function Problem({ error }: { error: unknown }) {
  const { t } = useTranslation();
  return <Alert>{error instanceof ApiError ? error.message : t('common.error')}</Alert>;
}

function FormActions({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2">
      <Button type="submit" loading={pending}>{t('common.save')}</Button>
      <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
    </div>
  );
}

/** Refreshes everything that shows this file's shipment data. */
function useRefresh(fileId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['shipments', fileId] }),
    qc.invalidateQueries({ queryKey: ['shipment'] }),
    qc.invalidateQueries({ queryKey: ['file', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
  ]);
}

// ───────────────────────────── ports ─────────────────────────────

interface PortOption { id: string; code: string; name: string; countryCode: string }

function PortPicker({ id, value, current, onChange }: { id: string; value: string; current?: PortOption | null; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim());
  const q = useQuery({ queryKey: ['ports', search], queryFn: ({ signal }) => api.list<PortOption>('/ports', { search, limit: 25 }, signal) });
  const options = q.data?.data ?? [];
  const shown = current && !options.some((o) => o.id === current.id) ? [current, ...options] : options;
  return (
    <div className="space-y-1">
      <Input type="search" aria-label={`${t('ship.portSearch')} (${id})`} placeholder={t('ship.portSearch')} value={term} onChange={(e) => setTerm(e.target.value)} />
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {shown.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}
      </Select>
    </div>
  );
}

// ───────────────────────────── shipment ─────────────────────────────

const shipmentSchema = z.object({
  shipmentType: z.enum(SHIPMENT_TYPES), vesselName: z.string().max(150, 'files.tooLong'), voyageNumber: z.string().max(50, 'files.tooLong'),
  billOfLadingNumber: z.string().max(60, 'files.tooLong'), masterBlNumber: z.string().max(60, 'files.tooLong'), houseBlNumber: z.string().max(60, 'files.tooLong'),
  originPortId: z.string(), destinationPortId: z.string(), shippingAgentId: z.string(), freightForwarderId: z.string(), etd: z.string(), eta: z.string(), actualArrivalAt: z.string(), notes: z.string().max(2000, 'files.tooLong'),
});
type ShipmentValues = z.infer<typeof shipmentSchema>;

export function ShipmentForm({ fileId, shipment, onDone }: { fileId: string; shipment?: Shipment; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(fileId);
  const { permissions } = useAuth();
  // Listing parties needs clients.view. Without it the pickers are hidden and the saved agent and forwarder are left exactly as they are.
  const canPickParties = can(permissions, 'clients.view');
  const { register, handleSubmit, setValue, watch, formState: { errors } } = useForm<ShipmentValues>({
    resolver: zodResolver(shipmentSchema),
    defaultValues: {
      shipmentType: (shipment?.shipmentType as ShipmentValues['shipmentType']) ?? 'SEA', vesselName: shipment?.vesselName ?? '', voyageNumber: shipment?.voyageNumber ?? '',
      billOfLadingNumber: shipment?.billOfLadingNumber ?? '', masterBlNumber: shipment?.masterBlNumber ?? '', houseBlNumber: shipment?.houseBlNumber ?? '',
      originPortId: shipment?.originPort?.id ?? '', destinationPortId: shipment?.destinationPort?.id ?? '',
      shippingAgentId: shipment?.shippingAgent?.id ?? '', freightForwarderId: shipment?.freightForwarder?.id ?? '',
      etd: isoToDate(shipment?.etd), eta: isoToDate(shipment?.eta), actualArrivalAt: isoToDate(shipment?.actualArrivalAt), notes: shipment?.notes ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: ShipmentValues) => {
      if (shipment) {
        return api.patch(`/shipments/${shipment.id}`, {
          shipmentType: v.shipmentType, vesselName: v.vesselName.trim(), voyageNumber: v.voyageNumber.trim(), billOfLadingNumber: v.billOfLadingNumber.trim(),
          masterBlNumber: v.masterBlNumber.trim(), houseBlNumber: v.houseBlNumber.trim(), notes: v.notes.trim(),
          originPortId: v.originPortId || null, destinationPortId: v.destinationPortId || null,
          ...(canPickParties ? { shippingAgentId: v.shippingAgentId || null, freightForwarderId: v.freightForwarderId || null } : {}),
          etd: dateToIso(v.etd) ?? null, eta: dateToIso(v.eta) ?? null, actualArrivalAt: dateToIso(v.actualArrivalAt) ?? null,
        });
      }
      return api.post(`/clearance-files/${fileId}/shipments`, {
        shipmentType: v.shipmentType, vesselName: text(v.vesselName), voyageNumber: text(v.voyageNumber), billOfLadingNumber: text(v.billOfLadingNumber),
        masterBlNumber: text(v.masterBlNumber), houseBlNumber: text(v.houseBlNumber), notes: text(v.notes),
        originPortId: v.originPortId || undefined, destinationPortId: v.destinationPortId || undefined,
        ...(canPickParties ? { shippingAgentId: v.shippingAgentId || undefined, freightForwarderId: v.freightForwarderId || undefined } : {}),
        etd: dateToIso(v.etd), eta: dateToIso(v.eta), actualArrivalAt: dateToIso(v.actualArrivalAt),
      });
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const text_ = (k: keyof ShipmentValues, label: string, dir?: 'ltr') => (
    <Field label={label} htmlFor={`sh-${k}`} error={msg(t, errors[k])}><Input id={`sh-${k}`} dir={dir ?? 'auto'} {...register(k)} /></Field>
  );

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
      {save.isError && <Problem error={save.error} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('ship.type')} htmlFor="sh-type">
          <Select id="sh-type" {...register('shipmentType')}>{SHIPMENT_TYPES.map((v) => <option key={v} value={v}>{t(`files.shipmentTypes.${v}`)}</option>)}</Select>
        </Field>
        {text_('vesselName', t('ship.vessel'))}
        {text_('voyageNumber', t('ship.voyage'), 'ltr')}
        {text_('billOfLadingNumber', t('ship.bl'), 'ltr')}
        {text_('masterBlNumber', t('ship.masterBl'), 'ltr')}
        {text_('houseBlNumber', t('ship.houseBl'), 'ltr')}
        <Field label={t('ship.originPort')} htmlFor="sh-origin"><PortPicker id="sh-origin" value={watch('originPortId')} current={shipment?.originPort} onChange={(v) => setValue('originPortId', v)} /></Field>
        <Field label={t('ship.destinationPort')} htmlFor="sh-destination"><PortPicker id="sh-destination" value={watch('destinationPortId')} current={shipment?.destinationPort} onChange={(v) => setValue('destinationPortId', v)} /></Field>
        {canPickParties && <Field label={t('ship.agent')} htmlFor="sh-agent"><PartyPicker id="sh-agent" type="SHIPPING_AGENT" value={watch('shippingAgentId')} current={shipment?.shippingAgent} onChange={(v) => setValue('shippingAgentId', v)} /></Field>}
        {canPickParties && <Field label={t('ship.forwarder')} htmlFor="sh-forwarder"><PartyPicker id="sh-forwarder" type="FREIGHT_FORWARDER" value={watch('freightForwarderId')} current={shipment?.freightForwarder} onChange={(v) => setValue('freightForwarderId', v)} /></Field>}
        <Field label={t('ship.etd')} htmlFor="sh-etd"><Input id="sh-etd" type="date" {...register('etd')} /></Field>
        <Field label={t('ship.eta')} htmlFor="sh-eta"><Input id="sh-eta" type="date" {...register('eta')} /></Field>
        <Field label={t('ship.actualArrival')} htmlFor="sh-actual"><Input id="sh-actual" type="date" {...register('actualArrivalAt')} /></Field>
      </div>
      <Field label={t('ship.notes')} htmlFor="sh-notes" error={msg(t, errors.notes)}><Textarea id="sh-notes" dir="auto" {...register('notes')} /></Field>
      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

// ───────────────────────────── container ─────────────────────────────

const containerSchema = z.object({
  containerNumber: z.string().trim().min(1, 'ship.numberRequired').max(20, 'files.tooLong'), containerType: z.string().max(20, 'files.tooLong'), sealNumber: z.string().max(50, 'files.tooLong'),
  grossWeight: decimal, netWeight: decimal, packageCount: z.string().trim().refine((v) => v === '' || /^\d+$/.test(v), 'ship.invalidNumber'),
  status: z.enum(CONTAINER_STATUSES),
});
type ContainerValues = z.infer<typeof containerSchema>;

export function ContainerForm({ fileId, shipmentId, container, onDone }: { fileId: string; shipmentId: string; container?: Container; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(fileId);
  const [nonStandard, setNonStandard] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<ContainerValues>({
    resolver: zodResolver(containerSchema),
    defaultValues: {
      containerNumber: container?.containerNumber ?? '', containerType: container?.containerType ?? '', sealNumber: container?.sealNumber ?? '',
      grossWeight: container?.grossWeight ?? '', netWeight: container?.netWeight ?? '', packageCount: container?.packageCount?.toString() ?? '',
      status: (container?.status as ContainerValues['status']) ?? 'PLANNED',
    },
  });
  const save = useMutation({
    mutationFn: (v: ContainerValues) => {
      const body = container
        ? {
          // the number is only re-validated by the server when it actually changes
          ...(sameNumber(v.containerNumber, container.containerNumber) ? {} : { containerNumber: v.containerNumber.trim(), nonStandardNumber: nonStandard }),
          containerType: v.containerType.trim(), sealNumber: v.sealNumber.trim(),
          grossWeight: nullable(v.grossWeight), netWeight: nullable(v.netWeight), packageCount: v.packageCount ? Number(v.packageCount) : null, status: v.status,
        }
        : {
          containerNumber: v.containerNumber.trim(), nonStandardNumber: nonStandard, containerType: text(v.containerType), sealNumber: text(v.sealNumber),
          grossWeight: text(v.grossWeight), netWeight: text(v.netWeight), packageCount: v.packageCount ? Number(v.packageCount) : undefined, status: v.status,
        };
      return container ? api.patch(`/containers/${container.id}`, body) : api.post(`/shipments/${shipmentId}/containers`, body);
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const notIso = save.error instanceof ApiError && save.error.code === 'CONTAINER_NUMBER_NOT_ISO6346';

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4" noValidate>
      {save.isError && <Problem error={save.error} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('ship.containerNumber')} htmlFor="ct-number" error={msg(t, errors.containerNumber)}><Input id="ct-number" dir="ltr" {...register('containerNumber')} /></Field>
        <Field label={t('ship.containerType')} htmlFor="ct-type" error={msg(t, errors.containerType)}><Input id="ct-type" dir="ltr" placeholder="40HC" {...register('containerType')} /></Field>
        <Field label={t('ship.seal')} htmlFor="ct-seal" error={msg(t, errors.sealNumber)}><Input id="ct-seal" dir="ltr" {...register('sealNumber')} /></Field>
        <Field label={t('ship.grossWeight')} htmlFor="ct-gross" error={msg(t, errors.grossWeight)}><Input id="ct-gross" dir="ltr" inputMode="decimal" {...register('grossWeight')} /></Field>
        <Field label={t('ship.netWeight')} htmlFor="ct-net" error={msg(t, errors.netWeight)}><Input id="ct-net" dir="ltr" inputMode="decimal" {...register('netWeight')} /></Field>
        <Field label={t('ship.packages')} htmlFor="ct-packages" error={msg(t, errors.packageCount)}><Input id="ct-packages" dir="ltr" inputMode="numeric" {...register('packageCount')} /></Field>
        <Field label={t('common.status')} htmlFor="ct-status">
          <Select id="ct-status" {...register('status')}>{CONTAINER_STATUSES.map((s) => <option key={s} value={s}>{t(`ship.containerStatuses.${s}`)}</option>)}</Select>
        </Field>
      </div>
      {(notIso || nonStandard) && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={nonStandard} onChange={(e) => setNonStandard(e.target.checked)} />
          <span>{t('ship.nonStandard')}<span className="block text-xs text-slate-500">{t('ship.nonStandardHint')}</span></span>
        </label>
      )}
      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

// ───────────────────────────── goods ─────────────────────────────

const goodsSchema = z.object({
  description: z.string().trim().min(1, 'ship.descriptionRequired').max(2000, 'files.tooLong'),
  countryOfOrigin: z.string().trim().refine((v) => v === '' || /^[A-Za-z]{2}$/.test(v), 'ship.invalidCountry'),
  quantity: decimal, unitOfMeasure: z.string().max(20, 'files.tooLong'), grossWeight: decimal, netWeight: decimal, unitPrice: decimal, lineTotal: decimal, currencyCode: z.string(),
}).refine((v) => !(v.unitPrice || v.lineTotal) || v.currencyCode, { message: 'ship.currencyRequired', path: ['currencyCode'] });
type GoodsValues = z.infer<typeof goodsSchema>;

export function GoodsForm({ fileId, shipmentId, goods, onDone }: { fileId: string; shipmentId: string; goods?: Goods; onDone: () => void }) {
  const { t } = useTranslation();
  const refresh = useRefresh(fileId);
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<{ code: string; name?: string }[]>('/currencies') });
  const { register, handleSubmit, watch, formState: { errors } } = useForm<GoodsValues>({
    resolver: zodResolver(goodsSchema),
    defaultValues: {
      description: goods?.description ?? '', countryOfOrigin: goods?.countryOfOrigin ?? '', quantity: goods?.quantity ?? '', unitOfMeasure: goods?.unitOfMeasure ?? '',
      grossWeight: goods?.grossWeight ?? '', netWeight: goods?.netWeight ?? '', unitPrice: goods?.unitPrice ?? '', lineTotal: goods?.lineTotal ?? '', currencyCode: goods?.currencyCode ?? '',
    },
  });
  const computed = !!(watch('quantity') && watch('unitPrice'));
  const save = useMutation({
    mutationFn: (v: GoodsValues) => {
      const body = goods
        ? {
          description: v.description.trim(), countryOfOrigin: v.countryOfOrigin ? v.countryOfOrigin.toUpperCase() : null, quantity: nullable(v.quantity), unitOfMeasure: v.unitOfMeasure.trim(),
          grossWeight: nullable(v.grossWeight), netWeight: nullable(v.netWeight), unitPrice: nullable(v.unitPrice), lineTotal: computed ? null : nullable(v.lineTotal), currencyCode: v.currencyCode || null,
        }
        : {
          description: v.description.trim(), countryOfOrigin: v.countryOfOrigin ? v.countryOfOrigin.toUpperCase() : undefined, quantity: text(v.quantity), unitOfMeasure: text(v.unitOfMeasure),
          grossWeight: text(v.grossWeight), netWeight: text(v.netWeight), unitPrice: text(v.unitPrice), lineTotal: computed ? undefined : text(v.lineTotal), currencyCode: v.currencyCode || undefined,
        };
      return goods ? api.patch(`/goods/${goods.id}`, body) : api.post(`/shipments/${shipmentId}/goods`, body);
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const num = (k: keyof GoodsValues, label: string, hint?: string, disabled?: boolean): ReactNode => (
    <Field label={label} htmlFor={`gd-${k}`} hint={hint} error={msg(t, errors[k])}><Input id={`gd-${k}`} dir="ltr" inputMode="decimal" disabled={disabled} {...register(k)} /></Field>
  );

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4" noValidate>
      {save.isError && <Problem error={save.error} />}
      <Field label={t('ship.description')} htmlFor="gd-description" error={msg(t, errors.description)}><Textarea id="gd-description" dir="auto" {...register('description')} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('ship.originCountry')} htmlFor="gd-country" hint="LB, CN, TR…" error={msg(t, errors.countryOfOrigin)}><Input id="gd-country" dir="ltr" maxLength={2} {...register('countryOfOrigin')} /></Field>
        {num('quantity', t('ship.quantity'))}
        <Field label={t('ship.unit')} htmlFor="gd-unit" error={msg(t, errors.unitOfMeasure)}><Input id="gd-unit" dir="auto" {...register('unitOfMeasure')} /></Field>
        {num('grossWeight', t('ship.grossWeight'))}
        {num('netWeight', t('ship.netWeight'))}
        {num('unitPrice', t('ship.unitPrice'))}
        {num('lineTotal', t('ship.lineTotal'), computed ? t('ship.autoTotal') : undefined, computed)}
        <Field label={t('ship.currency')} htmlFor="gd-currency" error={msg(t, errors.currencyCode)}>
          <Select id="gd-currency" {...register('currencyCode')}>
            <option value="">—</option>
            {(currencies.data ?? []).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </Select>
        </Field>
      </div>
      <FormActions pending={save.isPending} onCancel={onDone} />
    </form>
  );
}
