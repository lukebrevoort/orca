import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
const [connection, phase = 'after'] = process.argv.slice(2);
const { url } = JSON.parse(readFileSync(connection, 'utf8'));
const out = new URL('.', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true });
const results = [];
try {
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
    await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    await context.request.get(url + '/__fixture/login', { maxRedirects: 0 });
    const page = await context.newPage();
    await page.goto(url + '/?destination=drafts');
    await page.getByRole('heading', { name: 'No drafts yet', exact: true }).waitFor();
    const description = await page.locator('.drafts-view .inbox-empty-state').count() ? await page.locator('.drafts-view .inbox-empty-state').innerText() : await page.locator('.drafts-view').innerText();
    const compose = page.locator(width < 768 ? '.mobile-mail-compose' : '.desktop-compose');
    assert.match((await compose.getAttribute('aria-label')) ?? await compose.innerText(), /Compose/);
    assert.equal(await page.getByRole('button', { name: /Write/ }).count(), 0);
    await page.screenshot({ path: `${out}${phase}-${width}-${theme}.png`, fullPage: true });
    let matched = true;
    try { assert.match(description, /Choose Compose to start something human\./); } catch { matched = false; }
    if (phase === 'before') assert.equal(matched, false, 'Expected reproduction of stale Write guidance');
    else assert.equal(matched, true, 'Empty Drafts must name the actual Compose action');
    await compose.click();
    await page.getByRole('dialog', { name: 'Compose message', exact: true }).waitFor();
    results.push({ width, theme, description, guidanceMatchesAction: matched, composeOpens: true });
    await context.close();
  }
} finally { await browser.close(); }
writeFileSync(`${out}${phase}-results.json`, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
