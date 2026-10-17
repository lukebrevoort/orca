/** Synthetic production-web reader controls. Chromium is not native iOS evidence. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function checkReaderTouchTargets({ browser, origin, out, screenshots = [] }) {
  assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  const result = { platform: 'responsive web / Chromium, not native iOS', syntheticOnly: true, scenarios: [], failures: [] };
  await mkdir(out, { recursive: true });
  try { for (const width of [320, 390, 760, 761, 1440]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const scenario = { width, theme, controls: [], pageErrors: [], unexpectedWrites: [] };
    result.scenarios.push(scenario);
    try {
      await context.addInitScript(t => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme: t, motion: 'reduced' })), theme);
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin.origin) return route.abort();
        const allowed = ['GET', 'HEAD'].includes(request.method())
          || request.method() === 'POST' && url.pathname === '/v1/sync/gmail'
          || request.method() === 'PATCH' && url.pathname === '/v1/threads/first-thread/read' && url.searchParams.get('accountId') === 'first';
        if (!allowed) { scenario.unexpectedWrites.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      });
      const login = await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 });
      assert.equal(login.status(), 302);
      const session = await context.request.get(`${origin.origin}/v1/auth/session`);
      assert.equal((await session.json()).user?.id, 'compose-fixture-user');
      const page = await context.newPage();
      page.on('pageerror', error => scenario.pageErrors.push(error.message));
      await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const original = page.getByRole('button', { name: 'Show complete original text', exact: true });
      await original.waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      const controls = [
        ['safety', page.getByRole('button', { name: 'Advanced safety', exact: true })],
        ['why', page.getByRole('button', { name: 'Why is this here?', exact: true })],
        ['reminder', page.locator('.reader-top-actions .remind-control > button')],
        ['original', original],
      ];
      const capture = async name => {
        if (width !== 390) return;
        const filename = `touch-${theme}-${name}.png`;
        await page.screenshot({ path: join(out, filename) }); screenshots.push(filename);
      };
      for (const [name, control] of controls) {
        await control.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        for (const state of ['default', 'hover', 'focus']) {
          if (state === 'hover') await control.hover();
          if (state === 'focus') { await page.keyboard.press('Tab'); await control.focus(); }
          const measurement = await control.evaluate(node => {
            const r = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { width: r.width, height: r.height, text: node.textContent.trim(), color: style.color, background: style.backgroundColor,
              focused: node === document.activeElement, focusVisible: node.matches(':focus-visible'), outline: style.outlineStyle,
              leftHit: node.contains(document.elementFromPoint(r.left + 2, r.top + r.height / 2)),
              rightHit: node.contains(document.elementFromPoint(r.right - 2, r.top + r.height / 2)) };
          });
          scenario.controls.push({ name, state, ...measurement });
          if (width <= 760 && (measurement.width < 44 || measurement.height < 44)) result.failures.push({ width, theme, name, state, reason: 'target below 44 CSS px', ...measurement });
          assert(measurement.text && measurement.leftHit && measurement.rightHit, `${name} must be labeled and unobscured`);
          if (state === 'focus') assert(measurement.focused && measurement.focusVisible && measurement.outline !== 'none', `${name} needs keyboard focus indication`);
          await capture(`${name}-${state}`);
        }
      }
      // Exercise the real toggle and press Enter to return; no draft or mail mutations.
      await original.click();
      const reading = page.getByRole('button', { name: 'Return to reading view', exact: true });
      assert.equal(await reading.getAttribute('aria-pressed'), 'true');
      await capture('original-selected');
      await reading.focus(); await page.keyboard.press('Enter');
      assert.equal(await original.getAttribute('aria-pressed'), 'false');
      assert(await page.locator('.reader-body-plain').innerText());
      for (const [name, label, dialog] of [['safety', 'Advanced safety', 'Thread Lane controls'], ['why', 'Why is this here?', 'Thread placement evidence']]) {
        const trigger = page.getByRole('button', { name: label, exact: true });
        await trigger.click();
        await page.getByRole('dialog', { name: dialog, exact: true }).waitFor();
        // The open modal correctly hides its background from role queries.
        assert.equal(await page.locator(name === 'safety' ? '.thread-lane-trigger' : '.thread-lane-why').getAttribute('aria-expanded'), 'true');
        await capture(`${name}-expanded`);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: dialog, exact: true }).waitFor({ state: 'hidden' });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, 'Reader controls must not widen the page');
      if (width === 390) {
        let release, held = false;
        const gate = new Promise(resolve => { release = resolve; });
        await page.route(url => url.pathname === '/v1/organization/query' && url.searchParams.get('threadId') === 'first-thread', async route => {
          held = true; await gate; await route.continue();
        });
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => document.querySelector('.thread-lane-why')?.disabled === true);
          // Wait for the actual request, not just the initial disabled paint.
          for (let i = 0; i < 100 && !held; i++) await page.waitForTimeout(20);
          assert(held, 'Synthetic placement request must be in flight');
          const why = page.locator('.thread-lane-why');
          await why.scrollIntoViewIfNeeded();
          assert(await why.isDisabled());
          const box = await why.boundingBox();
          scenario.disabled = { label: await why.innerText(), ...box };
          if (box.width < 44 || box.height < 44) result.failures.push({ width, theme, name: 'why', state: 'disabled', ...box });
          await capture('why-disabled');
        } finally { release(); }
        await page.waitForFunction(() => document.querySelector('.thread-lane-why')?.disabled === false);
      }
      assert.deepEqual(scenario.pageErrors, []); assert.deepEqual(scenario.unexpectedWrites, []);
    } finally { await context.close(); }
  } } catch (error) { result.error = error.message; throw error; }
  finally { await writeFile(join(out, 'touch-target-results.json'), JSON.stringify(result, null, 2)); }
  assert.deepEqual(result.failures, [], 'Reader touch targets below 44 CSS px at mobile breakpoints');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [connectionFile, out] = process.argv.slice(2);
  assert(connectionFile && out, 'Usage: node reader-touch-target-regression.mjs <synthetic connection.json> <output>');
  const fixture = JSON.parse(await readFile(connectionFile, 'utf8'));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined });
  try { await checkReaderTouchTargets({ browser, origin: new URL(fixture.url), out }); }
  finally { await browser.close(); }
}
