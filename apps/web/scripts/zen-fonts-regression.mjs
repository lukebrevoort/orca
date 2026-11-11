/** BRE-452/BRE-456 actual production UI; only loopback synthetic API writes.
 * node apps/web/scripts/zen-fonts-regression.mjs connection.json output [baseline]
 * Baseline deliberately exits 1 on observed contract failures, retaining all measurements.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const [connection, output, mode = 'candidate'] = process.argv.slice(2);
assert(connection && output);
assert(!process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY, 'Font readiness bypass is forbidden');
const origin = new URL(JSON.parse(await readFile(connection, 'utf8')).url).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname));
const out = resolve(output); await mkdir(out, { recursive: true });
const results = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mode,
  syntheticOnly: true, scenarios: [], assertions: 0, failures: [], externalRequests: [], fontResponses: [], draftResponses: [], screenshots: [], pageErrors: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE, args: ['--disable-background-networking'] });
results.browserVersion = browser.version();
results.nodeVersion = process.version;
let activePage;
function check(value, label, detail) { results.assertions++; if (!value) results.failures.push({ label, detail }); }
async function screenshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, name + '.png'), fullPage: true, timeout: 5000 });
  results.screenshots.push(name + '.png');
}
async function contextFor(theme, viewport, fontPath = 'blocked') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, serviceWorkers: 'block' });
  await context.addInitScript(t => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme: t, motion: 'reduced' })), theme);
  const held = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) {
      if (fontPath === 'offline' && request.resourceType() === 'font') return route.abort('internetdisconnected');
      return route.continue();
    }
    results.externalRequests.push({ theme, fontPath, url: url.href, type: request.resourceType() });
    if (fontPath === 'stall' && url.hostname === 'fonts.googleapis.com') {
      // The product's real external import loads this controlled stylesheet;
      // the font bytes then never arrive until the test releases the barrier.
      return route.fulfill({ contentType: 'text/css', body: '@font-face{font-family:Sora;src:url(https://fonts.gstatic.com/orca-stalled-sora.woff2)} @font-face{font-family:Newsreader;src:url(https://fonts.gstatic.com/orca-stalled-newsreader.woff2)}' });
    }
    if (fontPath === 'stall' && url.hostname === 'fonts.gstatic.com') {
      await new Promise(release => held.push(release)); return route.abort();
    }
    return route.abort();
  });
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => results.pageErrors.push(error.message));
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/v1/drafts')) results.draftResponses.push({ method: response.request().method(), path, status: response.status() });
    if (response.request().resourceType() === 'font') results.fontResponses.push({ url: response.url(), status: response.status(), bytes: (await response.body().catch(() => Buffer.alloc(0))).length });
  });
  await context.request.get(origin + '/__fixture/login');
  return { context, page, release: () => held.splice(0).forEach(fn => fn()) };
}
async function compose(page, label) {
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Compose(?:\s+C)?$/ }).first().click();
  const panel = page.locator('.compose-workspace-panel');
  await panel.getByRole('textbox', { name: 'Subject', exact: true }).fill(label);
  await panel.getByRole('textbox', { name: 'Message body', exact: true }).fill('Quiet correspondence.\n\nPreserve this writing and every attachment.');
  await panel.getByRole('combobox', { name: 'Add To recipient' }).fill('maya@example.com');
  await panel.getByRole('combobox', { name: 'Add To recipient' }).press('Enter');
  await panel.getByText('Saved to Orca and Gmail', { exact: true }).waitFor();
  return panel;
}
const file = name => ({ name, mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment bytes: ' + name) });
async function attach(scope, page, files) {
  const chooser = page.waitForEvent('filechooser');
  await scope.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles(files.map(file));
}
async function measure(page, name, expectedAttachments) {
  const scope = page.locator('.compose-workspace-zen');
  const measurements = await scope.evaluate(root => {
    const selectors = ['.compose-attachment-chips', '.compose-formatting', '.compose-delivery-bar', '.compose-conflict', '.compose-attachment-error'];
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const regions = selectors.flatMap(selector => [...root.querySelectorAll(selector)].map(el => ({ selector, ...rect(el) })));
    const collisions = [];
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1) collisions.push([a.selector, b.selector]);
    }
    return { regions, collisions, viewport: { width: innerWidth, height: innerHeight }, canvasOverflow: document.querySelector('.zen-canvas').scrollWidth > innerWidth + 1,
      targets: [...root.querySelectorAll('button,select')].map(el => ({ label: el.getAttribute('aria-label') || el.textContent, disabled: el.disabled, color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, opacity: getComputedStyle(el).opacity, ...rect(el) })) };
  });
  check(measurements.collisions.length === 0, name + ': independent regions never overlap', measurements.collisions);
  check(!measurements.canvasOverflow, name + ': no horizontal overflow', measurements);
  check(await scope.locator('.compose-attachment-chips li').count() === expectedAttachments, name + ': attachment count');
  const targets = scope.locator('.compose-attachment-chips button,.compose-formatting button,.compose-delivery-actions button,.compose-save-retry,.compose-conflict button');
  for (const target of await targets.all()) {
    const label = await target.getAttribute('aria-label') || await target.innerText();
    await target.scrollIntoViewIfNeeded();
    const hit = await target.evaluate(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, reachable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
    check(hit.reachable, name + ': visible hit target ' + label, hit);
    check(hit.width >= 44 && hit.height >= 44, name + ': 44px target ' + label, hit);
  }
  await scope.locator('.compose-delivery-bar > p').scrollIntoViewIfNeeded();
  await screenshot(page, name);
  console.log(JSON.stringify({ progress: name, assertions: results.assertions, failures: results.failures.length }));
  results.scenarios.push({ name, ...measurements });
}
async function cleanDraft(context, label) {
  const response = await context.request.get(origin + '/v1/drafts?accountId=first');
  for (const draft of await response.json()) if (draft.subject === label) {
    assert((await context.request.delete(origin + `/v1/drafts/${draft.id}?accountId=first`)).ok());
  }
}
try {
  for (const theme of ['light', 'dark']) {
    for (const fontPath of ['cold','reload','offline','stall']) {
      const { context, page, release } = await contextFor(theme, { width: 390, height: 844 }, fontPath);
      const before = results.externalRequests.length;
      await page.goto(origin + '/dev/inbox', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /^Compose(?:\s+C)?$/ }).first().click();
      await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Font reliability');
      if (fontPath === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      // Ensure the font is in active use, rather than inspecting only CSS strings.
      await page.evaluate(() => { document.body.getBoundingClientRect(); document.fonts.load('16px Sora').catch(() => {}); document.fonts.load('18px Newsreader').catch(() => {}); });
      const ready = await page.evaluate(() => Promise.race([document.fonts.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]));
      let screenshotError = null;
      try { await page.screenshot({ path: join(out, `${theme}-font-${fontPath}.png`), timeout: 2500 }); }
      catch (error) { screenshotError = error.message; }
      if (!screenshotError) results.screenshots.push(`${theme}-font-${fontPath}.png`);
      const requests = results.externalRequests.slice(before);
      check(ready, `${theme}/${fontPath}: document.fonts.ready resolves without bypass`);
      check(!screenshotError, `${theme}/${fontPath}: normal screenshot without bypass`, screenshotError);
      check(requests.length === 0, `${theme}/${fontPath}: zero external font requests`, requests);
      release();
      if (screenshotError) await screenshot(page, `${theme}-font-${fontPath}-after-release`);
      results.scenarios.push({ name: `${theme}-font-${fontPath}`, ready, screenshotError, requests, fontState: await page.evaluate(() => ({ status: document.fonts.status, loaded: [...document.fonts].map(f => ({ family: f.family, status: f.status })), body: getComputedStyle(document.body).fontFamily, resources: performance.getEntriesByType('resource').filter(r => /font|\.ttf|\.woff/.test(r.name)).map(r => ({ name: r.name, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize })) })) });
      await context.close();
    }
    for (const [width, height, suffix] of [[1440,1000,'desktop'],[1024,768,'narrow-desktop'],[390,844,'mobile'],[320,568,'small'],[390,400,'short'],[720,450,'200pct-reflow']]) {
      const label = `BRE452 ${theme} ${suffix}`;
      const { context, page } = await contextFor(theme, { width, height });
      try {
      const panel = await compose(page, label);
      await panel.getByRole('combobox', { name: 'Message format' }).selectOption('rich');
      await panel.locator('.compose-save-status-saved').waitFor();
      await page.getByRole('button', { name: 'Open in Zen', exact: true }).click();
      const zen = page.locator('.compose-workspace-zen'); await zen.waitFor();
      await measure(page, `${theme}-${width}-${suffix}-zero`, 0);
      await attach(zen, page, ['toolbar.txt']);
      await measure(page, `${theme}-${width}-${suffix}-one`, 1);
      await attach(zen, page, ['second.txt', 'very-long-correspondence-attachment-name-without-breaks-012345678901234567890123456789.txt']);
      await measure(page, `${theme}-${width}-${suffix}-multiple-long`, 3);
      await zen.getByRole('button', { name: 'Remove toolbar.txt', exact: true }).click();
      check(await zen.getByRole('button', { name: 'Remove toolbar.txt', exact: true }).count() === 0, label + ': removal works');
      await zen.getByRole('combobox', { name: 'Message format' }).selectOption('plain');
      check(await zen.getByRole('button', { name: 'Bold, Command B', exact: true }).isDisabled(), label + ': plain disables formatting');
      await measure(page, `${theme}-${width}-${suffix}-plain-removed`, 2);
      await zen.locator('.compose-save-status-saved').waitFor();
      if (width === 1440 || (width === 390 && height === 844)) {
        const control = zen.getByRole('button', { name: 'Attach files', exact: true });
        await control.hover(); await screenshot(page, `${theme}-${width}-attach-hover`);
        await control.focus();
        await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        check(await control.evaluate(el => el === document.activeElement && getComputedStyle(el).outlineStyle !== 'none'), label + ': visible keyboard focus');
        await screenshot(page, `${theme}-${width}-attach-focus`);
        await page.keyboard.press('Tab');
        check(await zen.getByRole('button', { name: 'Discard', exact: true }).evaluate(el => el === document.activeElement), label + ': toolbar-to-delivery keyboard order');
        await zen.getByRole('combobox', { name: 'Message format' }).selectOption('rich');
        await zen.locator('.compose-save-status-saved').waitFor();
        const bold = zen.getByRole('button', { name: 'Bold, Command B', exact: true });
        await bold.scrollIntoViewIfNeeded(); await bold.hover(); await page.mouse.down();
        await screenshot(page, `${theme}-${width}-bold-pressed`); await page.mouse.up();
        await zen.getByRole('combobox', { name: 'Message format' }).selectOption('plain');
        await zen.locator('.compose-save-status-saved').waitFor();
        await screenshot(page, `${theme}-${width}-plain-disabled`);
      }
      if (width === 1440) {
        await zen.locator('.compose-save-status-saved').waitFor();
        await attach(zen, page, Array.from({ length: 24 }, (_, i) => `limit-${i}.txt`));
        await zen.locator('.compose-attachment-error').waitFor();
        check(await zen.getByRole('button', { name: 'Attach files', exact: true }).isDisabled(), label + ': attachment limit is enforced');
        await measure(page, `${theme}-${width}-attachment-limit-error-disabled`, 25);
        for (let i = 0; i < 23; i++) await zen.getByRole('button', { name: `Remove limit-${i}.txt`, exact: true }).click();
        check(await zen.getByRole('button', { name: 'Attach files', exact: true }).isEnabled(), label + ': removing files restores chooser');
        check(await zen.locator('.compose-attachment-error').count() === 0, label + ': removal clears attachment error');
      }
      await page.getByRole('button', { name: 'Save & close', exact: true }).click();
      await page.locator('.compose-workspace-panel').waitFor();
      check(await page.locator('.compose-workspace-panel .compose-attachment-chips li').count() === 2, label + ': Zen transition preserves files');
      check((await page.getByRole('textbox', { name: 'Message body', exact: true }).innerText()).includes('Preserve this writing'), label + ': transition preserves text');
      await page.getByRole('button', { name: 'Close panel', exact: true }).click();
      } catch (error) {
        results.failures.push({ label: label + ': completed interaction path', detail: error.message });
        console.error(error.stack);
        await screenshot(page, `${theme}-${width}-${suffix}-interaction-failure`).catch(() => {});
        await writeFile(join(out, `${theme}-${width}-${suffix}-failure-dom.txt`), await page.locator('body').innerText());
        if (mode === 'candidate') throw error;
      } finally { await context.close(); await cleanDraftViaNewContext(label); }
    }
    for (const [width,height] of [[1440,1000],[1024,768],[390,844],[320,568],[390,400],[720,450]]) await stateJourney(theme,{width,height});
  }
  check(results.externalRequests.length === 0, 'All journeys use zero external requests', results.externalRequests);
  check(results.pageErrors.length === 0, 'No uncaught page errors', results.pageErrors);
} catch (error) {
  results.fatal = error.stack; results.failures.push({ label: 'driver completed all scenarios', detail: error.message });
  if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: join(out, 'failure.png'), timeout: 5000 }).catch(() => {}); await writeFile(join(out,'failure-dom.txt'),await activePage.locator('body').innerText()).catch(()=>{}); }
} finally {
  await browser.close();
  results.scenarioCount = results.scenarios.length; results.screenshotCount = results.screenshots.length;
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ commit: results.commit, scenarios: results.scenarioCount, assertions: results.assertions, failures: results.failures.length, externalRequests: results.externalRequests.length, fatal: results.fatal }));
}
process.exitCode = results.failures.length ? 1 : 0;
async function cleanDraftViaNewContext(label) { const context = await browser.newContext(); await context.request.get(origin + '/__fixture/login'); await cleanDraft(context, label); await context.close(); }

async function poll(fn, message) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}
async function stateJourney(theme, viewport) {
  const { context, page } = await contextFor(theme, viewport);
  const prefix = `BRE452 states ${theme} ${viewport.width}x${viewport.height}`;
  const api = async (path, method='GET', data) => {
    const response = await context.request.fetch(origin + path, { method, data });
    assert(response.ok(), `${method} ${path}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  };
  let releasePatch = () => {}, releaseSend = () => {};
  try {
    const panel = await compose(page, prefix);
    await panel.getByText('Saved to Orca and Gmail', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open in Zen', exact: true }).click();
    const zen = page.locator('.compose-workspace-zen'); await zen.waitFor();
    await attach(zen, page, ['state-keep.txt', 'long-status-and-recovery-attachment-012345678901234567890123456789.txt']);
    await zen.getByRole('combobox', { name: 'Message format' }).selectOption('rich');
    await poll(async () => (await api('/v1/drafts?accountId=first')).find(d => d.subject === prefix && d.providerSyncStatus === 'synced'), 'Initial draft saved');
    // Actual autosave request is held, then fails once; Retry must persist latest text.
    let patchStarted;
    const patchRequested = new Promise(resolve => { patchStarted = resolve; });
    const patchGate = new Promise(resolve => { releasePatch = resolve; });
    const patchRoute = async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patchStarted(); await patchGate;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_unavailable', message: 'Synthetic save interrupted; writing is preserved.' } }) });
    };
    await page.route('**/v1/drafts/**', patchRoute);
    const latestBody = 'Latest writing survives a failed save, recovery and uncertain send.';
    await zen.getByRole('textbox', { name: 'Message body', exact: true }).fill(latestBody);
    await patchRequested;
    await measure(page, prefix.replaceAll(' ', '-') + '-pending', 2);
    releasePatch();
    await zen.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    await measure(page, prefix.replaceAll(' ', '-') + '-failed', 2);
    await page.unroute('**/v1/drafts/**', patchRoute);
    await zen.getByRole('button', { name: 'Retry', exact: true }).click();
    const saved = await poll(async () => (await api('/v1/drafts?accountId=first')).find(d => d.subject === prefix && d.body.text === latestBody && d.providerSyncStatus === 'synced'), 'Retry saves latest writing');
    check(saved.body.text === latestBody, prefix + ': retry persisted latest writing');
    await zen.locator('.compose-save-status-saved').waitFor();
    await measure(page, prefix.replaceAll(' ', '-') + '-saved', 2);
    await zen.getByRole('combobox', { name: 'Add To recipient' }).fill('unfinished-address');
    const validateSend = zen.getByRole('button', { name: 'Send', exact: true });
    check(await validateSend.getAttribute('aria-disabled') === 'true', prefix + ': invalid pending address is not delivery-ready');
    // A real keyboard activation reaches the existing validation handler;
    // locator.click intentionally refuses an aria-disabled control.
    await validateSend.focus(); await page.keyboard.press('Enter');
    await zen.getByText(/Check the highlighted address/).waitFor();
    await measure(page, prefix.replaceAll(' ', '-') + '-validation', 2);
    await zen.getByRole('combobox', { name: 'Add To recipient' }).fill('');
    // A genuine API/SQLite revision conflict, followed by actual copy recovery.
    await api(`/v1/drafts/${saved.id}?accountId=first`, 'PATCH', { revision: saved.revision, subject: prefix + ' remote', body: { text: 'Remote version remains safe.', html: null } });
    await zen.getByRole('textbox', { name: 'Message body', exact: true }).fill(latestBody + ' Local recovery copy.');
    await zen.getByRole('alert', { name: 'Draft recovery choice' }).waitFor();
    await measure(page, prefix.replaceAll(' ', '-') + '-conflict', 2);
    await zen.getByRole('button', { name: 'Keep mine as a new draft', exact: true }).click();
    await zen.getByRole('alert', { name: 'Draft recovery choice' }).waitFor({ state: 'hidden' });
    const original = await api(`/v1/drafts/${saved.id}?accountId=first`);
    check(original.body.text === 'Remote version remains safe.', prefix + ': recovery preserves remote original');
    check(await zen.locator('.compose-attachment-chips li').count() === 2, prefix + ': recovery preserves files');
    const ledgerBefore = (await api('/__fixture/deliveries')).length;
    await api('/__fixture/outcome', 'POST', { outcome: 'ambiguous' });
    let sendStarted;
    const sendRequested = new Promise(resolve => { sendStarted = resolve; });
    const sendGate = new Promise(resolve => { releaseSend = resolve; });
    const sendRoute = async route => { sendStarted(); await sendGate; return route.continue(); };
    await page.route('**/v1/drafts/*/send?*', sendRoute);
    await zen.getByRole('button', { name: 'Send', exact: true }).click();
    await sendRequested;
    await measure(page, prefix.replaceAll(' ', '-') + '-sending', 2);
    check(await zen.getByRole('button', { name: 'Sending…', exact: true }).isDisabled(), prefix + ': dispatch is single flight');
    releaseSend();
    await page.unroute('**/v1/drafts/*/send?*', sendRoute);
    await zen.getByText(/could not be confirmed/).waitFor();
    await measure(page, prefix.replaceAll(' ', '-') + '-uncertain', 2);
    const replayResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/send'));
    await zen.getByRole('button', { name: 'Send', exact: true }).click();
    await replayResponse;
    await zen.getByText(/could not be confirmed/).waitFor();
    const deliveries = await api('/__fixture/deliveries');
    check(deliveries.length === ledgerBefore + 1, prefix + ': uncertain replay invokes provider once');
    check(deliveries.at(-1).draft.attachments.length === 2, prefix + ': synthetic dispatch preserves attachment count');
    check(deliveries.at(-1).draft.attachments.every(a => Buffer.from(a.contentBase64, 'base64').toString() === 'Synthetic attachment bytes: ' + a.filename), prefix + ': synthetic dispatch preserves attachment bytes');
    check(deliveries.at(-1).draft.body.text.includes('Local recovery copy.'), prefix + ': synthetic dispatch uses recovered writing');
    results.scenarios.push({ name: prefix + '-preservation', providerCalls: deliveries.length - ledgerBefore });
  } catch (error) {
    results.failures.push({ label: prefix + ': state journey completed', detail: error.message });
    console.error(error.stack);
    await screenshot(page, prefix.replaceAll(' ', '-') + '-failure').catch(() => {});
    await writeFile(join(out, prefix.replaceAll(' ', '-') + '-failure-dom.txt'), await page.locator('body').innerText());
    if (mode === 'candidate') throw error;
  } finally {
    releasePatch(); releaseSend();
    await api('/__fixture/outcome', 'POST', { outcome: 'sent' });
    await context.close();
    const cleanup = await browser.newContext();
    await cleanup.request.get(origin + '/__fixture/login');
    const response = await cleanup.request.get(origin + '/v1/drafts?accountId=first');
    for (const draft of await response.json()) if (draft.subject.startsWith(prefix)) await cleanup.request.delete(origin + `/v1/drafts/${draft.id}?accountId=first`);
    await cleanup.close();
  }
}
