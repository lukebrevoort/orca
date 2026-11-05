// Synthetic mail only. Exercises the production sanitizer and reader styles in Chromium.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { sanitizeInboundHtml } from '../../api/src/mail/provider-html.ts';
import { markReadableTableCells } from '../src/reader-table.ts';

const css = ['styles', 'reader-body'].map(name => readFileSync(new URL(`../src/${name}.css`, import.meta.url), 'utf8').replace(/@import[^;]+;/g, '')).join('\n');
const raw = '<table width="100%"><tr><td width="10"><div><img src="https://tracker.example.invalid/logo" alt="Microsoft"></div></td><td width="10"><span><a href="https://example.invalid/advisory">v12.345.6789</a></span></td><td>A synthetic security digest with readable advisory text.</td></tr></table>';
const hostile = `<img src="https://tracker.example.invalid/pixel" srcset="https://tracker.example.invalid/2x 2x" alt="Logo"><svg><image href="https://tracker.example.invalid/svg"></image></svg><style>@font-face{font-family:x;src:url(https://tracker.example.invalid/font)}</style><div style="background-image:url(https://tracker.example.invalid/background)">Text</div>`;
const html = sanitizeInboundHtml(raw);
assert(!html.includes('<img'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined });
const out = process.env.ORCA_READER_TABLE_OUT || '/tmp/orca-reader-table';
mkdirSync(out, { recursive: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [320, 720, 1024]) {
    const page = await browser.newPage({ viewport: { width, height: 700 }, colorScheme: theme });
    const requests = [];
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    await page.setContent(`<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width"><style>${css}</style><div class="reader-formatted-region" tabindex="0" role="region" aria-label="Formatted message"><div class="reader-body reader-body-html">${html}</div></div></html>`);
    await page.locator('.orca-mail-image-note').evaluate(note => { note.textContent = 'Microsoft'; }); // ReaderBody enhances the sanitizer placeholder.
    await page.locator('.reader-body').evaluate(markReadableTableCells);
    const measures = await page.evaluate(() => {
      const rects = selector => { const node = document.querySelector(selector).firstChild; const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].map(r => r.width); };
      const region = document.querySelector('.reader-formatted-region');
      return { version: rects('td a'), label: rects('.orca-mail-image-note'), regionWidth: region.clientWidth, scrollWidth: region.scrollWidth };
    });
    assert.equal(measures.version.length, 1, `version wraps at ${width}: ${JSON.stringify(measures)}`);
    assert.equal(measures.label.length, 1, `label wraps at ${width}: ${JSON.stringify(measures)}`);
    assert.equal(requests.length, 0);
    if (measures.scrollWidth > measures.regionWidth) {
      await page.locator('.reader-formatted-region').focus();
      for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      assert(await page.locator('.reader-formatted-region').evaluate(el => el.scrollLeft > 0), 'wide digest is keyboard scrollable');
      await page.locator('.reader-formatted-region').evaluate(el => { el.scrollLeft = 0; });
    }
    await page.screenshot({ path: `${out}/${theme}-${width}.png`, fullPage: true });
    const plain = sanitizeInboundHtml('<table width="100%"><tr><td width="10"><span>v12.345.6789</span></td><td width="10"> </td><td>Other details</td></tr></table>');
    await page.setContent(`<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width"><style>${css}</style><div class="reader-formatted-region" tabindex="0"><div class="reader-body reader-body-html">${plain}</div></div></html>`);
    await page.locator('.reader-body').evaluate(markReadableTableCells);
    const plainResult = await page.evaluate(() => {
      const cell = document.querySelector('td');
      const range = document.createRange(); range.selectNodeContents(cell.querySelector('span'));
      return { lines: range.getClientRects().length, marked: cell.classList.contains('reader-short-cell-value'), spacer: document.querySelectorAll('td')[1].className };
    });
    assert.deepEqual(plainResult, { lines: 1, marked: true, spacer: '' }, `plain version at ${width}`);
    if (width === 720) await page.screenshot({ path: `${out}/plain-${theme}.png`, fullPage: true });
    const longToken = 'a'.repeat(500);
    const nested = sanitizeInboundHtml(`<table role="presentation"><tr><td><table><tr><td><img src="https://tracker.example.invalid/long" alt="${longToken}"></td><td><a href="https://example.invalid/long">${longToken}</a></td></tr></table></td></tr></table>`);
    await page.setContent(`<!doctype html><html data-theme="${theme}"><meta name="viewport" content="width=device-width"><style>${css}</style><div class="reader-formatted-region" tabindex="0" role="region" aria-label="Formatted message"><div class="reader-body reader-body-html">${nested}</div></div></html>`);
    await page.locator('.reader-body').evaluate(markReadableTableCells);
    const bounds = await page.evaluate(() => {
      const region = document.querySelector('.reader-formatted-region');
      const cells = [...region.querySelectorAll('td, a, .orca-mail-image-note')];
      return { region: region.getBoundingClientRect().width, scrollWidth: region.scrollWidth, clientWidth: region.clientWidth,
        overflow: cells.filter(el => el.clientWidth && el.scrollWidth > el.clientWidth + 1).map(el => [el.tagName, el.className, el.clientWidth, el.scrollWidth]) };
    });
    assert.deepEqual(bounds.overflow, [], `nested long tokens clipped at ${width}: ${JSON.stringify(bounds)}`);
    if (bounds.scrollWidth > bounds.clientWidth) {
      await page.locator('.reader-formatted-region').focus();
      for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      assert(await page.locator('.reader-formatted-region').evaluate(el => el.scrollLeft > 0), 'wide table is keyboard scrollable');
    }
    await page.setContent(`<!doctype html><style>${css}</style><div class="reader-body reader-body-html">${sanitizeInboundHtml(hostile)}</div>`);
    await page.waitForTimeout(100);
    assert.equal(requests.length, 0, 'remote images, srcset, CSS, fonts and SVG must remain inert');
    await page.close();
  }
  console.log(`Passed six synthetic reader layouts; screenshots: ${out}`);
} finally { await browser.close(); }
