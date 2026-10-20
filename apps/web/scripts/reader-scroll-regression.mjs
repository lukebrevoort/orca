/** Synthetic cloud-browser regression for the reader's document/element scroll switch. */
import assert from 'node:assert/strict';
import { join } from 'node:path';

export async function checkReaderScroll({ browser, origin, out, screenshots }) {
  assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  const result = { syntheticOnly: true, scenarios: [], pageErrors: [], externalRequestsBlocked: [], writes: [] };
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    context.setDefaultTimeout(12000);
    let page;
    try {
      await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' })), theme);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin.origin) return route.continue();
        result.externalRequestsBlocked.push({ origin: url.origin, path: url.pathname });
        return route.abort();
      });
      const login = await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 });
      assert.equal(login.status(), 302);
      assert.equal(login.headers().location, '/');
      const session = await context.request.get(`${origin.origin}/v1/auth/session`, { maxRedirects: 0 });
      assert(session.ok());
      assert.equal((await session.json()).user?.id, 'compose-fixture-user');
      page = await context.newPage();
      page.on('pageerror', error => result.pageErrors.push(error.message));
      page.on('request', request => {
        const url = new URL(request.url());
        const fixtureSync = request.method() === 'POST' && url.pathname === '/v1/sync/gmail';
        const fixtureRead = request.method() === 'PATCH' && url.pathname === '/v1/threads/first-thread/read' && url.searchParams.get('accountId') === 'first';
        if (url.origin === origin.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !fixtureRead && !fixtureSync) result.writes.push({ method: request.method(), path: url.pathname });
      });
      await page.route(url => url.origin === origin.origin && url.pathname === '/v1/threads/first-thread', async route => {
        assert.equal(route.request().method(), 'GET');
        assert.equal(new URL(route.request().url()).searchParams.get('accountId'), 'first');
        const response = await route.fetch({ maxRedirects: 0 });
        assert(response.ok());
        const detail = await response.json();
        assert.equal(detail.account.id, 'first');
        assert.equal(detail.thread.id, 'first-thread');
        assert.equal(detail.messages.length, 1);
        assert.equal(detail.messages[0].id, 'first-message');
        const paragraphs = Array.from({ length: 60 }, (_, index) => `Synthetic reading paragraph ${index + 1}. A long conversation keeps the reader away from its heading while testing navigation.`);
        detail.messages[0].bodyHtml = paragraphs.map(text => `<p>${text}</p>`).join('');
        detail.messages[0].bodyText = paragraphs.join('\n\n');
        await route.fulfill({ response, json: detail });
      });
      await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`, { waitUntil: 'networkidle' });
      await page.locator('.reader-body-html').waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const jump = page.getByRole('button', { name: 'Jump to top', exact: true });
      // One reader stays mounted across both breakpoint transitions. Native
      // scrolling and computed layout are measured; no geometry is mocked.
      for (const [stage, width] of [['mobile', 390], ['desktop-after-resize', 1440], ['mobile-after-resize', 390]]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.desktop-workspace').scrollTop = 0; });
        await page.waitForFunction(() => document.querySelector('.reader-jump-top').hidden);
        if (stage === 'mobile-after-resize') {
          await page.getByRole('button', { name: 'Plain text', exact: true }).click();
          await page.getByRole('button', { name: 'Formatted', exact: true }).click();
        }
        // Establish keyboard modality before scrolling. Tabbing away from the
        // floating jump can scroll to the header and legitimately hide it.
        await page.keyboard.press('Tab');
        const before = await page.evaluate(mobile => {
          const workspace = document.querySelector('.desktop-workspace');
          if (mobile) window.scrollTo(0, 900); else workspace.scrollTop = 900;
          return { windowY: window.scrollY, workspaceY: workspace.scrollTop, overflowY: getComputedStyle(workspace).overflowY };
        }, width === 390);
        assert.equal(width === 390 ? before.overflowY : ['auto', 'scroll'].includes(before.overflowY), width === 390 ? 'visible' : true);
        assert((width === 390 ? before.windowY : before.workspaceY) >= 850, `Fixture did not actually scroll: ${JSON.stringify(before)}`);
        await jump.waitFor({ state: 'visible' });
        const capture = async state => {
          const name = `jump-top-${theme}-${stage}-${state}.png`;
          await page.screenshot({ path: join(out, name) }); screenshots.push(name);
        };
        await capture('default');
        await jump.hover(); await capture('hover');
        await jump.focus();
        assert(await jump.evaluate(node => node === document.activeElement && node.matches(':focus-visible')));
        await capture('focus');
        await page.keyboard.press('Enter');
        await page.waitForFunction(mobile => (mobile ? window.scrollY : document.querySelector('.desktop-workspace').scrollTop) === 0, width === 390);
        await page.waitForFunction(() => document.activeElement?.id === 'reader-title' && document.querySelector('.reader-jump-top').hidden);
        result.scenarios.push({ theme, stage, width, before, returnedToTop: true, headingFocused: true });
      }
    } catch (error) {
      if (page) {
        const name = `jump-top-${theme}-failure.png`;
        await page.screenshot({ path: join(out, name) }).then(() => screenshots.push(name)).catch(() => {});
      }
      error.readerScrollResult = result;
      throw error;
    } finally { await context.close(); }
  }
  assert.equal(result.scenarios.length, 6);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.writes, []);
  return result;
}
