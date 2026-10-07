/** Hosted-only ranked search journey on disposable synthetic API/SQLite. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
assert(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true', 'Search browser checks require hosted CI');
const [connectionFile, outputDirectory] = process.argv.slice(2);
assert(connectionFile && outputDirectory);
const fixture = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(fixture.url);
assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash);
const out = resolve(outputDirectory); await mkdir(out, { recursive: true });
const result = { syntheticOnly: true, hostedCIOnly: true, scenarios: [], screenshots: [], pageErrors: [], externalRequestsBlocked: [] };
const moduleName = process.env.ORCA_PLAYWRIGHT_MODULE;
const { chromium } = await import(moduleName?.startsWith('/') ? pathToFileURL(moduleName).href : moduleName ?? 'playwright');
let browser;
async function until(check, message) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(message); }
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined, args: ['--disable-background-networking'] });
  result.browserVersion = browser.version();
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const scenario = { width, theme, status: 'running', checks: [] }; result.scenarios.push(scenario);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    context.setDefaultTimeout(15000);
    let page;
    try {
      await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
      await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin.origin) return route.continue(); result.externalRequestsBlocked.push(url.origin); return route.abort(); });
      assert.equal((await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 })).status(), 302);
      const session = await context.request.get(`${origin.origin}/v1/auth/session`); assert.equal((await session.json()).user.id, 'compose-fixture-user');
      const initialBrowse = await context.request.get(`${origin.origin}/v1/inbox?view=all&classification=all&limit=100`);
      assert(initialBrowse.ok());
      assert(!(await initialBrowse.json()).messages.some(message => message.subject.startsWith('Orcabeacon')), 'Search fixture must be outside initial loaded rows');
      scenario.checks.push('matching messages absent from initial 100 browse rows');
      page = await context.newPage();
      page.on('pageerror', error => result.pageErrors.push(error.message));
      await page.goto(origin.origin);
      // Wait for the authenticated React surface, then use its real search form.
      // A keyboard shortcut sent immediately after navigation can precede mount.
      const entry = page.getByRole('textbox', { name: 'Search mail', exact: true });
      await entry.fill('Orcabeacon'); await entry.press('Enter');
      const query = page.getByRole('textbox', { name: 'Search stored mail' });
      await query.waitFor({ state: 'visible' });
      assert.equal(await query.inputValue(), 'Orcabeacon');
      const rows = page.locator('.global-mail-result-list a');
      await until(async () => await rows.count() === 10, 'First ranked page must contain 10 messages');
      assert(await page.getByText('10 shown', { exact: false }).isVisible());
      const firstSubjects = await rows.locator('strong').allTextContents();
      assert.deepEqual(firstSubjects, Array.from({ length: 10 }, (_, i) => `Orcabeacon record ${String(i + 1).padStart(2, '0')}`));
      scenario.checks.push('10 relevance results include old stored mail');
      await page.getByRole('button', { name: 'Load more', exact: true }).click();
      await until(async () => await rows.count() === 12, 'Load more must complete 12 distinct matches');
      assert.equal(new Set(await rows.locator('strong').allTextContents()).size, 12);
      assert.equal(await page.getByRole('button', { name: 'Load more', exact: true }).count(), 0);
      scenario.checks.push('stable Load more exhausts index');
      await rows.last().click();
      await until(async () => !await query.isVisible(), 'Result reader must replace search overlay');
      await page.goBack();
      await query.waitFor({ state: 'visible' });
      await until(async () => await rows.count() === 12, 'Back must reload a fresh snapshot to the prior loaded position');
      assert.equal(await query.inputValue(), 'Orcabeacon');
      scenario.checks.push('reader and Back preserve query');
      await query.fill('oceanblue'); await query.press('Enter');
      await until(async () => await rows.count() === 10 && (await query.inputValue()) === 'oceanblue', 'Body-only search must match');
      scenario.checks.push('stored plaintext body-only match');
      await page.getByRole('button', { name: /Filters/ }).click();
      // The wrapping label also contains option text. Locate its visible title
      // explicitly so exact label-text matching cannot absorb those options.
      const accountFilter = page.locator('#global-mail-search-filters label')
        .filter({ has: page.locator('span', { hasText: /^Account$/ }) }).locator('select');
      await accountFilter.selectOption('second');
      await until(async () => await rows.count() === 0 && await page.getByText('No matches', { exact: true }).isVisible(), 'Selected account must exclude other account messages');
      scenario.checks.push('explicit account scope');
      await query.fill('AI'); await query.press('Enter');
      await page.getByText(/Add a word or phrase with at least 3 characters/).waitFor();
      scenario.checks.push('visible short-only limitation');
      await query.fill('AI update'); await query.press('Enter');
      await until(async () => await page.getByText('No matches', { exact: true }).isVisible(), 'Mixed short clause must be accepted');
      scenario.checks.push('mixed short query accepted');
      await accountFilter.selectOption('');
      await query.fill('Orcabeacon'); await query.press('Enter');
      await until(async () => await rows.count() === 10, 'Search should recover after query edits');
      assert.equal((await context.request.post(`${origin.origin}/__fixture/search/mode`, { data: { mode: 'legacy-metadata' }, maxRedirects: 0 })).status(), 204);
      await query.fill('AI'); await query.press('Enter');
      await page.getByText(/Metadata-only search:/).waitFor();
      assert.equal(await page.getByText(/Add a word or phrase with at least 3 characters/).count(), 0);
      await query.fill('oceanblue'); await query.press('Enter');
      await until(async () => await rows.count() === 0 && await page.getByText('No matches', { exact: true }).isVisible(), 'Legacy metadata search must exclude body-only text');
      const legacyName = `search-legacy-${width}-${theme}.png`; await page.screenshot({ path: join(out, legacyName), fullPage: true }); result.screenshots.push(legacyName);
      scenario.checks.push('explicit operator rollback uses labeled metadata mode and accepts short text');
      assert.equal((await context.request.post(`${origin.origin}/__fixture/search/mode`, { data: { mode: 'indexed' }, maxRedirects: 0 })).status(), 204);
      await query.fill('Orcabeacon'); await query.press('Enter');
      await until(async () => await rows.count() === 10 && await page.getByText(/Indexed search covers/).isVisible(), 'Reactivation must start a fresh indexed page');
      scenario.checks.push('reactivation resets pagination and restores indexed coverage');
      const geometry = await page.evaluate(() => ({ document: [document.documentElement.clientWidth, document.documentElement.scrollWidth], modal: (() => { const x = document.querySelector('.global-mail-search'); return [x.clientWidth, x.scrollWidth]; })() }));
      assert(geometry.document[1] <= geometry.document[0] + 1 && geometry.modal[1] <= geometry.modal[0] + 1, 'Search must fit the viewport');
      const filename = `search-${width}-${theme}.png`; await page.screenshot({ path: join(out, filename), fullPage: true }); result.screenshots.push(filename);
      scenario.status = 'passed';
    } catch (error) {
      scenario.status = 'failed'; scenario.error = error.message;
      if (page) { await page.screenshot({ path: join(out, `failure-${width}-${theme}.png`), fullPage: true }).catch(() => {}); await writeFile(join(out, 'failure-dom.txt'), await page.content()).catch(() => {}); }
      throw error;
    } finally { await context.close(); }
  }
  assert.deepEqual(result.pageErrors, []);
} finally {
  await browser?.close();
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
}
