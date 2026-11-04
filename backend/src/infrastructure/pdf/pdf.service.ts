import { existsSync } from 'node:fs';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import puppeteer, { type Browser } from 'puppeteer-core';
import { DomainError } from '../../common/errors';
import { ENV, type Env } from '../../config/env';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** At most this many pages render at once; extra requests wait their turn. */
const MAX_CONCURRENT_PAGES = 2;
const RENDER_TIMEOUT_MS = 30_000;

export interface PdfOptions {
  landscape?: boolean;
  /** text shown in the page footer, next to the page number */
  footerLabel?: string;
  rtl?: boolean;
}

/**
 * PDF generation with headless Chrome (spec 7: Puppeteer). The browser is started once and reused.
 *
 * Templates are rendered with JavaScript DISABLED and every network request BLOCKED (only data: URLs
 * are allowed), so even if untrusted text slipped into a template it could not run code or reach
 * another host. Chrome comes from CHROME_PATH or a standard install location (no bundled download).
 */
@Injectable()
export class PdfService implements OnModuleDestroy {
  private readonly log = new Logger(PdfService.name);
  private browser?: Promise<Browser>;
  private active = 0;
  private waiting: (() => void)[] = [];
  private readonly executable: string | undefined;
  private readonly noSandbox: boolean;

  constructor(@Inject(ENV) env: Env) {
    this.executable = [env.CHROME_PATH, ...CANDIDATES].find((p) => !!p && existsSync(p));
    this.noSandbox = env.PDF_NO_SANDBOX;
  }

  /** False when no Chrome / Edge / Chromium is installed (PDF endpoints then answer 503). */
  available(): boolean {
    return !!this.executable;
  }

  private launch(): Promise<Browser> {
    if (!this.executable) {
      throw new DomainError('PDF_UNAVAILABLE', 'PDF generation needs Chrome, Edge or Chromium; set CHROME_PATH', 503);
    }
    if (!this.browser) {
      this.browser = puppeteer.launch({
        executablePath: this.executable, headless: true,
        args: ['--disable-gpu', '--font-render-hinting=none', '--disable-dev-shm-usage', ...(this.noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
      }).then((b) => {
        b.on('disconnected', () => { this.browser = undefined; }); // restart on the next request
        return b;
      }).catch((e) => { this.browser = undefined; throw e; });
    }
    return this.browser;
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_PAGES) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  async render(html: string, opts: PdfOptions = {}): Promise<Buffer> {
    if (!this.available()) throw new DomainError('PDF_UNAVAILABLE', 'PDF generation needs Chrome, Edge or Chromium; set CHROME_PATH', 503);
    return this.slot(async () => {
      const browser = await this.launch();
      const page = await browser.newPage();
      try {
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        await page.setJavaScriptEnabled(false);
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const url = req.url();
          if (url.startsWith('data:') || url === 'about:blank') void req.continue();
          else void req.abort('blockedbyclient'); // no external resources, ever
        });
        await page.setContent(html, { waitUntil: 'load' });
        const label = (opts.footerLabel ?? '').replace(/[<>&"]/g, '');
        const pdf = await page.pdf({
          format: 'A4', landscape: opts.landscape ?? false, printBackground: true,
          margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
          displayHeaderFooter: true, headerTemplate: '<span></span>',
          footerTemplate: `<div style="font-size:8px;color:#777;width:100%;padding:0 12mm;display:flex;justify-content:space-between;${opts.rtl ? 'direction:rtl;' : ''}"><span>${label}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
        });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  }

  async onModuleDestroy() {
    if (this.browser) {
      const b = await this.browser.catch(() => undefined);
      await b?.close().catch(() => undefined);
    }
  }
}
