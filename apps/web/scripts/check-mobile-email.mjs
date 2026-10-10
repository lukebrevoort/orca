// Run with Bun. Real Chromium, synthetic messages only, no API/DB or network.
// MOBILE_EMAIL_OUT=/tmp/orca-mobile-email CHROMIUM_PATH=/usr/bin/chromium bun apps/web/scripts/check-mobile-email.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { sanitizeInboundHtml } from '../../api/src/mail/provider-html.ts';
const root = resolve(import.meta.dir, '../../..');
const require = createRequire(process.env.DIAGNOSTIC_DEPS ? resolve(process.env.DIAGNOSTIC_DEPS, 'package.json') : resolve(root, 'package.json'));
const { chromium } = require('playwright');
const ts = require('typescript');
const sanitizeHtml = require('sanitize-html');
const read = p => readFileSync(resolve(root, p), 'utf8');
const out = process.env.MOBILE_EMAIL_OUT || '/tmp/orca-mobile-email';
mkdirSync(out, { recursive: true });
const baselineSha = '29958f22a1f91dd90c46766a67238603a5a5f857';
const oldRead = p => execFileSync('git', ['show', `${baselineSha}:${p}`], { cwd: root, encoding: 'utf8' });
const oldSource = oldRead('apps/api/src/index.ts');
const start = oldSource.indexOf('const providerHtmlPolicy:');
const end = oldSource.indexOf('\nfunction sanitizeOutboundHtml', start);
assert(start > 0 && end > start);
const sandbox = { sanitizeHtml };
vm.runInNewContext(ts.transpileModule(oldSource.slice(start, end) + '\nglobalThis.sanitize = sanitizeProviderHtml;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
const cssFiles = ['styles', 'desktop-switch', 'reader-body', 'mail-selection', 'organization-lanes', 'organization-views', 'mobile-mail'];
const stylesheet = reader => cssFiles.map(name => reader(`apps/web/src/${name}.css`).replace(/@import[^;]+;/g, '')).join('\n');
const css = stylesheet(read), oldCss = stylesheet(oldRead);
const fixtures = Object.fromEntries(['newsletter', 'inline-cards', 'data-and-code'].map(name => [name, read(`diagnostics/mobile-email/fixtures/${name}.html`)]));
fixtures.ordinary = '<p>Hello Sam,</p><p>Thanks for the thoughtful conversation. Here are the <a href="https://example.invalid/notes">meeting notes</a>.</p><p>See you next week,<br>Alex</p>';
fixtures['long-thread'] = Array.from({ length: 30 }, (_, n) => `<p>Message ${n + 1}: Our next workshop has a place for everyone.</p><blockquote><p>Earlier reply ${n + 1}: Please bring your ideas and questions.</p></blockquote>`).join('');
fixtures['nested-data'] = '<table role="presentation" width="640"><tr><td style="padding:60px"><p>Workshop attendance</p><table><caption>Attendance</caption><tr><th>Day</th><th>People</th></tr><tr><td>Saturday</td><td>24</td></tr></table><p>All participants are welcome.</p></td></tr></table>';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true });
const results = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), baselineSha, browser: browser.version(), scope: 'Actual production sanitizer and web CSS in a body-only Chromium harness; not full app, Dynamic Type, or WKWebView.', layouts: [], baseline: [] };
try {
  for (const [name, input] of Object.entries(fixtures)) for (const width of [272, 342, 390, 1024]) for (const theme of ['light', 'dark']) for (const size of ['standard', 'large']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const requests = [];
    await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    const html = sanitizeInboundHtml(input);
    if (['newsletter', 'inline-cards', 'nested-data'].includes(name)) assert(html.includes('orca-mail-layout'), `${name}: trusted layout marker`);
    assert(!/<img\b/i.test(html), `${name}: remote images replaced`);
    const doc = (body, styles) => `<!doctype html><html data-theme="${theme}" data-reader-size="${size}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${styles}</style><div class="reader-formatted-region" role="region" tabindex="0" aria-label="Formatted message"><div class="reader-body reader-body-html">${body}</div></div></html>`;
    await page.setContent(doc(html, css));
    const metrics = await page.evaluate(() => {
      const body = document.querySelector('.reader-body');
      const region = document.querySelector('.reader-formatted-region');
      const rect = el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
      const layout = body.querySelector('table.orca-mail-layout');
      const textRects = [];
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 0) textRects.push(r);
      }
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        region: { ...rect(region), scrollWidth: region.scrollWidth, clientWidth: region.clientWidth }, outerTable: layout ? rect(layout) : null,
        textBeyondViewport: textRects.filter(r => r.right > innerWidth + 1 || r.left < -1).length,
        bodyFont: parseFloat(getComputedStyle(body).fontSize), copyFonts: [...body.querySelectorAll('.orca-mail-layout p')].map(p => parseFloat(getComputedStyle(p).fontSize)),
        dataTables: [...body.querySelectorAll('table:not(.orca-mail-layout)')].map(t => ({ display: getComputedStyle(t).display, headers: t.querySelectorAll('th').length })),
        code: body.querySelector('pre')?.textContent, links: [...body.querySelectorAll('a')].map(a => a.getAttribute('href')), text: body.textContent,
        layoutCells: [...body.querySelectorAll('table.orca-mail-layout td')].filter(td => td.closest('table').classList.contains('orca-mail-layout')).map(td => ({ ...rect(td), display: getComputedStyle(td).display })) };
    });
    assert.equal(requests.length, 0, `${name}: remote request before rendering`);
    for (const table of metrics.dataTables) assert.equal(table.display, 'table', `${name}: data table semantics`);
    if (metrics.outerTable) {
      // Global web min-width:320px is pre-existing. At 272px the body harness
      // reports it rather than claiming a fit; actual app validation is separate.
      if (width >= 320) { assert.equal(metrics.documentOverflow, false, name); assert.equal(metrics.textBeyondViewport, 0, name); }
      if (width <= 720) for (const cell of metrics.layoutCells) assert.equal(cell.display, 'block', `${name}: columns stack`);
      for (const font of metrics.copyFonts) assert.equal(font, metrics.bodyFont, `${name}: copy follows reader size`);
    }
    if (name === 'data-and-code') assert(metrics.code.includes('    const artifact = "release_candidate_'), 'Code indentation/content retained');
    if (name === 'ordinary') { assert(metrics.links.includes('https://example.invalid/notes')); assert(metrics.text.includes('See you next week,')); }
    if (name === 'long-thread') assert(metrics.text.includes('Message 30:'), 'Long thread complete');
    results.layouts.push({ name, width, theme, size, requests: requests.length, ...metrics });
    if (width === 342 && size === 'standard' && ['newsletter', 'inline-cards', 'data-and-code'].includes(name)) {
      await page.screenshot({ path: `${out}/${name}-${theme}-after.png`, fullPage: true });
      await page.setContent(doc(sandbox.sanitize(input), oldCss));
      const before = await page.evaluate(() => {
        const table = document.querySelector('.reader-body table');
        const region = document.querySelector('.reader-formatted-region');
        const rect = table?.getBoundingClientRect();
        return { documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
          outerTable: rect ? { width: rect.width, height: rect.height } : null,
          region: { clientWidth: region.clientWidth, scrollWidth: region.scrollWidth } };
      });
      results.baseline.push({ name, width, theme, size, ...before });
      await page.screenshot({ path: `${out}/${name}-${theme}-before.png`, fullPage: true });
    }
    await context.close();
  }
  writeFileSync(`${out}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(`Passed ${results.layouts.length} Chromium layouts; screenshots and exact dimensions: ${out}`);
} finally { await browser.close(); }
