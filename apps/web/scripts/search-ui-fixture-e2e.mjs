/** Synthetic browser search regression: node search-ui-fixture-e2e.mjs connection.json NEW_OUTPUT SOURCE_SHA [baseline]
 * SOURCE_SHA identifies the fixture build, not this harness. Run against a clean,
 * built checkout of that commit; retain its build log/asset hashes with results.
 * Baseline mode records all failures and continues via the documented workaround.
 * Both modes exit nonzero on any failed assertion. No provider or native coverage.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const [connectionFile, out, sourceCommit, mode] = process.argv.slice(2);
assert(connectionFile && out && /^[a-f0-9]{40}$/.test(sourceCommit));
assert(!mode || mode === 'baseline');
const { url } = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(url);
assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.pathname, '/'); assert(!origin.username && !origin.password && !origin.search && !origin.hash);
await mkdir(out); // Never overwrite/mix prior evidence.
const browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined, args: ['--disable-background-networking'] });
const results = { sourceCommit, harnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'), browser: browser.version(), syntheticOnly: true, mode: mode ?? 'candidate', scenarios: [], failures: [], pageErrors: [], externalRequestsBlocked: [] };
let page;
const matrix = [320, 390, 760, 1024, 1440].flatMap(width => ['light', 'dark'].map(theme => ({ width, theme, longAccount: false })));
matrix.push(...['light', 'dark'].map(theme => ({ width: 320, theme, longAccount: true })));
function check(ok, message, scenario) { if (!ok) { results.failures.push({ scenario, message }); if (!mode) throw new Error(message); } }
try {
  for (const entry of matrix) {
    const { width, theme, longAccount } = entry;
    const id = `${width}-${theme}${longAccount ? '-long' : ''}`;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin.origin) return route.continue();
      results.externalRequestsBlocked.push(new URL(route.request().url()).origin); return route.abort();
    });
    const login = await context.request.get(url + '/__fixture/login', { maxRedirects: 0 }); assert.equal(login.status(), 302);
    const session = await context.request.get(url + '/v1/auth/session'); assert.equal((await session.json()).user.id, 'compose-fixture-user');
    page = await context.newPage(); page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', error => results.pageErrors.push({ id, message: error.message }));
    const requests = [];
    page.on('request', request => { const u = new URL(request.url()); if (u.pathname === '/v1/inbox' && u.searchParams.has('query')) requests.push(u.pathname + u.search); });
    if (longAccount) await page.route('**/v1/accounts', async route => {
      const response = await route.fetch(); const body = await response.json();
      body.items = body.items.map(account => account.id === 'first' ? { ...account, email: 'synthetic-long-account-name-for-filter-layout@example.com' } : account);
      await route.fulfill({ response, json: body });
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    const header = page.getByRole('textbox', { name: 'Search mail', exact: true });
    await header.fill('conversation'); await header.press('Enter');
    await page.locator('.global-mail-result-list a').nth(1).waitFor();
    await page.getByRole('button', { name: /Filters/ }).click();
    const account = page.locator('.global-mail-search-filters label').filter({ hasText: /^Account/ }).locator('select');
    await account.selectOption('first');
    await page.waitForFunction(() => document.querySelectorAll('.global-mail-result-list a').length === 1 && document.querySelector('.global-mail-result-list').textContent.includes('first account conversation'));
    const scenario = { ...entry, id, requests, accountOptions: await account.locator('option').evaluateAll(nodes => nodes.map(n => ({ value: n.value, text: n.textContent }))) };
    results.scenarios.push(scenario);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${out}/${id}-filtered.png` });
    check(scenario.accountOptions.some(option => option.value === 'first') && scenario.accountOptions.some(option => option.value === 'second'), 'Both connected accounts must remain selectable after filtering', id);
    scenario.geometry = await page.locator('.global-mail-search, .global-mail-search-heading, .global-mail-search-form, .global-mail-search-toolbar, .global-mail-search-filters, .global-mail-search-results').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { className: node.className, left: r.left, right: r.right, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, viewport: innerWidth };
    }));
    for (const box of scenario.geometry) check(box.left >= -.5 && box.right <= width + .5 && box.scrollWidth <= box.clientWidth + 1, `Search region must fit: ${JSON.stringify(box)}`, id);
    // Use Tab, not programmatic focus for the traversal. Mark existing controls
    // only to identify visited nodes without relying on duplicate label text.
    const controls = await page.locator('.global-mail-search').evaluate(dialog => [...dialog.querySelectorAll('button:not(:disabled), input, select, a[href]')].filter(node => node.getBoundingClientRect().width > 0).map((node, index) => { node.dataset.searchCheckIndex = String(index); return index; }));
    await page.getByRole('textbox', { name: 'Search stored mail', exact: true }).focus();
    scenario.keyboard = [];
    for (let tab = 0; tab <= controls.length; tab++) {
      const focused = await page.evaluate(() => {
        const e = document.activeElement, r = e.getBoundingClientRect(), s = getComputedStyle(e);
        const clippedBy = [];
        for (let parent = e.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) && (r.left < bounds.left - .5 || r.right > bounds.right + .5)) clippedBy.push(parent.className);
        }
        return { index: e.dataset.searchCheckIndex, tag: e.tagName, label: e.getAttribute('aria-label') ?? e.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor, boxShadow: s.boxShadow, clippedBy };
      });
      scenario.keyboard.push(focused);
      check(focused.index !== undefined && focused.width > 0 && focused.height > 0 && focused.left >= 0 && focused.right <= width + .5 && focused.top >= 0 && focused.bottom <= 1000 && !focused.clippedBy.length, `Keyboard control must be reachable and unclipped: ${JSON.stringify(focused)}`, id);
      if (focused.label?.trim() === 'Search') await page.screenshot({ path: `${out}/${id}-keyboard-search.png` });
      await page.keyboard.press('Tab');
    }
    check(controls.every(index => scenario.keyboard.some(control => control.index === String(index))), 'Tab traversal must reach every enabled visible search control', id);
    const searchButton = page.locator('.global-mail-search-form > button'); await searchButton.hover(); await page.screenshot({ path: `${out}/${id}-hover-search.png` });
    if (!scenario.accountOptions.some(option => option.value === 'second')) {
      // Record baseline's failure above; use its known workaround only to finish geometry coverage.
      await account.selectOption(''); await account.locator('option[value="second"]').waitFor({ state: 'attached' });
      if (await page.getByRole('button', { name: /Filters/ }).getAttribute('aria-expanded') === 'false') await page.getByRole('button', { name: /Filters/ }).click();
    }
    await account.selectOption('second');
    await page.waitForFunction(() => document.querySelectorAll('.global-mail-result-list a').length === 1 && document.querySelector('.global-mail-result-list').textContent.includes('second account conversation'));
    check(requests.at(-1) === '/v1/inbox?limit=100&classification=all&searchMode=metadata&view=all&query=conversation&accountId=second', 'Second-account request preserves the existing search contract', id);
    await page.getByRole('button', { name: /Close Search mail/ }).click();
    await header.fill(''); await header.press('Enter');
    await page.locator('.global-mail-search-state').waitFor();
    check(await page.getByRole('button', { name: 'Save as View', exact: true }).isDisabled(), 'Empty search keeps Save as View disabled', id);
    await page.screenshot({ path: `${out}/${id}-empty-disabled.png` });
    await context.close();
  }
  assert.equal(results.pageErrors.length, 0); assert.equal(results.failures.length, 0, 'Search UI regression failures');
  results.status = 'passed';
} catch (error) {
  results.status = 'failed'; results.failure = String(error);
  if (page && !page.isClosed()) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2) + '\n');
}
