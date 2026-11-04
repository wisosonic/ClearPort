import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, formatNumber, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Spinner, Td, Th } from '@/components/ui/primitives';
import type { FileDetail } from '../../lib';
import { ContainerForm, GoodsForm, ShipmentForm } from './forms';
import type { Shipment, ShipmentDetail } from './types';

const containerTone = { PLANNED: 'neutral', AT_PORT: 'blue', RELEASED: 'amber', DELIVERED: 'green', RETURNED: 'green' } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-slate-500">{label}</dt><dd className="text-sm" dir="auto">{children || '—'}</dd></div>;
}

function ShipmentCard({ file, shipment, editable }: { file: FileDetail; shipment: Shipment; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [mode, setMode] = useState<null | 'edit-shipment' | 'add-container' | 'add-goods' | { container: string } | { goods: string }>(null);
  const detail = useQuery({ queryKey: ['shipment', shipment.id], queryFn: () => api.get<ShipmentDetail>(`/shipments/${shipment.id}`) });
  const done = () => setMode(null);
  const s = detail.data ?? { ...shipment, containers: [], goodsItems: [] };
  const port = (p: Shipment['originPort']) => (p ? `${p.name} (${p.code})` : '');

  return (
    <Card className="space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold" dir="auto">{t(`files.shipmentTypes.${s.shipmentType}`)}{s.vesselName ? ` · ${s.vesselName}` : ''}{s.voyageNumber ? ` / ${s.voyageNumber}` : ''}</h3>
          <p className="text-xs text-slate-500">{s._count.containers} {t('ship.containers').toLowerCase()} · {s._count.goodsItems} {t('ship.goods').toLowerCase()}</p>
        </div>
        {editable && mode !== 'edit-shipment' && <Button variant="secondary" onClick={() => setMode('edit-shipment')}>{t('common.edit')}</Button>}
      </div>

      {mode === 'edit-shipment' ? <ShipmentForm fileId={file.id} shipment={s} onDone={done} /> : (
        <dl className="grid gap-3 sm:grid-cols-3">
          <Field label={t('ship.bl')}><span dir="ltr">{s.billOfLadingNumber}</span></Field>
          <Field label={t('ship.masterBl')}><span dir="ltr">{s.masterBlNumber}</span></Field>
          <Field label={t('ship.houseBl')}><span dir="ltr">{s.houseBlNumber}</span></Field>
          <Field label={t('ship.originPort')}>{port(s.originPort)}</Field>
          <Field label={t('ship.destinationPort')}>{port(s.destinationPort)}</Field>
          <Field label={t('ship.agent')}>{s.shippingAgent?.name}</Field>
          <Field label={t('ship.forwarder')}>{s.freightForwarder?.name}</Field>
          <Field label={t('ship.etd')}>{s.etd ? formatDate(s.etd, locale) : ''}</Field>
          <Field label={t('ship.eta')}>{s.eta ? formatDate(s.eta, locale) : ''}</Field>
          <Field label={t('ship.actualArrival')}>{s.actualArrivalAt ? formatDate(s.actualArrivalAt, locale) : ''}</Field>
          {s.notes && <div className="sm:col-span-3"><Field label={t('ship.notes')}><span className="whitespace-pre-wrap">{s.notes}</span></Field></div>}
        </dl>
      )}

      {detail.isPending && <Spinner />}
      {detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}

      {detail.data && (
        <>
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-700">{t('ship.containers')}</h4>
              {editable && mode !== 'add-container' && <Button variant="secondary" onClick={() => setMode('add-container')}><Plus className="size-4" aria-hidden />{t('ship.addContainer')}</Button>}
            </div>
            {mode === 'add-container' && <ContainerForm fileId={file.id} shipmentId={s.id} onDone={done} />}
            {s.containers.length === 0 ? <EmptyState>{t('ship.noContainers')}</EmptyState> : (
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full">
                  <thead className="bg-slate-50"><tr><Th>{t('ship.containerNumber')}</Th><Th>{t('ship.containerType')}</Th><Th>{t('ship.seal')}</Th><Th>{t('ship.grossWeight')}</Th><Th>{t('ship.packages')}</Th><Th>{t('common.status')}</Th>{editable && <Th><span className="sr-only">{t('common.actions')}</span></Th>}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {s.containers.map((c) => (typeof mode === 'object' && mode && 'container' in mode && mode.container === c.id ? (
                      <tr key={c.id}><td colSpan={7} className="p-3"><ContainerForm fileId={file.id} shipmentId={s.id} container={c} onDone={done} /></td></tr>
                    ) : (
                      <tr key={c.id}>
                        <Td className="font-medium tabular-nums" dir="ltr">{c.containerNumber}</Td>
                        <Td dir="ltr">{c.containerType ?? '—'}</Td>
                        <Td dir="ltr">{c.sealNumber ?? '—'}</Td>
                        <Td dir="ltr">{c.grossWeight ? formatNumber(c.grossWeight, locale) : '—'}</Td>
                        <Td>{c.packageCount ?? '—'}</Td>
                        <Td><Badge tone={containerTone[c.status as keyof typeof containerTone] ?? 'neutral'}>{t(`ship.containerStatuses.${c.status}`)}</Badge></Td>
                        {editable && <Td><Button variant="ghost" onClick={() => setMode({ container: c.id })}>{t('common.edit')}</Button></Td>}
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-slate-700">{t('ship.goods')}</h4>
              {editable && mode !== 'add-goods' && <Button variant="secondary" onClick={() => setMode('add-goods')}><Plus className="size-4" aria-hidden />{t('ship.addGoods')}</Button>}
            </div>
            {mode === 'add-goods' && <GoodsForm fileId={file.id} shipmentId={s.id} onDone={done} />}
            {s.goodsItems.length === 0 ? <EmptyState>{t('ship.noGoods')}</EmptyState> : (
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full">
                  <thead className="bg-slate-50"><tr><Th>{t('ship.description')}</Th><Th>{t('ship.originCountry')}</Th><Th>{t('ship.quantity')}</Th><Th>{t('ship.unitPrice')}</Th><Th>{t('ship.lineTotal')}</Th>{editable && <Th><span className="sr-only">{t('common.actions')}</span></Th>}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {s.goodsItems.map((g) => (typeof mode === 'object' && mode && 'goods' in mode && mode.goods === g.id ? (
                      <tr key={g.id}><td colSpan={6} className="p-3"><GoodsForm fileId={file.id} shipmentId={s.id} goods={g} onDone={done} /></td></tr>
                    ) : (
                      <tr key={g.id}>
                        <Td dir="auto" className="max-w-xs">{g.description}</Td>
                        <Td dir="ltr">{g.countryOfOrigin ?? '—'}</Td>
                        <Td dir="ltr">{g.quantity ? `${formatNumber(g.quantity, locale)} ${g.unitOfMeasure ?? ''}` : '—'}</Td>
                        <Td dir="ltr">{formatMoney(g.unitPrice, g.currencyCode ?? undefined, locale)}</Td>
                        <Td dir="ltr" className="font-medium">{formatMoney(g.lineTotal, g.currencyCode ?? undefined, locale)}</Td>
                        {editable && <Td><Button variant="ghost" onClick={() => setMode({ goods: g.id })}>{t('common.edit')}</Button></Td>}
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </Card>
  );
}

export function ShipmentsTab({ file }: { file: FileDetail }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [adding, setAdding] = useState(false);
  const editable = can(permissions, 'clearance_files.update') && (file.status === 'OPEN' || file.status === 'ON_HOLD');
  const q = useQuery({ queryKey: ['shipments', file.id], queryFn: () => api.get<Shipment[]>(`/clearance-files/${file.id}/shipments`) });

  return (
    <div className="space-y-4">
      {!editable && can(permissions, 'clearance_files.update') && <Alert tone="blue">{t('ship.readOnly')}</Alert>}
      {editable && (
        <div className="flex justify-end">
          {!adding && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden />{t('ship.add')}</Button>}
        </div>
      )}
      {adding && <Card className="p-5"><ShipmentForm fileId={file.id} onDone={() => setAdding(false)} /></Card>}
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && !adding && <Card><EmptyState>{t('files.noShipments')}</EmptyState></Card>}
      {q.data?.map((s) => <ShipmentCard key={s.id} file={file} shipment={s} editable={editable} />)}
    </div>
  );
}
