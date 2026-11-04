import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iso6346CheckDigit } from '../src/common/iso6346';
import { PdfService } from '../src/infrastructure/pdf/pdf.service';
import { esc, invoiceHtml, makeMoney, tableHtml } from '../src/modules/reports/templates';
import type { ReportTable } from '../src/modules/reports/report-table';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, type FinanceOffice } from './finance-helpers';

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
const EVIL = 'Evil <script>alert(1)</script> & "Co" <img src=http://127.0.0.1:1/x>';

describe('templates (pure)', () => {
  it('escapes every special character', () => {
    expect(esc(`<a href="x" onclick='y'>&\``)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;');
    expect(esc(null)).toBe('');
    expect(esc(42)).toBe('42');
  });

  it('shows a currency at its natural precision, and all four decimals only when a value needs them', () => {
    const usd = makeMoney(['1000.0000', '250.5000', '1250.5000'], 2);
    expect(usd('1250.5000')).toBe('1,250.50');
    expect(makeMoney(['89500000.0000'], 0)('89500000.0000')).toBe('89,500,000');
    const precise = makeMoney(['12.3456', '0.0125', '12.3581'], 2); // a line really carries 4 decimals
    expect(precise('12.3456')).toBe('12.3456');
    expect(precise('12.3581')).toBe('12.3581');
    expect(makeMoney([], 2)('')).toBe('');
    expect(makeMoney([], 2)('abc<')).toBe('abc&lt;');
  });

  it('renders a table report in Arabic with RTL direction and Arabic headers', () => {
    const t: ReportTable = {
      name: 'x', title: { en: 'Expenses', ar: 'المصاريف' },
      columns: [{ key: 'a', header: { en: 'Name', ar: 'الاسم' }, type: 'text' }, { key: 'b', header: { en: 'Amount', ar: 'المبلغ' }, type: 'money' }],
      rows: [{ a: '<b>x</b>', b: '1234.5' }], totals: { b: '1234.5' }, meta: { basis: 'BASE_CURRENCY' },
    };
    const ar = tableHtml(t, { locale: 'ar', officeName: 'مكتب', subtitle: 'sub' });
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('<th class="">الاسم</th>');
    expect(ar).toContain('1,234.50');
    expect(ar).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(ar).toContain('الإجمالي');
    expect(tableHtml(t, { locale: 'en', officeName: 'Office', subtitle: '' })).toContain('dir="ltr"');
  });

  it('never lets a hostile value become markup in an invoice', () => {
    const html = invoiceHtml({
      office: { name: EVIL }, taxName: 'VAT', client: { name: EVIL, clientCode: '<x>' }, file: { fileNumber: 'IMP-1', containers: [EVIL] },
      invoice: { invoiceNumber: EVIL, invoiceType: 'STANDARD', status: 'ISSUED', issueDate: new Date(), dueDate: new Date(), currencyCode: 'USD', currencyDecimals: 2, subtotal: '1.0000', discount: '0.0000', taxAmount: '0.0000', totalAmount: '1.0000', paidAmount: '0.0000', outstandingAmount: '1.0000', exchangeRate: null, rateConvention: null, baseTotalAmount: null, baseCurrency: 'USD', cancelReason: null },
      items: [{ description: EVIL, quantity: '1.0000', unitPrice: '1.0000', amount: '1.0000', taxRate: '0.0000', taxAmount: '0.0000' }], payments: [],
    }, 'en');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/<img src=http/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('printing API', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let evilClient: string;
  const inv: Record<string, any> = {};
  const pdfReady = () => api.app.get(PdfService).available();

  const fee = (amount: string, extra: Record<string, unknown> = {}) => ({ description: 'Customs clearance service', categoryId: A.cat[CAT.SERVICE], unitPrice: amount, ...extra });
  const mk = async (fileId: string, items: object[], o: { type?: string; currency?: string; issue?: boolean; discount?: string } = {}) => {
    const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: fileId, invoiceType: o.type ?? 'STANDARD', currencyCode: o.currency ?? 'USD', discount: o.discount ?? '0', items }));
    return o.issue === false ? d : ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: '2026-11-05' }));
  };
  const html = async (path: string, token = A.accountant) => { const r = await api.req('get', path, token); expect(r.status, path).toBe(200); return r.text as string; };

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'print-a');
    B = await financeOffice(api, 'print-b');
    evilClient = (await ok(api.req('post', '/clients', A.owner).send({ name: EVIL, taxNumber: 'TX-123', address: 'Hamra St, Beirut' }))).id;

    // a file with a vessel, BL and container
    const s = await ok(api.req('post', `/clearance-files/${A.fileId}/shipments`, A.owner).send({ vesselName: 'MSC Aurora', billOfLadingNumber: 'MEDU-778899' }));
    await ok(api.req('post', `/shipments/${s.id}/containers`, A.owner).send({ containerNumber: `MSKU123456${iso6346CheckDigit('MSKU123456')}` }));
    await ok(api.req('patch', `/clearance-files/${A.fileId}`, A.owner).send({ customsReference: 'DECL-2026-555' }));

    // tax on, so the invoice shows a tax column and a tax line
    await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '11' }));
    const duty = await ok(api.req('post', '/expenses', A.officer).send({ categoryId: A.cat[CAT.DUTIES], clearanceFileId: A.fileId, description: 'Customs duty', amount: '500', currencyCode: 'USD', expenseDate: '2026-11-03' }));
    await ok(api.req('post', `/expenses/${duty.id}/approve`, A.accountant).send({ cashAccountId: A.cash.usd }));
    inv.main = await mk(A.fileId, [fee('1000'), { expenseId: duty.id }], { discount: '100' }); // 900 + 99 tax + 500 = 1499
    await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: false, name: 'VAT', ratePercent: '11' }));
    // pay part of it, then pay and reverse another part
    const p1 = await ok(api.req('post', '/payments', A.accountant).send({ clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', amount: '600', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-06', allocations: [{ invoiceId: inv.main.id, amount: '600' }] }));
    const p2 = await ok(api.req('post', '/payments', A.accountant).send({ clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', amount: '77', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-07', allocations: [{ invoiceId: inv.main.id, amount: '77' }] }));
    await ok(api.req('post', `/payments/${p2.id}/allocations/${p2.allocations[0].id}/reverse`, A.accountant).send({ reason: 'wrong invoice' }));
    inv.p1 = p1;

    const f2 = await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: evilClient }));
    inv.lbp = await mk(f2.id, [fee('89500000')], { currency: 'LBP' });
    inv.advance = await mk(f2.id, [{ description: 'Advance on account', unitPrice: '500' }], { type: 'ADVANCE' });
    inv.draft = await mk(f2.id, [fee('50')], { issue: false });
    const toCancel = await mk(f2.id, [fee('10')]);
    inv.cancelled = await ok(api.req('post', `/invoices/${toCancel.id}/cancel`, A.accountant).send({ reason: 'Wrong client <b>x</b>' }));
    inv.f2 = f2.id;
  });
  afterAll(async () => api.close());

  describe('invoice', () => {
    it('prints an English invoice with office, client, file details, lines, tax, totals, payments and balance', async () => {
      const h = await html(`/invoices/${inv.main.id}/pdf?format=html`);
      expect(h).toContain('<html lang="en" dir="ltr">');
      expect(h).toContain(`Office print-a`);
      expect(h).toContain(inv.main.invoiceNumber);
      expect(h).toContain('Client of print-a');
      for (const t of ['IMP-2026-00001', 'DECL-2026-555', 'MSC Aurora', 'MEDU-778899', 'MSKU1234565', 'Customs clearance service', 'Customs duty']) expect(h, t).toContain(t);
      expect(h).toContain('<th class="n">VAT</th>'); // a tax column exists because a line is taxed
      expect(h).toContain('11%');
      // 1000 - 100 discount + 99 VAT + 500 duty = 1,499; 600 paid (the reversed 77 is NOT shown); 899 due
      for (const v of ['1,500.00', '-100.00', '99.00', '1,499.00', '600.00', '899.00']) expect(h, v).toContain(v);
      expect(h).not.toContain('77.00');
      expect(h).toContain('Balance due');
      expect(h).toContain('Payments applied');
      expect(h).toContain('05 Nov 2026');
      expect(h).not.toContain('class="stamp"');
    });

    it('prints the same invoice in Arabic, right-to-left, with Arabic labels and Western digits', async () => {
      const h = await html(`/invoices/${inv.main.id}/pdf?format=html&locale=ar`);
      expect(h).toContain('<html lang="ar" dir="rtl">');
      for (const t of ['فاتورة', 'رقم الفاتورة', 'تاريخ الاستحقاق', 'فاتورة إلى', 'المجموع الفرعي', 'المبلغ المستحق', 'الدفعات المطبّقة', 'الحسم']) expect(h, t).toContain(t);
      expect(h).toContain('1,499.00'); // amounts read the same in both languages
      expect(h).toContain('direction: rtl');
      expect(h).toContain('تشرين الثاني'); // the month in Lebanese (Levantine) Arabic, not the Gulf/Egyptian name
    });

    it('stamps drafts and cancelled invoices, and leaves issued ones clean', async () => {
      expect(await html(`/invoices/${inv.draft.id}/pdf?format=html`)).toContain('class="stamp">DRAFT<');
      expect(await html(`/invoices/${inv.draft.id}/pdf?format=html&locale=ar`)).toContain('class="stamp">مسودة<');
      const c = await html(`/invoices/${inv.cancelled.id}/pdf?format=html`);
      expect(c).toContain('class="stamp">CANCELLED<');
      expect(c).toContain('Cancelled: Wrong client &lt;b&gt;x&lt;/b&gt;'); // the reason is shown, escaped
      expect(await html(`/invoices/${inv.draft.id}/pdf?format=html`)).not.toContain('Balance due'); // not issued: nothing to pay yet
    });

    it('labels an advance request as such: no due date, and not a tax invoice', async () => {
      const h = await html(`/invoices/${inv.advance.id}/pdf?format=html`);
      expect(h).toContain('Advance request');
      expect(h).toContain('This is a request for funds on account. It is not a tax invoice.');
      expect(h).not.toContain('Due date');
      expect(h).not.toContain('Balance due');
      expect(await html(`/invoices/${inv.advance.id}/pdf?format=html&locale=ar`)).toContain('طلب دفعة مقدّمة');
    });

    it('shows foreign-currency amounts at the currency\'s precision plus the rate used and its base value', async () => {
      const h = await html(`/invoices/${inv.lbp.id}/pdf?format=html`);
      expect(h).toContain('89,500,000'); // LBP has no decimals
      expect(h).not.toContain('89,500,000.00');
      expect(h).toContain('1 USD = 89500 LBP'); // stated in the direction it was recorded
      expect(h).toContain('Base-currency value: 1000.0000 USD');
      expect(h).toContain('Amount (LBP)');
    });

    it('escapes hostile client and invoice text', async () => {
      const h = await html(`/invoices/${inv.lbp.id}/pdf?format=html`);
      expect(h).not.toContain('<script>alert');
      expect(h).not.toMatch(/<img src=http:\/\/127/);
      expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(h).toContain('TX-123');
      expect(h).toContain('Hamra St, Beirut');
    });

    it('sends safe headers: the HTML preview cannot run scripts or load anything', async () => {
      const r = await api.req('get', `/invoices/${inv.main.id}/pdf?format=html`, A.accountant);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.headers['content-disposition']).toMatch(/^inline; filename="INV-2026-\d{5}-en\.html"$/);
      const dl = await api.req('get', `/invoices/${inv.main.id}/pdf?format=html&disposition=attachment`, A.accountant);
      expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('requires invoices.view, validates input, audits, and never crosses offices', async () => {
      expect((await api.req('get', `/invoices/${inv.main.id}/pdf?format=html`, A.viewer)).status).toBe(200);
      expect((await api.req('get', `/invoices/${inv.main.id}/pdf?format=html`)).status).toBe(401);
      expect((await api.req('get', `/invoices/${inv.main.id}/pdf?format=html&locale=fr`, A.accountant)).status).toBe(400);
      expect((await api.req('get', `/invoices/${inv.main.id}/pdf?format=docx`, A.accountant)).status).toBe(400);
      expect((await api.req('get', `/invoices/not-a-uuid/pdf`, A.accountant)).status).toBe(400);
      expect((await api.req('get', `/invoices/${inv.main.id}/pdf?format=html`, B.accountant)).status).toBe(404);
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'INVOICE_PRINTED' } });
      expect(logs.length).toBeGreaterThan(5);
    });
  });

  describe('client statement', () => {
    it('prints per-currency statements with opening and closing balances and a sign explanation', async () => {
      const h = await html(`/clients/${A.clientId}/statement/pdf?format=html`);
      expect(h).toContain('Statement of account');
      expect(h).toContain('Currency: USD');
      expect(h).toContain(inv.main.invoiceNumber);
      expect(h).toContain(inv.p1.paymentNumber);
      expect(h).toContain('Closing balance');
      expect(h).toContain('(not converted)');
      expect(h).toContain('899.00'); // 1,499 invoiced - 600 paid
      const ar = await html(`/clients/${A.clientId}/statement/pdf?format=html&locale=ar&currency=USD`);
      expect(ar).toContain('كشف حساب');
      expect(ar).toContain('الرصيد الختامي');
      expect(ar).toContain('dir="rtl"');
    });

    it('applies the date range and shows the opening balance', async () => {
      const h = await html(`/clients/${A.clientId}/statement/pdf?format=html&from=2026-11-06&to=2026-11-30`);
      expect(h).toContain('Opening balance');
      expect(h).toContain('1,499.00'); // the opening balance: the invoice from 5 Nov
      expect(h).not.toContain(inv.main.invoiceNumber); // the invoice itself is before the window
    });

    it('needs the same permissions as the statement data, and escapes the client name', async () => {
      expect((await api.req('get', `/clients/${evilClient}/statement/pdf?format=html`, A.officer)).status).toBe(200);
      const h = await html(`/clients/${evilClient}/statement/pdf?format=html`);
      expect(h).not.toContain('<script>alert');
      expect((await api.req('get', `/clients/${A.clientId}/statement/pdf?format=html`, B.accountant)).status).toBe(404);
      expect((await api.req('get', `/clients/${A.clientId}/statement/pdf?from=yesterday`, A.accountant)).status).toBe(400);
      expect((await api.req('get', `/clients/${A.clientId}/statement/pdf?format=html`)).status).toBe(401);
    });
  });

  describe('real PDF output (needs Chrome, Edge or Chromium)', () => {
    it('produces valid PDFs for invoices in both languages', async () => {
      if (!pdfReady()) return;
      for (const locale of ['en', 'ar'] as const) {
        const r = await api.req('get', `/invoices/${inv.main.id}/pdf?locale=${locale}`, A.accountant).buffer(true).parse(binary);
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/pdf');
        const body = r.body as Buffer;
        expect(body.subarray(0, 5).toString()).toBe('%PDF-');
        expect(body.length).toBeGreaterThan(5000);
        expect(body.subarray(-1024).toString('latin1')).toContain('%%EOF');
        expect(r.headers['content-disposition']).toMatch(/^inline; filename="INV-2026-\d{5}-/);
      }
    }, 120_000);

    it('produces statement and report PDFs, multi-page when the data needs it', async () => {
      if (!pdfReady()) return;
      const st = await api.req('get', `/clients/${A.clientId}/statement/pdf?locale=ar`, A.accountant).buffer(true).parse(binary);
      expect((st.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const rep = await api.req('get', '/reports/export?report=trial-balance&format=pdf', A.accountant).buffer(true).parse(binary);
      expect(rep.status).toBe(200);
      expect(rep.headers['content-type']).toBe('application/pdf');
      expect(rep.headers['content-disposition']).toMatch(/^attachment; filename="trial-balance-\d{8}\.pdf"$/);
      expect((rep.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      // a long table runs to several pages with the header repeated
      const pdf = api.app.get(PdfService);
      const many = tableHtml({
        name: 'big', title: { en: 'Big', ar: 'كبير' }, meta: {},
        columns: [{ key: 'n', header: { en: 'N', ar: 'ن' }, type: 'int' }, { key: 't', header: { en: 'Text', ar: 'نص' }, type: 'text' }],
        rows: Array.from({ length: 400 }, (_, i) => ({ n: i, t: `row ${i}` })),
      }, { locale: 'en', officeName: 'Office', subtitle: '' });
      const big = await pdf.render(many, { footerLabel: 'Office' });
      const pages = (big.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      expect(pages).toBeGreaterThan(4);
    }, 120_000);

    it('renders several documents at once without errors', async () => {
      if (!pdfReady()) return;
      const results = await Promise.all(Array.from({ length: 6 }, () => api.req('get', `/invoices/${inv.main.id}/pdf`, A.accountant).buffer(true).parse(binary)));
      expect(results.every((r) => r.status === 200 && (r.body as Buffer).subarray(0, 5).toString() === '%PDF-')).toBe(true);
    }, 120_000);

    it('cannot be made to fetch anything or run scripts, even from a hostile template', async () => {
      if (!pdfReady()) return;
      const hits: string[] = [];
      const server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(); });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const hostile = `<!doctype html><html><head><link rel="stylesheet" href="${base}/style.css"><script src="${base}/s.js"></script></head>
          <body><img src="${base}/img.png"><iframe src="${base}/frame"></iframe><script>fetch('${base}/js-fetch');new Image().src='${base}/js-img'</script>
          <div style="background:url(${base}/bg.png)">x</div></body></html>`;
        const out = await api.app.get(PdfService).render(hostile);
        expect(out.subarray(0, 5).toString()).toBe('%PDF-');
        await new Promise((r) => setTimeout(r, 400));
        expect(hits).toEqual([]); // nothing was requested: network blocked and scripts disabled
      } finally {
        server.close();
      }
    }, 120_000);
  });

  describe('when no browser is installed', () => {
    it('answers 503 for PDFs but still serves the HTML preview', async () => {
      const noChrome = await startApi({ CHROME_PATH: '/definitely/not/here' });
      try {
        // the app also auto-detects standard locations, so only assert the 503 contract when none is found
        const svc = noChrome.app.get(PdfService);
        const o = await financeOffice(noChrome, 'nochrome');
        const d = await ok(noChrome.req('post', '/invoices', o.accountant).send({ clearanceFileId: o.fileId, items: [{ description: 'x', categoryId: o.cat[CAT.SERVICE], unitPrice: '5' }] }));
        expect((await noChrome.req('get', `/invoices/${d.id}/pdf?format=html`, o.accountant)).status).toBe(200);
        if (!svc.available()) {
          const r = await noChrome.req('get', `/invoices/${d.id}/pdf`, o.accountant);
          expect(r.status).toBe(503);
          expect(r.body.error.code).toBe('PDF_UNAVAILABLE');
        }
      } finally {
        await noChrome.close();
      }
    }, 120_000);
  });
});
