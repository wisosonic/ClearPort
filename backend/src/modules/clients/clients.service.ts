import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { add, money, sub, sum, type DecimalString } from '../../common/money';
import { conflict, notFound } from '../../common/errors';
import { allocateSequenceValue } from '../../common/numbering';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { requireTenant } from '../../database/tenant-context';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import {
  clientFilesQuerySchema, clientListQuerySchema, contactInputSchema, statementQuerySchema,
  updateContactSchema, type CreateClientInput, type UpdateClientInput,
} from './clients.schemas';

type ContactInput = z.infer<typeof contactInputSchema>;

const CLIENT_SORT = ['name', 'clientCode', 'createdAt'] as const;
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class ClientsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── clients ─────────────────────────────

  async list(q: z.infer<typeof clientListQuerySchema>) {
    const where: any = {};
    if (q.search) {
      const ids = await searchIds(this.db.client, {
        table: 'clients', tenantId: requireTenant().tenantId, term: q.search,
        columns: ['name', 'legalName', 'clientCode', 'taxNumber', 'phone', 'email'],
      });
      where.id = { in: ids };
    }
    if (q.isActive !== undefined) where.isActive = q.isActive === 'true';
    if (q.clientType) where.clientType = q.clientType;
    if (q.countryCode) where.countryCode = q.countryCode;

    const [rows, total] = await Promise.all([
      this.db.client.client.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, CLIENT_SORT, { name: 'asc' }),
      }),
      this.db.client.client.count({ where }),
    ]);
    return paginated(rows, q, total);
  }

  async get(id: string) {
    const client = await this.db.client.client.findUnique({
      where: { id },
      include: { contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] } },
    });
    if (!client) throw notFound('CLIENT_NOT_FOUND', 'Client not found');
    return client;
  }

  async create(auth: AuthContext, input: CreateClientInput, meta: RequestMeta) {
    const { contacts, clientCode, ...data } = input;
    const created = await this.db.client.$transaction(async (tx) => {
      const code = clientCode ?? (await this.generateCode(tx, auth.tenantId));
      if (await tx.client.findFirst({ where: { clientCode: code } })) {
        throw conflict('CLIENT_CODE_TAKEN', `Client code ${code} is already used in your office`);
      }
      const client = await tx.client.create({ data: { ...data, clientCode: code } as any });
      if (contacts?.length) {
        const rows = this.normalisePrimary(contacts);
        await tx.clientContact.createMany({ data: rows.map((c) => ({ ...c, clientId: client.id })) as any });
      }
      return client;
    });
    const result = await this.get(created.id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLIENT_CREATED', entityType: 'Client',
      entityId: created.id, after: result, ip: meta.ip, userAgent: meta.userAgent,
    });
    return result;
  }

  async update(auth: AuthContext, id: string, input: UpdateClientInput, meta: RequestMeta) {
    const before = await this.get(id);
    await this.db.client.client.update({ where: { id }, data: input as any });
    const after = await this.get(id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId,
      action: input.isActive === false && before.isActive ? 'CLIENT_DEACTIVATED' : 'CLIENT_UPDATED',
      entityType: 'Client', entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  /** Auto codes: CLT-00001, CLT-00002 ... skipping any code a user already typed by hand. */
  private async generateCode(tx: any, tenantId: string): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const n = await allocateSequenceValue(tx, tenantId, 'CLT', 0);
      const code = `CLT-${String(n).padStart(5, '0')}`;
      if (!(await tx.client.findFirst({ where: { clientCode: code } }))) return code;
    }
    throw conflict('CLIENT_CODE_GENERATION_FAILED', 'Could not generate a free client code');
  }

  // ───────────────────────────── contacts ─────────────────────────────

  async addContact(auth: AuthContext, clientId: string, input: ContactInput, meta: RequestMeta) {
    await this.get(clientId);
    const contact = await this.db.client.$transaction(async (tx) => {
      const existing = await tx.clientContact.count({ where: { clientId } });
      const makePrimary = input.isPrimary === true || existing === 0;
      if (makePrimary) await tx.clientContact.updateMany({ where: { clientId }, data: { isPrimary: false } });
      return tx.clientContact.create({ data: { ...input, clientId, isPrimary: makePrimary } as any });
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLIENT_CONTACT_ADDED', entityType: 'Client',
      entityId: clientId, after: contact, ip: meta.ip, userAgent: meta.userAgent,
    });
    return contact;
  }

  async updateContact(
    auth: AuthContext, clientId: string, contactId: string,
    input: z.infer<typeof updateContactSchema>, meta: RequestMeta,
  ) {
    const before = await this.findContact(clientId, contactId);
    const updated = await this.db.client.$transaction(async (tx) => {
      if (input.isPrimary === true) {
        await tx.clientContact.updateMany({ where: { clientId, id: { not: contactId } }, data: { isPrimary: false } });
      }
      return tx.clientContact.update({ where: { id: contactId }, data: input as any });
    });
    // A client with contacts always keeps one primary.
    if (input.isPrimary === false) await this.ensurePrimary(clientId);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLIENT_CONTACT_UPDATED', entityType: 'Client',
      entityId: clientId, before, after: updated, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.findContact(clientId, contactId);
  }

  async removeContact(auth: AuthContext, clientId: string, contactId: string, meta: RequestMeta) {
    const before = await this.findContact(clientId, contactId);
    await this.db.client.clientContact.delete({ where: { id: contactId } });
    if (before.isPrimary) await this.ensurePrimary(clientId);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'CLIENT_CONTACT_REMOVED', entityType: 'Client',
      entityId: clientId, before, ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  private async findContact(clientId: string, contactId: string) {
    const c = await this.db.client.clientContact.findFirst({ where: { id: contactId, clientId } });
    if (!c) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
    return c;
  }

  private async ensurePrimary(clientId: string) {
    const contacts = await this.db.client.clientContact.findMany({ where: { clientId }, orderBy: { createdAt: 'asc' } });
    if (contacts.length > 0 && !contacts.some((c) => c.isPrimary)) {
      await this.db.client.clientContact.update({ where: { id: contacts[0].id }, data: { isPrimary: true } });
    }
  }

  /** Exactly one primary when contacts are supplied: the last one flagged wins, else the first. */
  private normalisePrimary(contacts: ContactInput[]) {
    const flagged = contacts.map((c, i) => (c.isPrimary ? i : -1)).filter((i) => i >= 0);
    const primary = flagged.length > 0 ? flagged[flagged.length - 1] : 0;
    return contacts.map((c, i) => ({ ...c, isPrimary: i === primary }));
  }

  // ───────────────────────────── client files ─────────────────────────────

  async files(clientId: string, q: z.infer<typeof clientFilesQuerySchema>) {
    await this.get(clientId);
    const where: any = { clientId };
    if (q.status) where.status = q.status;
    if (q.fileType) where.fileType = q.fileType;
    if (q.search) {
      const ids = await searchIds(this.db.client, {
        table: 'clearance_files', tenantId: requireTenant().tenantId, term: q.search,
        columns: ['fileNumber', 'customsReference'], extraWhere: '"clientId" = ?', extraParams: [clientId],
      });
      where.id = { in: ids };
    }
    const [rows, total] = await Promise.all([
      this.db.client.clearanceFile.findMany({
        where, ...pageArgs(q), orderBy: { createdAt: 'desc' },
        select: {
          id: true, fileNumber: true, fileType: true, status: true, priority: true, openedAt: true,
          expectedArrivalAt: true, closedAt: true, customsReference: true,
          currentStage: { select: { code: true, nameEn: true, nameAr: true } },
        },
      }),
      this.db.client.clearanceFile.count({ where }),
    ]);
    return paginated(rows, q, total);
  }

  // ───────────────────── balance and statement (read-only) ─────────────────────
  //
  // Definition v1 (to be confirmed with an accountant before Phase 5 builds the posting rules):
  //   amounts are in TRANSACTION currencies — never silently converted to base currency
  //   invoiced      = ISSUED invoices, advance REQUESTS excluded (they are not receivables)
  //   received      = POSTED client payments and advances
  //   refunded      = POSTED refunds / reimbursements paid back to the client
  //   allocated     = live (not reversed) allocations, in the INVOICE currency
  //   outstanding   = invoiced − allocated            (what the client still owes on invoices)
  //   unappliedCredit = received − refunded − applied (advances held, not yet applied; a LIABILITY).
  //                     'applied' is measured in the PAYMENT currency, so it differs from 'allocated'
  //                     only when a payment settles an invoice in another currency.
  //   netBalance    = outstanding − unappliedCredit   (positive: client owes us; negative: we owe client)

  async balance(clientId: string) {
    await this.get(clientId);
    const { invoices, payments, allocations } = await this.loadFinancials(clientId);

    const currencies = new Set<string>([
      ...invoices.map((i) => i.currencyCode), ...payments.map((p) => p.currencyCode),
    ]);
    const rows = [...currencies].sort().map((currency) => {
      const invoiced = sum(invoices.filter((i) => i.currencyCode === currency).map((i) => i.totalAmount));
      const received = sum(
        payments.filter((p) => p.currencyCode === currency && this.isReceipt(p.paymentType)).map((p) => p.amount),
      );
      const refunded = sum(
        payments.filter((p) => p.currencyCode === currency && !this.isReceipt(p.paymentType)).map((p) => p.amount),
      );
      const allocated = sum(allocations.filter((a) => a.currencyCode === currency).map((a) => a.allocatedAmount));
      const outstanding = sub(invoiced, allocated);
      const applied = sum(allocations.filter((a) => a.payment.currencyCode === currency).map((a) => a.paymentAmount));
      const unappliedCredit = sub(sub(received, refunded), applied);
      return {
        currency, invoiced, received, refunded, allocated, outstanding, unappliedCredit,
        netBalance: sub(outstanding, unappliedCredit),
      };
    });
    const client = await this.db.client.client.findUniqueOrThrow({
      where: { id: clientId }, select: { creditLimit: true, paymentTermsDays: true },
    });
    return { clientId, basis: 'TRANSACTION_CURRENCY' as const, creditLimit: client.creditLimit, balances: rows };
  }

  async statement(clientId: string, q: z.infer<typeof statementQuerySchema>) {
    const client = await this.get(clientId);
    const { invoices, payments, allocations } = await this.loadFinancials(clientId);

    interface Entry {
      date: Date; type: 'INVOICE' | 'PAYMENT' | 'REFUND' | 'ALLOCATION'; reference: string; description: string;
      currency: string; debit: DecimalString; credit: DecimalString; sortKey: string;
    }
    const entries: Entry[] = [
      ...invoices.map((i): Entry => ({
        date: i.issueDate ?? i.issuedAt ?? i.createdAt, type: 'INVOICE', reference: i.invoiceNumber,
        description: `Invoice ${i.invoiceNumber}`, currency: i.currencyCode,
        debit: i.totalAmount, credit: money('0'), sortKey: `${i.invoiceNumber}`,
      })),
      // A payment applied to an invoice in the SAME currency nets to zero there. Across currencies it moves value
      // between the two currency ledgers: credit used up in the payment currency, invoice settled in its own.
      ...allocations.filter((a) => a.payment.currencyCode !== a.currencyCode).flatMap((a): Entry[] => [
        {
          date: a.createdAt, type: 'ALLOCATION', reference: a.payment.paymentNumber, currency: a.payment.currencyCode,
          description: `${a.payment.paymentNumber} applied to invoice ${a.invoice.invoiceNumber}`, debit: a.paymentAmount, credit: money('0'), sortKey: `${a.payment.paymentNumber}-a`,
        },
        {
          date: a.createdAt, type: 'ALLOCATION', reference: a.invoice.invoiceNumber, currency: a.currencyCode,
          description: `${a.payment.paymentNumber} applied to invoice ${a.invoice.invoiceNumber}`, debit: money('0'), credit: a.allocatedAmount, sortKey: `${a.payment.paymentNumber}-b`,
        },
      ]),
      ...payments.map((p): Entry => {
        const receipt = this.isReceipt(p.paymentType);
        return {
          date: p.paymentDate, type: receipt ? 'PAYMENT' : 'REFUND', reference: p.paymentNumber,
          description: `${p.paymentType.replace(/_/g, ' ').toLowerCase()} ${p.paymentNumber}`, currency: p.currencyCode,
          debit: receipt ? money('0') : p.amount, credit: receipt ? p.amount : money('0'), sortKey: p.paymentNumber,
        };
      }),
    ].filter((e) => !q.currency || e.currency === q.currency)
      .sort((a, b) => a.date.getTime() - b.date.getTime() || a.sortKey.localeCompare(b.sortKey));

    const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined;
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined;
    const running = new Map<string, DecimalString>();
    const opening = new Map<string, DecimalString>();
    const lines: Record<string, unknown>[] = [];

    for (const e of entries) {
      const prev = running.get(e.currency) ?? money('0');
      const bal = sub(add(prev, e.debit), e.credit);
      running.set(e.currency, bal);
      if (from && e.date < from) { opening.set(e.currency, bal); continue; }
      if (to && e.date > to) continue;
      lines.push({
        date: dateOnly(e.date), type: e.type, reference: e.reference, description: e.description,
        currency: e.currency, debit: e.debit, credit: e.credit, balance: bal,
      });
    }
    const closing = new Map<string, DecimalString>();
    for (const l of lines) closing.set(l.currency as string, l.balance as DecimalString);
    for (const [cur, bal] of opening) if (!closing.has(cur)) closing.set(cur, bal);

    return {
      client: { id: client.id, clientCode: client.clientCode, name: client.name },
      basis: 'TRANSACTION_CURRENCY' as const, from: q.from ?? null, to: q.to ?? null,
      openingBalances: Object.fromEntries(opening),
      closingBalances: Object.fromEntries([...closing].sort()),
      lines,
    };
  }

  private isReceipt(type: string) {
    return type === 'CLIENT_PAYMENT' || type === 'CLIENT_ADVANCE';
  }

  private async loadFinancials(clientId: string) {
    const [invoices, payments, allocations] = await Promise.all([
      this.db.client.invoice.findMany({ where: { clientId, status: 'ISSUED', invoiceType: { not: 'ADVANCE' } } }),
      this.db.client.payment.findMany({
        where: { clientId, status: 'POSTED', paymentType: { in: ['CLIENT_PAYMENT', 'CLIENT_ADVANCE', 'REFUND', 'REIMBURSEMENT'] } },
      }),
      this.db.client.paymentAllocation.findMany({
        where: { reversedAt: null, invoice: { clientId, status: 'ISSUED', invoiceType: { not: 'ADVANCE' } }, payment: { status: 'POSTED' } },
        include: { payment: { select: { currencyCode: true, paymentNumber: true } }, invoice: { select: { invoiceNumber: true } } },
      }),
    ]);
    return { invoices, payments, allocations };
  }
}
