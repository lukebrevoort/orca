/** Hosted-only production global-search checks against disposable API/SQLite mail. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
assert(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true', 'Use hosted CI only');
const [connectionFile, outputDirectory] = process.argv.slice(2);
assert(connectionFile && outputDirectory);
const fixture = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(fixture.url);
assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
assert(origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash);
const out = resolve(outputDirectory); await mkdir(out, { recursive: true });
const results = { syntheticOnly: true, hostedCIOnly: true, scenarios: [], screenshots: [], pageErrors: [], externalRequestsBlocked: [] };
let browser, activePage;
async function poll(check, message) {
  const until = Date.now() + 12000;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}
try {
  const { chromium } = await import('playwright'); browser = await chromium.launch();
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme });
    await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin.origin) return route.continue();
      results.externalRequestsBlocked.push(url.origin); return route.abort();
    });
    const login = await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 }); assert.equal(login.status(), 302);
    assert.equal(login.headers().location, '/');
    const me = await context.request.get(`${origin.origin}/v1/auth/session`, { maxRedirects: 0 }); assert(me.ok());
    assert.equal((await me.json()).user?.id, 'compose-fixture-user');
    const page = await context.newPage(); activePage = page;
    page.on('pageerror', error => results.pageErrors.push(error.message));
    let searches = 0;
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/v1/inbox' && url.searchParams.has('query')) searches++; });
    const params = new URLSearchParams({ search: 'mail', searchQuery: 'Maya confirmed', searchMailbox: 'all', searchEvidence: 'all', searchSource: '/?destination=inbox' });
    await page.goto(`${origin.origin}/?${params}`);
    const matches = page.locator('.global-mail-result-list li');
    await poll(async () => await matches.count() === 2, 'Sender+body must find both stored confirmations');
    assert.equal(await page.getByRole('textbox', { name: 'Search stored mail' }).inputValue(), 'Maya confirmed');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const filename = `${width}-${theme}-body-matches.png`;
    await page.screenshot({ path: join(out, filename), fullPage: true }); results.screenshots.push(filename);
    await matches.first().getByRole('link').click();
    await page.getByText('Your synthetic appointment is CONFIRMED with Morgan. Booking code BK_42.', { exact: false }).first().waitFor();
    await page.goBack();
    await poll(async () => await matches.count() === 2, 'Back must restore search results');
    const input = page.getByRole('textbox', { name: 'Search stored mail' });
    await input.fill('maya "appointment is confirmed"'); await input.press('Enter');
    await poll(async () => await matches.count() === 2, 'Quoted body phrase must match');
    await input.fill('"confirmed appointment"'); await input.press('Enter');
    await page.getByRole('heading', { name: /Nothing found/ }).waitFor();
    await input.fill('BK_42'); await input.press('Enter');
    await poll(async () => await matches.count() === 2, 'Literal underscore must match');
    const beforeInvalid = searches;
    await input.fill(Array.from({ length: 17 }, (_, index) => `word${index}`).join(' ')); await input.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'at most 16 distinct search terms' }).waitFor();
    assert.equal(searches, beforeInvalid, 'Rejected terms must not dispatch a search');
    results.scenarios.push({ width, theme, status: 'passed', checks: ['sender-and-body', 'reader-and-back', 'quoted-phrase', 'phrase-order', 'literal-underscore', 'term-limit'] });
    await context.close(); activePage = null;
  }
  assert.equal(results.scenarios.length, 4); assert.deepEqual(results.pageErrors, []);
} catch (error) {
  results.error = String(error); process.exitCode = 1;
  if (activePage) {
    await activePage.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
    await writeFile(join(out, 'failure-dom.txt'), await activePage.locator('body').innerText().catch(() => '')).catch(() => {});
  }
} finally {
  await browser?.close(); await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
}
