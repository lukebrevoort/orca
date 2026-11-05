/** Loopback-only synthetic regression for returning from a reader via its sidebar destination. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
const [connection, output] = process.argv.slice(2);
const origin = new URL(JSON.parse(await readFile(connection, 'utf8')).url);
assert.equal(origin.hostname, '127.0.0.1');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined });
const results = [];
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin.origin) return route.abort();
      if (!['GET', 'HEAD'].includes(req.method()) && !(req.method() === 'POST' && url.pathname === '/v1/sync/gmail')) return route.abort();
      if (url.pathname === '/v1/inbox') {
        const response = await route.fetch(); const data = await response.json();
        const base = data.messages.find(message => message.threadId === 'first-thread');
        if (base) data.messages = Array.from({ length: 60 }, (_, i) => ({ ...base, id: i ? `synthetic-${i}` : base.id, threadId: i ? `synthetic-thread-${i}` : base.threadId, providerMessageId: i ? `synthetic-provider-${i}` : base.providerMessageId, subject: i ? `Synthetic message ${i}` : base.subject, unread: false }));
        return route.fulfill({ response, json: data });
      }
      if (/^\/v1\/threads\/(first-thread|synthetic-thread-\d+)$/.test(url.pathname)) {
        const target = url.pathname.split('/').pop();
        const response = await context.request.get(`${origin.origin}/v1/threads/first-thread?accountId=first`); const data = await response.json();
        data.thread.id = target;
        data.messages[0].id = target === 'first-thread' ? 'first-message' : target.replace('synthetic-thread-', 'synthetic-');
        const body = Array.from({ length: 80 }, (_, i) => `Synthetic paragraph ${i + 1}. This conversation contains no private mail.`).join('\n\n');
        data.messages[0].bodyText = body; data.messages[0].bodyHtml = null;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin.origin, { waitUntil: 'networkidle' });
    const row = page.locator('button.message-row').filter({ hasText: 'first account conversation' });
    await row.waitFor();
    const workspace = page.locator('.desktop-workspace');
    const inbox = page.locator('nav[aria-label="Primary navigation"] button.desktop-sidebar-item[aria-current="page"]');
    for (const position of [0, 300]) {
      await workspace.evaluate((el, y) => { el.scrollTop = y; }, position);
      const before = await workspace.evaluate(el => el.scrollTop);
      if (position) assert(before >= 290, `List must scroll: ${before}`);
      const target = position ? page.locator('button.message-row').nth(8) : row;
      await target.scrollIntoViewIfNeeded();
      const clickedAt = await workspace.evaluate(el => el.scrollTop);
      await target.click();
      await page.locator('[aria-label="Message reader"]').waitFor();
      await page.getByText('Synthetic paragraph 80.', { exact: false }).waitFor();
      await workspace.evaluate(el => { el.scrollTop = 1000; });
      const reader = await workspace.evaluate(el => el.scrollTop);
      assert(reader >= 900, `Reader must scroll: ${reader}`);
      await inbox.click();
      await row.waitFor({ state: 'visible' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const after = await workspace.evaluate(el => el.scrollTop);
      assert(Math.abs(after - clickedAt) < 3, `Return moved: ${clickedAt} -> ${after}`);
      results.push({ theme, before, clickedAt, reader, after });
      await page.screenshot({ path: join(output, `${theme}-${position}-return.png`) });
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await writeFile(join(output, 'results.json'), JSON.stringify({ syntheticOnly: true, browser: browser.version(), results }, null, 2));
  await browser.close();
}
