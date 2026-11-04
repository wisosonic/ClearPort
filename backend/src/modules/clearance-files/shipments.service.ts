import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { checkContainerNumber, normalizeContainerNumber } from '../../common/iso6346';
import { mul } from '../../common/money';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ActivityService } from './activity.service';
import type {
  CreateContainerInput, CreateGoodsInput, CreateShipmentInput, UpdateContainerInput,
  UpdateGoodsInput, UpdateShipmentInput,
} from './files.schemas';
import { FilesService } from './files.service';

const partySelect = { id: true, name: true, partyType: true } as const;
const portSelect = { id: true, code: true, name: true, countryCode: true } as const;

@Injectable()
export class ShipmentsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  // ───────────────────────────── shipments ─────────────────────────────

  async list(fileId: string) {
    await this.files.require(fileId);
    return this.db.client.shipment.findMany({
      where: { clearanceFileId: fileId }, orderBy: { createdAt: 'asc' }, include: this.shipmentInclude,
    });
  }

  async get(id: string) {
    const s = await this.db.client.shipment.findUnique({
      where: { id },
      include: {
        ...this.shipmentInclude,
        containers: { orderBy: { createdAt: 'asc' } },
        goodsItems: { orderBy: { createdAt: 'asc' }, include: { hsCode: { select: { id: true, code: true, jurisdiction: true, description: true } } } },
      },
    });
    if (!s) throw notFound('SHIPMENT_NOT_FOUND', 'Shipment not found');
    return s;
  }

  async create(auth: AuthContext, fileId: string, input: CreateShipmentInput, meta: RequestMeta) {
    const file = await this.files.require(fileId);
    this.files.assertEditable(file);
    await this.assertShipmentRefs(input);
    this.assertDates(input.etd ?? null, input.eta ?? null);

    const shipment = await this.db.client.shipment.create({ data: { ...input, clearanceFileId: fileId } as any });
    await this.activity.log(fileId, auth.userId, 'SHIPMENT_ADDED', `Shipment added${describeShipment(shipment)}`, { shipmentId: shipment.id });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'SHIPMENT_CREATED', entityType: 'Shipment',
      entityId: shipment.id, after: shipment, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(shipment.id);
  }

  async update(auth: AuthContext, id: string, input: UpdateShipmentInput, meta: RequestMeta) {
    const before = await this.get(id);
    this.files.assertEditable(await this.files.require(before.clearanceFileId));
    await this.assertShipmentRefs(input);
    this.assertDates(
      input.etd !== undefined ? input.etd : before.etd,
      input.eta !== undefined ? input.eta : before.eta,
    );
    await this.db.client.shipment.update({ where: { id }, data: input as any });
    const after = await this.get(id);
    const arrived = input.actualArrivalAt && !before.actualArrivalAt;
    await this.activity.log(
      before.clearanceFileId, auth.userId, arrived ? 'SHIPMENT_ARRIVED' : 'SHIPMENT_UPDATED',
      arrived ? `Shipment${describeShipment(after)} arrived` : `Shipment${describeShipment(after)} updated`,
      { shipmentId: id, fields: Object.keys(input) },
    );
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'SHIPMENT_UPDATED', entityType: 'Shipment',
      entityId: id, before: strip(before), after: strip(after), ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  // ───────────────────────────── containers ─────────────────────────────

  async addContainer(auth: AuthContext, shipmentId: string, input: CreateContainerInput, meta: RequestMeta) {
    const shipment = await this.shipmentOf(shipmentId);
    this.files.assertEditable(shipment.file);
    const number = this.validateContainerNumber(input.containerNumber, input.nonStandardNumber);
    this.assertWeights(input.grossWeight ?? null, input.netWeight ?? null);
    await this.assertContainerUnique(shipmentId, number);

    const { nonStandardNumber, ...data } = input;
    const container = await this.db.client.container.create({
      data: { ...data, containerNumber: number, shipmentId } as any,
    });
    await this.activity.log(shipment.clearanceFileId, auth.userId, 'CONTAINER_ADDED', `Container ${number} added`, { containerId: container.id, nonStandardNumber });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CONTAINER_CREATED', entityType: 'Container',
      entityId: container.id, after: { ...container, nonStandardNumber }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return container;
  }

  async updateContainer(auth: AuthContext, id: string, input: UpdateContainerInput, meta: RequestMeta) {
    const before = await this.db.client.container.findUnique({ where: { id } });
    if (!before) throw notFound('CONTAINER_NOT_FOUND', 'Container not found');
    const shipment = await this.shipmentOf(before.shipmentId);
    this.files.assertEditable(shipment.file);

    const data: Record<string, unknown> = { ...input };
    delete data.nonStandardNumber;
    if (input.containerNumber !== undefined) {
      const number = this.validateContainerNumber(input.containerNumber, input.nonStandardNumber ?? false);
      if (number !== before.containerNumber) await this.assertContainerUnique(before.shipmentId, number);
      data.containerNumber = number;
    }
    this.assertWeights(
      input.grossWeight !== undefined ? input.grossWeight : before.grossWeight,
      input.netWeight !== undefined ? input.netWeight : before.netWeight,
    );
    const after = await this.db.client.container.update({ where: { id }, data: data as any });
    await this.activity.log(shipment.clearanceFileId, auth.userId, 'CONTAINER_UPDATED', `Container ${after.containerNumber} updated`, { containerId: id, fields: Object.keys(data) });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CONTAINER_UPDATED', entityType: 'Container',
      entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  /**
   * ISO 6346 is enforced where it applies (spec 11.3). A number that is not in ISO 6346 format at
   * all can be recorded only when the user explicitly confirms it (`nonStandardNumber: true`), but a
   * number that IS in ISO format with a wrong check digit is always rejected: that is a typo.
   */
  private validateContainerNumber(raw: string, allowNonStandard: boolean): string {
    const r = checkContainerNumber(raw);
    if (r.ok) return r.number;
    if (r.reason === 'BAD_CHECK_DIGIT') {
      throw unprocessable('INVALID_CONTAINER_CHECK_DIGIT',
        `Container number ${r.number} has an invalid ISO 6346 check digit (expected ${r.expectedCheckDigit}). Please re-check the number.`,
        [{ path: 'containerNumber', expectedCheckDigit: r.expectedCheckDigit }]);
    }
    if (!allowNonStandard) {
      throw unprocessable('CONTAINER_NUMBER_NOT_ISO6346',
        `"${r.number}" is not an ISO 6346 container number (4 letters ending in U/J/Z, 6 digits, 1 check digit). Set nonStandardNumber to true to record it anyway.`,
        [{ path: 'containerNumber' }]);
    }
    return normalizeContainerNumber(raw);
  }

  private async assertContainerUnique(shipmentId: string, containerNumber: string) {
    if (await this.db.client.container.findFirst({ where: { shipmentId, containerNumber } })) {
      throw conflict('CONTAINER_DUPLICATE', `Container ${containerNumber} is already on this shipment`);
    }
  }

  private assertWeights(gross: string | null, net: string | null) {
    if (gross !== null && net !== null && new Decimal(net).gt(gross)) {
      throw unprocessable('NET_WEIGHT_EXCEEDS_GROSS', 'Net weight cannot exceed gross weight');
    }
  }

  // ───────────────────────────── goods lines ─────────────────────────────

  async addGoods(auth: AuthContext, shipmentId: string, input: CreateGoodsInput, meta: RequestMeta) {
    const shipment = await this.shipmentOf(shipmentId);
    this.files.assertEditable(shipment.file);
    const data = await this.prepareGoods({ ...input } as any);
    const goods = await this.db.client.goodsItem.create({ data: { ...data, shipmentId } as any });
    await this.activity.log(shipment.clearanceFileId, auth.userId, 'GOODS_ADDED', `Goods line added: ${truncate(goods.description)}`, { goodsItemId: goods.id });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'GOODS_ITEM_CREATED', entityType: 'GoodsItem',
      entityId: goods.id, after: goods, ip: meta.ip, userAgent: meta.userAgent,
    });
    return goods;
  }

  async updateGoods(auth: AuthContext, id: string, input: UpdateGoodsInput, meta: RequestMeta) {
    const before = await this.db.client.goodsItem.findUnique({ where: { id } });
    if (!before) throw notFound('GOODS_ITEM_NOT_FOUND', 'Goods line not found');
    const shipment = await this.shipmentOf(before.shipmentId);
    this.files.assertEditable(shipment.file);

    // Validate the MERGED result so partial updates cannot create an inconsistent line.
    const merged = await this.prepareGoods({ ...before, ...input } as any, input);
    const patch: Record<string, unknown> = { ...input };
    // Priced lines always carry the computed total, whatever the client sent.
    if (merged.quantity != null && merged.unitPrice != null) patch.lineTotal = merged.lineTotal;
    const after = await this.db.client.goodsItem.update({ where: { id }, data: patch as any });
    await this.activity.log(shipment.clearanceFileId, auth.userId, 'GOODS_UPDATED', `Goods line updated: ${truncate(after.description)}`, { goodsItemId: id, fields: Object.keys(patch) });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'GOODS_ITEM_UPDATED', entityType: 'GoodsItem',
      entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  /**
   * Validates references and derives lineTotal. When quantity and unitPrice are both known the
   * line total is ALWAYS quantity x unitPrice computed here (a client-supplied total is ignored),
   * so a line can never disagree with its own price.
   */
  private async prepareGoods<T extends Record<string, any>>(g: T, patch?: Record<string, unknown>): Promise<T> {
    if (g.hsCodeId && (!patch || 'hsCodeId' in patch)) {
      if (!(await this.db.client.hsCode.findUnique({ where: { id: g.hsCodeId } }))) {
        throw unprocessable('HS_CODE_NOT_FOUND', 'HS code not found');
      }
    }
    const hasMoney = g.unitPrice != null || g.lineTotal != null;
    if (hasMoney && !g.currencyCode) {
      throw unprocessable('CURRENCY_REQUIRED', 'currencyCode is required when a price or total is given');
    }
    if (g.currencyCode && (!patch || 'currencyCode' in patch)) {
      const cur = await this.db.client.currency.findUnique({ where: { code: g.currencyCode } });
      if (!cur || !cur.isActive) throw unprocessable('CURRENCY_NOT_FOUND', `Unknown or inactive currency ${g.currencyCode}`);
    }
    this.assertWeights(g.grossWeight ?? null, g.netWeight ?? null);
    if (g.quantity != null && g.unitPrice != null) (g as any).lineTotal = mul(g.quantity, g.unitPrice);
    return g;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private readonly shipmentInclude = {
    shippingAgent: { select: partySelect },
    freightForwarder: { select: partySelect },
    originPort: { select: portSelect },
    destinationPort: { select: portSelect },
    _count: { select: { containers: true, goodsItems: true } },
  } as const;

  private async shipmentOf(id: string) {
    const s = await this.db.client.shipment.findUnique({ where: { id }, include: { clearanceFile: true } });
    if (!s) throw notFound('SHIPMENT_NOT_FOUND', 'Shipment not found');
    const { clearanceFile, ...rest } = s;
    return { ...rest, file: clearanceFile };
  }

  private async assertShipmentRefs(input: { shippingAgentId?: string | null; freightForwarderId?: string | null; originPortId?: string | null; destinationPortId?: string | null }) {
    for (const [field, id] of [['shippingAgentId', input.shippingAgentId], ['freightForwarderId', input.freightForwarderId]] as const) {
      if (id && !(await this.db.client.businessParty.findUnique({ where: { id } }))) {
        throw unprocessable('PARTY_NOT_FOUND', 'Business party not found in your office', [{ path: field }]);
      }
    }
    for (const [field, id] of [['originPortId', input.originPortId], ['destinationPortId', input.destinationPortId]] as const) {
      if (id && !(await this.db.client.port.findUnique({ where: { id } }))) {
        throw unprocessable('PORT_NOT_FOUND', 'Port not found', [{ path: field }]);
      }
    }
  }

  private assertDates(etd: Date | null, eta: Date | null) {
    if (etd && eta && eta.getTime() < etd.getTime()) {
      throw unprocessable('ETA_BEFORE_ETD', 'ETA cannot be earlier than ETD');
    }
  }
}

const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);
const describeShipment = (s: { vesselName?: string | null; billOfLadingNumber?: string | null }) =>
  [s.vesselName && ` ${s.vesselName}`, s.billOfLadingNumber && ` (BL ${s.billOfLadingNumber})`].filter(Boolean).join('');
const strip = (s: any) => {
  const { containers, goodsItems, shippingAgent, freightForwarder, originPort, destinationPort, _count, ...rest } = s;
  return rest;
};
