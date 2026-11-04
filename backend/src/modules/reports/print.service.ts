import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { PdfService } from '../../infrastructure/pdf/pdf.service';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { ClientsService } from '../clients/clients.service';
import { FinanceSetupService } from '../finance/finance-setup.service';
import { InvoicesService } from '../finance/invoices.service';
import { RatesService } from '../finance/rates.service';
import { ExportService } from './export.service';
import type { ReportTable } from './report-table';
import { invoiceHtml, statementHtml, tableHtml, type InvoicePrint, type Locale } from './templates';

export interface Printed {
  body: Buffer;
  contentType: string;
  filename: string;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

/** Printable documents (spec 16.2 / 7): invoices, client statements and report tables, in English or Arabic (RTL). */
@Injectable()
export class PrintService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PdfService) private readonly pdf: PdfService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(FinanceSetupService) private readonly setup: FinanceSetupService,
    @Inject(RatesService) private readonly rates: RatesService,
    @Inject(ExportService) private readonly exporter: ExportService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async finish(html: string, format: 'pdf' | 'html', filenameBase: string, opts: { rtl: boolean; footerLabel: string; landscape?: boolean }): Promise<Printed> {
    if (format === 'html') return { body: Buffer.from(html, 'utf8'), contentType: 'text/html; charset=utf-8', filename: `${filenameBase}.html` };
    return { body: await this.pdf.render(html, opts), contentType: 'application/pdf', filename: `${filenameBase}.pdf` };
  }

  private async office(tenantId: string) {
    return this.prisma.client.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, legalName: true, email: true, phone: true, address: true } });
  }

  private async decimals(code: string) {
    return (await this.db.client.currency.findUnique({ where: { code } }))?.decimalPlaces ?? 2;
  }

  async invoice(auth: AuthContext, invoiceId: string, locale: Locale, format: 'pdf' | 'html', meta: RequestMeta): Promise<Printed> {
    const inv = await this.invoices.get(invoiceId);
    const [office, client, file, tax, baseCurrency, decimals] = await Promise.all([
      this.office(auth.tenantId),
      this.db.client.client.findUniqueOrThrow({ where: { id: inv.clientId } }),
      this.db.client.clearanceFile.findUniqueOrThrow({
        where: { id: inv.clearanceFileId },
        select: { fileNumber: true, customsReference: true, shipments: { orderBy: { createdAt: 'asc' }, select: { vesselName: true, billOfLadingNumber: true, containers: { select: { containerNumber: true } } } } },
      }),
      this.setup.getTax(),
      this.rates.baseCurrency(auth.tenantId),
      this.decimals(inv.currencyCode),
    ]);
    const live = ((inv as any).allocations ?? []).filter((a: any) => !a.reversedAt && a.payment.status === 'POSTED');
    const data: InvoicePrint = {
      office, taxName: tax.name,
      invoice: {
        invoiceNumber: inv.invoiceNumber, invoiceType: inv.invoiceType, status: inv.status, issueDate: inv.issueDate, dueDate: inv.dueDate, currencyCode: inv.currencyCode, currencyDecimals: decimals,
        subtotal: inv.subtotal, discount: inv.discount, taxAmount: inv.taxAmount, totalAmount: inv.totalAmount, paidAmount: inv.paidAmount, outstandingAmount: inv.outstandingAmount,
        exchangeRate: inv.exchangeRate, rateConvention: inv.rateConvention, baseTotalAmount: inv.baseTotalAmount, baseCurrency, cancelReason: inv.cancelReason,
      },
      client, file: {
        fileNumber: file.fileNumber, customsReference: file.customsReference, vessel: file.shipments.map((s) => s.vesselName).filter(Boolean).join(', ') || null,
        billOfLading: file.shipments.map((s) => s.billOfLadingNumber).filter(Boolean).join(', ') || null, containers: file.shipments.flatMap((s) => s.containers.map((c) => c.containerNumber)),
      },
      items: ((inv as any).items ?? []).map((i: any) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, amount: i.amount, taxRate: i.taxRate, taxAmount: i.taxAmount })),
      payments: live.map((a: any) => ({ paymentNumber: a.payment.paymentNumber, date: a.payment.paymentDate, amount: a.allocatedAmount })),
    };
    await this.audit.record({ tenantId: auth.tenantId, actorUserId: auth.userId, action: 'INVOICE_PRINTED', entityType: 'Invoice', entityId: invoiceId, after: { locale, format }, ip: meta.ip, userAgent: meta.userAgent });
    return this.finish(invoiceHtml(data, locale), format, safeName(`${inv.invoiceNumber}-${locale}`), { rtl: locale === 'ar', footerLabel: office.name });
  }

  async statement(auth: AuthContext, clientId: string, q: { from?: string; to?: string; currency?: string }, locale: Locale, format: 'pdf' | 'html', meta: RequestMeta): Promise<Printed> {
    const st = await this.clients.statement(clientId, q);
    if (!st) throw notFound('CLIENT_NOT_FOUND', 'Client not found');
    const client = await this.db.client.client.findUniqueOrThrow({ where: { id: clientId } });
    const office = await this.office(auth.tenantId);
    const currencies = [...new Set([...Object.keys(st.closingBalances), ...(st.lines as any[]).map((l) => l.currency)])];
    const decimals = Object.fromEntries(await Promise.all(currencies.map(async (c) => [c, await this.decimals(c)] as const)));
    await this.audit.record({ tenantId: auth.tenantId, actorUserId: auth.userId, action: 'STATEMENT_PRINTED', entityType: 'Client', entityId: clientId, after: { locale, format, from: q.from ?? null, to: q.to ?? null }, ip: meta.ip, userAgent: meta.userAgent });
    return this.finish(
      statementHtml({ office: { name: office.name }, client, from: st.from, to: st.to, openingBalances: st.openingBalances as any, closingBalances: st.closingBalances as any, lines: st.lines as any, decimals }, locale),
      format, safeName(`statement-${client.clientCode}-${locale}`), { rtl: locale === 'ar', footerLabel: office.name },
    );
  }

  async table(auth: AuthContext, table: ReportTable, locale: Locale, format: 'pdf' | 'html'): Promise<Printed> {
    const office = await this.office(auth.tenantId);
    const html = tableHtml(table, { locale, officeName: office.name, subtitle: this.exporter.subtitle(table, locale) });
    return this.finish(html, format, this.exporter.fileName(table, 'x').replace(/\.x$/, ''), { rtl: locale === 'ar', footerLabel: `${office.name} — ${table.title[locale]}`, landscape: table.columns.length > 7 });
  }
}
