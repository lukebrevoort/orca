/** Hosted-only measurements on synthetic production-reader data.
 * Uses the existing authenticated, loopback-only fixture. No send, provider,
 * real account, profile, or production data is involved. CDP durations are
 * cumulative main-thread seconds; interaction samples use in-page click to
 * settled animation frames rather than Playwright command round trips.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';

const sampleCount = 5;
const metricNames = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'];
const getMetrics = async session => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];

function presentation(count) {
  const paragraphs = Array.from({ length: 18 }, (_, index) => `<p>Project note ${index + 1}: Our synthetic review keeps the complete conversation readable, with <strong>decisions</strong>, <em>context</em>, and <a href="https://example.com/review">reference links</a>. All content is synthetic and safe for test evidence.</p>`).join('');
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'first-message' : `profile-message-${index}`,
    providerMessageId: `profile-provider-${index}`,
    receivedAt: new Date(Date.UTC(2026, 9, 1, 8, index)).toISOString(),
    bodyHtml: `<h2>Review note ${index + 1}</h2>${paragraphs}<table><caption>Review ${index + 1} checklist</caption><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody>${Array.from({ length: 6 }, (_, row) => `<tr><td>Check ${row + 1}</td><td>Ready for review</td></tr>`).join('')}</tbody></table><p>End of review ${index + 1}</p>`,
    bodyText: `Review note ${index + 1}\n\n${Array.from({ length: 18 }, (_, row) => `Project note ${row + 1}: Our synthetic review keeps the complete conversation readable, with decisions, context, and reference links.`).join('\n\n')}\n\nOn Monday, Reviewer wrote:\n> The complete previous context remains available.\nEnd of review ${index + 1}`,
    unread: false,
  }));
}

export async function profileReaderInteractions({ browser, origin, out, screenshots, assertFocusPaint }) {
  assert(process.env.GITHUB_ACTIONS === 'true', 'Interaction profiling is hosted GitHub Actions only');
  const result = { syntheticOnly: true, sampleCount, cpuSlowdown: 4, scenarios: [], pageErrors: [], blockedWrites: [] };
  for (const count of [1, 60]) for (const theme of ['light', 'dark']) for (const rendering of theme === 'light' ? ['browser-managed', 'force-visible-control'] : ['force-visible-control', 'browser-managed']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const scenario = { messages: count, theme, rendering, samples: [], summary: {}, status: 'running' };
    result.scenarios.push(scenario);
    let page;
    let htmlOnly = false;
    let authenticatedFixture = false;
    try {
      await context.addInitScript(theme => {
        localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, motion: 'reduced' }));
        window.__readerProfile = { start: 0, longTasks: [] };
        new PerformanceObserver(list => window.__readerProfile.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))).observe({ type: 'longtask', buffered: true });
        document.addEventListener('click', () => { window.__readerProfile.start = performance.now(); }, true);
      }, theme);
      await context.route('**/*', route => {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin !== origin.origin) return route.abort();
        if (request.method() !== 'GET' && !(request.method() === 'POST' && url.pathname === '/v1/sync/gmail') && !(request.method() === 'PATCH' && url.pathname === '/v1/threads/first-thread/read')) {
          result.blockedWrites.push({ method: request.method(), path: url.pathname }); return route.abort();
        }
        return route.continue();
      });
      const login = await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 });
      assert.equal(login.status(), 302); assert.equal(login.headers().location, '/');
      const session = await context.request.get(`${origin.origin}/v1/auth/session`, { maxRedirects: 0 });
      assert.equal((await session.json()).user?.id, 'compose-fixture-user');
      authenticatedFixture = true;
      page = await context.newPage();
      page.on('pageerror', error => result.pageErrors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: result.cpuSlowdown });
      await page.route(url => url.origin === origin.origin && url.pathname === '/v1/threads/first-thread', async route => {
        const response = await route.fetch({ maxRedirects: 0 }); assert(response.ok());
        const detail = await response.json();
        assert.equal(detail.account.id, 'first'); assert.equal(detail.thread.id, 'first-thread'); assert.equal(detail.messages[0].id, 'first-message');
        const original = detail.messages[0];
        detail.messages = presentation(count).map(fields => ({ ...original, ...fields,
          ...(htmlOnly ? { bodyText: null, bodyHtml: '<h2>HTML-only review</h2><p>Keep the whole keyboard focus ring visible.</p><pre><code>' + 'wide synthetic code '.repeat(24) + '</code></pre>' } : {}),
        }));
        detail.thread.messageCount = count;
        detail.thread.subject = `Synthetic ${count}-message conversation`;
        await route.fulfill({ response, json: detail });
      });
      await page.goto(origin.origin, { waitUntil: 'networkidle' });
      const row = () => page.locator('button.message-row').filter({ hasText: 'first account conversation' });
      await row().waitFor();
      if (rendering === 'force-visible-control') await page.addStyleTag({ content: '.reader-content { content-visibility: visible !important; contain-intrinsic-block-size: none !important; }' });
      await page.evaluate(() => document.fonts.ready);
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
      async function measure(name, action, ready, clicked = true) {
        const before = await getMetrics(cdp);
        await page.evaluate(() => { window.__readerProfile.start = performance.now(); window.__readerProfile.longTasks = []; });
        await action(); await ready();
        await settle();
        const timing = await page.evaluate(() => ({ elapsedMs: performance.now() - window.__readerProfile.start, longTasks: window.__readerProfile.longTasks }));
        const after = await getMetrics(cdp);
        scenario.samples.push({ name, clock: clicked ? 'captured-click-to-settled-frames' : 'command-start-to-settled-frames', ...timing,
          ...Object.fromEntries(metricNames.map(key => [`${key}Ms`, (after[key] - before[key]) * 1000])) });
      }
      for (let sample = 0; sample < sampleCount; sample++) {
        await measure('open-reader', () => row().click(), () => page.locator('.reader-body-html').nth(count - 1).waitFor({ state: 'attached' }));
        assert.equal(await page.locator('.reader-message').count(), count);
        assert.equal(await page.locator('#reader-title').innerText(), `Synthetic ${count}-message conversation`);
        if (sample === 0) {
          scenario.domNodes = await page.locator('*').count();
          const name = `profile-${count}-${theme}-${rendering}-reader.png`;
          await page.screenshot({ path: join(out, name) }); screenshots.push(name);
        }
        await measure('plain-text', () => page.getByRole('button', { name: 'Plain text', exact: true }).first().click(), () => page.locator('.reader-body-plain').first().waitFor());
        await measure('formatted', () => page.getByRole('button', { name: 'Formatted', exact: true }).first().click(), () => page.locator('.reader-formatted-region').first().waitFor());
        if (count > 1) {
          await measure('jump-newest', () => page.getByRole('button', { name: 'Jump to newest', exact: true }).click(), async () => {
            await page.waitForFunction(() => document.activeElement?.getAttribute('aria-labelledby') === 'reader-sender-profile-message-59');
          });
          await measure('jump-top', () => page.getByRole('button', { name: 'Jump to top', exact: true }).click(), async () => {
            await page.waitForFunction(() => document.activeElement?.id === 'reader-title');
          });
        }
        await measure('close-reader', () => page.locator('.reader-back').click(), () => row().waitFor());
        assert.equal(new URL(page.url()).searchParams.has('thread'), false);
      }
      // Exercise the complete, still-mounted content in a long conversation.
      // User-agent find and focusing a link must reveal skipped bodies. None of
      // these checks may force every offscreen body's layout before profiling.
      if (count > 1) {
        await row().click(); await page.locator('.reader-body-html').nth(count - 1).waitFor({ state: 'attached' });
        const allText = await page.locator('.reader-message-list').textContent();
        for (let index = 1; index <= count; index++) assert(allText.includes(`End of review ${index}`));
        const found = await page.evaluate(() => {
          window.getSelection()?.removeAllRanges();
          return window.find('End of review 37');
        });
        assert(found, 'Browser find must include offscreen content');
        await settle();
        await page.waitForFunction(() => {
          const selection = window.getSelection();
          if (!selection?.rangeCount) return false;
          const rect = selection.getRangeAt(0).getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        }, null, { timeout: 2500 }).catch(() => {});
        const selection = await page.evaluate(() => {
          const selection = window.getSelection(); const rect = selection.getRangeAt(0).getBoundingClientRect();
          return { text: selection.toString(), top: rect.top, bottom: rect.bottom, height: innerHeight, workspaceScrollTop: document.querySelector('.desktop-workspace')?.scrollTop, windowScrollY: scrollY };
        });
        scenario.findSelection = selection;
        assert.equal(selection.text, 'End of review 37');
        assert(selection.bottom > 0 && selection.top < selection.height, 'Find must scroll matched content into view');
        const link = page.locator('.reader-message').nth(48).locator('.reader-body-html a').first();
        await link.focus(); await settle();
        assert(await link.evaluate(element => document.activeElement === element), 'An offscreen body link must accept keyboard focus');
        assert(await link.isVisible(), 'Focusing a link must reveal its body');
        const focusedLink = await link.evaluate(element => {
          const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight };
        });
        assert(focusedLink.bottom > 0 && focusedLink.top < focusedLink.height, 'Focused offscreen link must scroll into view');
        // The remembered size must adapt after an image decodes and reader text
        // grows. This adds a synthetic in-memory image to the mounted HTML DOM;
        // it never loads external pixels or rewrites the production sanitizer.
        await page.locator('.reader-message').first().scrollIntoViewIfNeeded();
        const resized = await page.locator('.reader-content').first().evaluate(async element => {
          const before = element.getBoundingClientRect().height;
          const image = document.createElement('img'); image.alt = 'Synthetic delayed image';
          image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#bfdad3"/></svg>');
          element.querySelector('.reader-body-html').append(image); await image.decode();
          document.documentElement.dataset.readerSize = 'large';
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { before, after: element.getBoundingClientRect().height, imageHeight: image.getBoundingClientRect().height };
        });
        assert(resized.after > resized.before && resized.imageHeight > 0, 'Late image/font-size changes must expand the measured body');
        const imageNode = await page.locator('img[alt="Synthetic delayed image"]').elementHandle();
        await page.getByRole('button', { name: 'Jump to newest', exact: true }).click(); await settle();
        await page.getByRole('button', { name: 'Jump to top', exact: true }).click(); await settle();
        assert(await imageNode.evaluate(element => element.isConnected && element.complete), 'Offscreen revisits must retain loaded image identity');
        await page.evaluate(() => { document.documentElement.dataset.readerSize = 'standard'; });
        await imageNode.dispose();
        const name = `profile-${count}-${theme}-${rendering}-resized.png`;
        await page.screenshot({ path: join(out, name) }); screenshots.push(name);
        await page.emulateMedia({ media: 'print' });
        assert.equal(await page.locator('.reader-content').last().evaluate(element => getComputedStyle(element).contentVisibility), 'visible', 'Print must render complete messages');
        await page.emulateMedia({ media: 'screen' });
        await page.locator('.reader-back').click(); await row().waitFor();
      }
      // Browser history and selection must still restore the originating list.
      await row().click(); await page.locator('.reader-body-html').first().waitFor();
      await measure('history-back', () => page.goBack(), () => row().waitFor(), false);
      await measure('history-forward', () => page.goForward(), () => page.locator('.reader-body-html').first().waitFor(), false);
      await page.locator('.reader-back').click(); await row().waitFor();
      const select = page.locator('.message-initial-select').first();
      await measure('select-conversation', () => select.click(), () => page.locator('.bulk-selection-exit').waitFor());
      await measure('clear-selection', () => page.getByRole('button', { name: 'Clear selection and exit' }).click(), () => page.locator('.bulk-selection-exit').waitFor({ state: 'hidden' }));
      await measure('open-compose', () => page.getByRole('button', { name: /^Compose(?:\s+C)?$/ }).first().click(), () => page.locator('.compose-workspace-panel').waitFor());
      await measure('close-compose', () => page.keyboard.press('Escape'), () => page.locator('.compose-workspace-panel').waitFor({ state: 'hidden' }), false);
      if (count === 1) {
        htmlOnly = true;
        await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`, { waitUntil: 'networkidle' });
        const region = page.locator('.reader-formatted-region'); await region.waitFor();
        assert.equal(await page.locator('.reader-display-controls').count(), 0);
        await region.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        assert(await region.evaluate(element => element === document.activeElement && element.matches(':focus-visible')));
        scenario.htmlOnlyFocusPaint = await assertFocusPaint(region);
        const name = `profile-${count}-${theme}-${rendering}-html-only-focus.png`;
        await page.screenshot({ path: join(out, name) }); screenshots.push(name);
      }
      for (const name of new Set(scenario.samples.map(sample => sample.name))) {
        const samples = scenario.samples.filter(sample => sample.name === name);
        scenario.summary[name] = { samples: samples.length, ...Object.fromEntries(['elapsedMs', ...metricNames.map(key => `${key}Ms`)].map(key => [key, { p50: percentile(samples.map(sample => sample[key]), .5), p95: percentile(samples.map(sample => sample[key]), .95) }])) };
      }
      scenario.status = 'passed';
    } catch (error) {
      scenario.status = 'failed'; scenario.error = error.stack;
      if (page) { const name = `profile-${count}-${theme}-${rendering}-failure.png`; await page.screenshot({ path: join(out, name) }).then(() => screenshots.push(name)).catch(() => {}); }
      if (!authenticatedFixture) throw Object.assign(error, { readerProfile: result });
    } finally { await context.close(); }
  }
  if (result.scenarios.some(scenario => scenario.status !== 'passed')) throw Object.assign(new Error('Reader profile scenarios failed; see interactionProfile.scenarios'), { readerProfile: result });
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.blockedWrites, []);
  return result;
}
