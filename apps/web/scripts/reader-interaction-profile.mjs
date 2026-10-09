/** Hosted-only measurements on synthetic production-reader data.
 * Uses the existing authenticated, loopback-only fixture. No send, provider,
 * real account, profile, or production data is involved. CDP durations are
 * cumulative main-thread seconds; interaction samples use in-page pointer/keyboard input to
 * settled animation frames rather than Playwright command round trips.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installNativeFindInputGuard } from './native-find-input-guard.mjs';
const run = promisify(execFile);

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
  assert(process.env.ORCA_READER_NATIVE_FIND === '1' && process.env.DISPLAY, 'Native Find requires this hosted job’s private Xvfb display');
  const result = { findCoverage: 'window.find selection diagnostics plus real Chromium Ctrl+F via owned hosted display', syntheticOnly: true, sampleCount, cpuSlowdown: 4, scenarios: [], pageErrors: [], blockedWrites: [] };
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
        for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { window.__readerProfile.start = performance.now(); }, true);
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
      const applyRenderingOverride = () => rendering === 'force-visible-control' ? page.addStyleTag({ content: '.reader-content { content-visibility: visible !important; contain-intrinsic-block-size: none !important; }' }) : Promise.resolve();
      await applyRenderingOverride();
      await page.evaluate(() => document.fonts.ready);
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())))));
      async function measure(name, action, ready, clicked = true) {
        const before = await getMetrics(cdp);
        await page.evaluate(() => { window.__readerProfile.start = performance.now(); window.__readerProfile.longTasks = []; });
        await action(); await ready();
        await settle();
        const timing = await page.evaluate(() => ({ elapsedMs: performance.now() - window.__readerProfile.start, longTasks: window.__readerProfile.longTasks }));
        const after = await getMetrics(cdp);
        scenario.samples.push({ name, clock: clicked ? 'captured-pointer-or-keydown-to-settled-frames' : 'command-start-to-settled-frames', ...timing,
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
        const activeCard = page.locator('.reader-message').last();
        assert.equal(await activeCard.locator('.reader-card-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('.reader-card-toggle[aria-expanded="true"]').count(), 1, 'Opening an all-read conversation expands only its latest message');
        await measure('plain-text', () => activeCard.getByRole('button', { name: 'Plain text', exact: true }).click(), () => activeCard.locator('.reader-body-plain').waitFor());
        await measure('formatted', () => activeCard.getByRole('button', { name: 'Formatted', exact: true }).click(), () => activeCard.locator('.reader-formatted-region').waitFor());
        if (count > 1) {
          // The latest-only entry has no redundant jump. Reveal history and
          // move to the header before measuring the contextual latest shortcut.
          await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
          await page.getByRole('button', { name: 'Expand all', exact: true }).click();
          await page.locator('#reader-title').scrollIntoViewIfNeeded();
          await page.waitForFunction(() => {
            const button = [...document.querySelectorAll('.reader-context-jumps button')].find(node => node.textContent.startsWith('Jump to latest'));
            const bounds = button?.getBoundingClientRect();
            return button && !button.hidden && bounds.height >= 44 && bounds.top >= 0 && bounds.bottom <= innerHeight;
          });
          await measure('jump-newest', () => page.getByRole('button', { name: 'Jump to latest', exact: true }).click(), async () => {
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
        // Whole-thread search/focus operates on the explicitly expanded view.
        await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
        await page.getByRole('button', { name: 'Expand all', exact: true }).click();
        assert.equal(await page.locator('.reader-card-toggle[aria-expanded="true"]').count(), count);
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
        // The JS API selects offscreen text but does not scroll this nested
        // reader in either rendering mode (paired diagnostic run 37359232945).
        // Native Ctrl+F uses Chromium TextFinder's separate activation path;
        // verify that real capability with OS keys on our isolated CI display.
        scenario.findSelection.revealed = selection.bottom > 0 && selection.top < selection.height;
        await page.evaluate(() => {
          window.getSelection()?.removeAllRanges();
          document.querySelector('.desktop-workspace').scrollTop = 0;
        });
        await settle();
        scenario.nativeFindBefore = await page.locator('.reader-message').nth(36).evaluate(element => ({
          top: element.getBoundingClientRect().top, height: innerHeight,
          workspaceScrollTop: document.querySelector('.desktop-workspace').scrollTop,
        }));
        assert(scenario.nativeFindBefore.top > scenario.nativeFindBefore.height && scenario.nativeFindBefore.workspaceScrollTop === 0, 'Native Find must start with its target offscreen');
        await page.bringToFront();
        const windows = (await run('xdotool', ['search', '--onlyvisible', '--class', '[Cc]hrom'])).stdout.trim().split(/\s+/);
        const title = await page.title(); const matches = [];
        for (const id of windows) if ((await run('xdotool', ['getwindowname', id])).stdout.trim().includes(title)) matches.push(id);
        assert.equal(matches.length, 1, 'Native input requires exactly one owned Chromium window for this synthetic page');
        await run('xdotool', ['windowfocus', '--sync', matches[0]]);
        await page.waitForFunction(() => document.hasFocus());
        // document.hasFocus() did not provide a usable native Find readiness
        // signal in paired hosted runs, so do not use it to authorize typing.
        // Protect the app from misdirected OS keys instead, then validate the
        // actual matched text/scroll. Native Find input never reaches this guard.
        await page.evaluate(installNativeFindInputGuard);
        scenario.nativeFindAttempts = [];
        try {
          let nativeInputAccepted = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            await page.evaluate(() => window.__orcaNativeFindInputGuard.reset());
            await run('xdotool', ['key', '--clearmodifiers', 'ctrl+f']);
            await settle();
            await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a']);
            await run('xdotool', ['type', '--clearmodifiers', '--delay', '1', 'End of review 37']);
            await settle();
            const input = await page.evaluate(() => window.__orcaNativeFindInputGuard.snapshot());
            scenario.nativeFindAttempts.push(input);
            if (input.blockedKeys === 0 && input.blockedInputs === 0) {
              nativeInputAccepted = true;
              break;
            }
            // The page remained untouched. Close/reset the browser Find field
            // before one bounded retry of this same native focus operation.
            await run('xdotool', ['key', '--clearmodifiers', 'Escape']);
            await settle();
          }
          assert(nativeInputAccepted, 'Native Find did not acquire keyboard input; page input was blocked');
          await page.waitForFunction(() => {
            const target = document.querySelectorAll('.reader-body-html')[36]?.lastElementChild;
            if (!target) return false;
            const rect = target.getBoundingClientRect();
            const workspace = document.querySelector('.desktop-workspace');
            return rect.bottom > (workspace?.getBoundingClientRect().top ?? 0) && rect.top < innerHeight && workspace.scrollTop > 0;
          }, null, { timeout: 10000 });
          scenario.nativeFind = await page.locator('.reader-body-html').nth(36).evaluate(element => {
            const target = element.lastElementChild; const rect = target.getBoundingClientRect();
            return { method: 'Chromium Ctrl+F through private hosted X11 display', text: target.textContent, top: rect.top, bottom: rect.bottom, height: innerHeight, workspaceScrollTop: document.querySelector('.desktop-workspace').scrollTop };
          });
          const name = `profile-${count}-${theme}-${rendering}-native-find.png`;
          await page.screenshot({ path: join(out, name) }); screenshots.push(name);
        } finally {
          try {
            await run('xdotool', ['key', '--clearmodifiers', 'Escape']);
            // Keep protection while the browser consumes asynchronous X11 input.
            await settle();
          } finally { await page.evaluate(() => window.__orcaNativeFindInputGuard?.dispose()); }
        }

        const link = page.locator('.reader-message').nth(48).locator('.reader-body-html a').first();
        await link.focus(); await settle();
        assert(await link.evaluate(element => document.activeElement === element), 'An offscreen body link must accept keyboard focus');
        assert(await link.isVisible(), 'Focusing a link must reveal its body');
        const focusedLink = await link.evaluate(element => {
          const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: innerHeight };
        });
        scenario.focusedLink = focusedLink;
        assert(focusedLink.bottom > 0 && focusedLink.top < focusedLink.height, 'Focused offscreen link must scroll into view');
        await page.keyboard.press('Tab'); await settle();
        assert(await link.evaluate(element => document.activeElement === element.closest('.reader-body-html').querySelectorAll('a')[1]), 'Tab must continue in message order');
        await page.keyboard.press('Shift+Tab'); await settle();
        assert(await link.evaluate(element => document.activeElement === element), 'Shift+Tab must return to the same link');
        const focusedName = `profile-${count}-${theme}-${rendering}-offscreen-link-focus.png`;
        await page.screenshot({ path: join(out, focusedName) }); screenshots.push(focusedName);
        // Cross the boundary out of HTML focus as well as within the body.
        for (const target of ['region', 'plain-control']) {
          await page.keyboard.press('Shift+Tab'); await settle();
          const boundaryFocus = await page.evaluate(() => {
            const element = document.activeElement; const rect = element.getBoundingClientRect();
            return { className: element.className, text: element.textContent, top: rect.top, bottom: rect.bottom, height: innerHeight };
          });
          assert(target === 'region' ? boundaryFocus.className === 'reader-formatted-region' : boundaryFocus.text === 'Plain text', `Unexpected ${target} keyboard order`);
          assert(boundaryFocus.bottom > 68 && boundaryFocus.top < boundaryFocus.height, `${target} focus must remain visible after containment changes`);
          const name = `profile-${count}-${theme}-${rendering}-${target}-focus.png`;
          await page.screenshot({ path: join(out, name) }); screenshots.push(name);
        }
        // Content focus intentionally retains exact geometry until close.
        // Start a fresh reader before testing optimized dynamic body sizing.
        await page.locator('.reader-back').click(); await row().waitFor();
        await row().click(); await page.locator('.reader-body-html').nth(count - 1).waitFor({ state: 'attached' });
        await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
        await page.getByRole('button', { name: 'Expand all', exact: true }).click();
        assert.equal(await page.locator('.reader-card-toggle[aria-expanded="true"]').count(), count);
        assert.equal(await page.locator('.reader-message-list').getAttribute('data-full-body-layout'), null);
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
        await page.getByRole('button', { name: 'Jump to latest', exact: true }).click(); await settle();
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
      await row().click(); await page.locator('.reader-body-html').last().waitFor();
      await measure('history-back', () => page.goBack(), () => row().waitFor(), false);
      await measure('history-forward', () => page.goForward(), () => page.locator('.reader-body-html').last().waitFor(), false);
      await page.locator('.reader-back').click(); await row().waitFor();
      const select = page.locator('.message-initial-select').first();
      await measure('select-conversation', () => select.click(), () => page.locator('.bulk-selection-exit').waitFor());
      await measure('clear-selection', () => page.getByRole('button', { name: 'Clear selection and exit' }).click(), () => page.locator('.bulk-selection-exit').waitFor({ state: 'hidden' }));
      await measure('open-compose', () => page.getByRole('button', { name: /^Compose(?:\s+C)?$/ }).first().click(), () => page.locator('.compose-workspace-panel').waitFor());
      await measure('close-compose', () => page.keyboard.press('Escape'), () => page.locator('.compose-workspace-panel').waitFor({ state: 'hidden' }));
      if (count === 1) {
        htmlOnly = true;
        await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`, { waitUntil: 'networkidle' });
        await applyRenderingOverride();
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
