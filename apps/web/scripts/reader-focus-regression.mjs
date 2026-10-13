/** Real viewport keyboard regression; synthetic loopback mail only, never native iOS. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

export async function checkReaderFocus({ browser, origin, out, screenshots }) {
  assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  const result = { syntheticOnly: true, scenarios: [] };
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const scenario = { theme, focus: [], failures: [] };
    result.scenarios.push(scenario);
    try {
      await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
      assert.equal((await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 })).status(), 302);
      const session = await context.request.get(`${origin.origin}/v1/auth/session`);
      assert.equal((await session.json()).user.id, 'compose-fixture-user');
      const page = await context.newPage();
      page.on('pageerror', error => scenario.failures.push(error.message));
      await page.route('**/v1/threads/first-thread?*', async route => {
        const response = await route.fetch();
        const detail = await response.json();
        assert.equal(detail.messages[0].id, 'first-message');
        detail.messages = Array.from({ length: 60 }, (_, i) => ({ ...detail.messages[0], id: i ? `synthetic-${i}` : 'first-message', providerMessageId: `synthetic-${i}`, receivedAt: new Date(Date.UTC(2026, 9, 1, 8, i)).toISOString(), unread: false, bodyHtml: `<p>Synthetic message ${i + 1}. Conversation body.</p>`, bodyText: `Synthetic message ${i + 1}. Conversation body.` }));
        detail.thread.messageCount = 60;
        detail.thread.subject = 'Synthetic 60-message conversation';
        await route.fulfill({ response, json: detail });
      });
      await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`);
      await page.locator('.reader-document:not(.reader-loading)').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
      await page.getByRole('button', { name: 'Expand all', exact: true }).click();
      await page.locator('.reader-card-toggle').first().focus();
      for (const key of ['Tab', 'Shift+Tab']) for (let step = 0; step < 42; step++) {
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const focus = await page.evaluate(() => {
          const element = document.activeElement;
          const rect = element.getBoundingClientRect();
          const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { label: element.getAttribute('aria-label') || element.textContent.trim().slice(0, 80), rect: rect.toJSON(), visible: rect.width > 0 && rect.height > 0 && element.contains(top), covering: top?.className, nav: document.querySelector('.desktop-mobile-navigation').getBoundingClientRect().toJSON() };
        });
        scenario.focus.push({ key, step, ...focus });
        if (!focus.visible) scenario.failures.push(`${key} ${step}: ${focus.label} covered by ${focus.covering}`);
        if (key === 'Tab' && step === 13) {
          const name = `reader-focus-${theme}.png`;
          await page.screenshot({ path: join(out, name), fullPage: false });
          screenshots.push(name);
        }
      }
      // Phone-only scroll clearance must disappear on desktop and return after resize.
      await page.setViewportSize({ width: 1440, height: 844 });
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom), 'auto');
      await page.setViewportSize({ width: 390, height: 844 });
      if (await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBottom) !== '212px') scenario.failures.push('Mobile focus clearance did not return after desktop resize');
    } finally { await context.close(); }
  }
  await writeFile(join(out, 'reader-focus-results.json'), JSON.stringify(result, null, 2));
  assert.deepEqual(result.scenarios.flatMap(scenario => scenario.failures), [], 'Keyboard focus must remain visible above fixed mobile chrome');
  return result;
}
