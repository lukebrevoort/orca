/** Hosted-CI-only production-reader regression matrix.
 * node reader-fixture-e2e.mjs <connection.json> <evidence-directory>
 * Uses the disposable compose fixture and a new Chromium process/context, never
 * an existing profile. Inputs replace four message presentation fields and the
 * thread display title in the authenticated synthetic thread response. This does NOT test sanitization,
 * native iOS/WebKit, real provider email, or delivery. No send action is taken.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { profileReaderInteractions } from './reader-interaction-profile.mjs';

assert(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true', 'Reader browser checks run only in hosted CI; do not run against a local browser');
const [connectionFile, outputDirectory] = process.argv.slice(2);
assert(connectionFile && outputDirectory, 'connection.json and evidence directory required');
const fixture = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(fixture.url);
assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname), 'Synthetic loopback fixture required');
assert(origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash, 'A bare fixture origin is required');
const cases = JSON.parse(await readFile(new URL('./fixtures/reader-cases.json', import.meta.url), 'utf8'));
assert.deepEqual(cases.map(value => value.id), ['github-notification', 'semantic-receipt', 'quoted-plain-reply']);
const out = resolve(outputDirectory);
await mkdir(out, { recursive: true });
const results = {
  startedAt: new Date().toISOString(), syntheticOnly: true, hostedCIOnly: true,
  validationScope: 'Production web reader with post-sanitization synthetic message inputs; not API sanitization, native iOS, or real email',
  fixtureOrigin: origin.origin, expectedScenarios: 34, fullMatrixScenarios: 24, breakpointSmokeScenarios: 10, scenarios: [], screenshots: [],
  pageErrors: [], consoleErrors: [], routeErrors: [], externalRequestsBlocked: [], requests: [],
};
let browser;
let activePage;
let activeScenario;
const normalize = text => text.replace(/\s+/g, ' ').trim();
const matrix = [];
for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const textSize of ['standard', 'large']) for (const entry of cases) matrix.push({ width, theme, textSize, entry, smoke: false });
for (const width of [320, 720, 721, 760, 761]) for (const theme of ['light', 'dark']) matrix.push({ width, theme, textSize: 'standard', entry: cases[0], smoke: true });

async function poll(check, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function settle(page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return [...document.fonts].map(font => ({ family: font.family, status: font.status }));
  });
}

async function screenshot(page, name, target) {
  if (target) await target.scrollIntoViewIfNeeded();
  await settle(page);
  const filename = `${name}.png`;
  // Desktop's reader scrolls inside its own workspace. Scroll the decisive
  // content into view rather than assuming fullPage captures that scrollport.
  await page.screenshot({ path: join(out, filename), fullPage: true });
  results.screenshots.push(filename);
}

async function assertContained(page, stage) {
  const measurements = await page.evaluate(() => {
    const nodes = [document.documentElement, document.body, ...document.querySelectorAll('.desktop-workspace')];
    return nodes.map(node => ({
      element: node === document.documentElement ? 'html' : node === document.body ? 'body' : '.desktop-workspace',
      clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
      overflowX: getComputedStyle(node).overflowX,
    }));
  });
  for (const item of measurements) {
    assert(item.clientWidth > 0, `${stage}: ${item.element} has no layout width`);
    assert(item.scrollWidth <= item.clientWidth + 1, `${stage}: ${item.element} overflows horizontally: ${JSON.stringify(item)}`);
  }
  return { stage, measurements };
}

async function assertControl(button, { selected, focused = false }) {
  assert(await button.isVisible(), 'Display control must be visible');
  assert.equal(await button.getAttribute('aria-pressed'), String(selected));
  const visual = await button.evaluate(element => {
    const parse = color => {
      const values = color.match(/[\d.]+/g)?.map(Number) ?? [];
      if (values.length < 3) throw new Error(`Unsupported computed color: ${color}`);
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const over = (foreground, background) => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      return [...foreground.slice(0, 3).map((value, index) => alpha ? (value * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha : 0), alpha];
    };
    const chain = [];
    for (let node = element; node; node = node.parentElement) chain.unshift(node);
    let background = [255, 255, 255, 1];
    let opacity = 1;
    for (const node of chain) {
      const style = getComputedStyle(node);
      background = over(parse(style.backgroundColor), background);
      opacity *= Number(style.opacity);
    }
    const style = getComputedStyle(element);
    const foreground = over(parse(style.color), background);
    const luminance = rgb => rgb.slice(0, 3).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    const box = element.getBoundingClientRect();
    return {
      label: element.textContent.trim(), color: style.color, background: style.backgroundColor,
      contrast: (levels[0] + .05) / (levels[1] + .05), opacity,
      width: box.width, height: box.height, visibility: style.visibility,
      focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  assert(['Formatted', 'Plain text'].includes(visual.label), 'Control label is missing');
  assert(visual.width > 0 && visual.height >= 36 && visual.opacity >= .99 && visual.visibility === 'visible', `Hidden control label: ${JSON.stringify(visual)}`);
  assert(visual.contrast >= 4.5, `Display control needs readable text contrast: ${JSON.stringify(visual)}`);
  if (focused) assert(visual.focused && visual.focusVisible && visual.outlineStyle !== 'none' && visual.outlineWidth >= 1, `Keyboard focus must remain visible: ${JSON.stringify(visual)}`);
  return visual;
}

async function focusByKeyboard(page, button) {
  await button.scrollIntoViewIfNeeded();
  await button.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
}

async function checkQuotes(page, body, entry, name) {
  const current = body.locator('.reader-body-plain');
  await current.waitFor();
  assert((await current.innerText()).includes(entry.plainCurrentMarker), 'Current reply text is missing');
  const quote = body.locator('.reader-quoted');
  if (entry.quoteMarker) {
    assert.equal(await quote.count(), 1, 'Quoted history must have a disclosure');
    assert.equal(await quote.evaluate(node => node.open), false, 'Quoted history starts collapsed');
    const summary = quote.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await poll(() => quote.evaluate(node => node.open), 'Keyboard did not reveal quoted history');
    // The open attribute changes before ::details-content finishes revealing.
    // Wait for rendered visibility and opacity, not just the disclosure state.
    await quote.locator('div').waitFor({ state: 'visible' });
    await poll(() => quote.evaluate(node => Number(getComputedStyle(node, '::details-content').opacity) >= .99), 'Expanded quote must finish revealing');
    assert((await quote.locator('div').innerText()).includes(entry.quoteMarker), 'Quoted text was lost');
    assert((await quote.locator('div').innerText()).includes(entry.endMarker), 'End of quoted history was lost');
    assert.equal(normalize(`${await current.textContent()}\n${await quote.locator('div').textContent()}`), normalize(entry.bodyText), 'Complete plain text must survive quote splitting');
    await screenshot(page, `${name}-quoted-history`, quote);
  } else {
    assert.equal(await quote.count(), 0, 'Do not invent a quoted-history disclosure');
    assert.equal(normalize(await current.textContent()), normalize(entry.bodyText), 'Complete plain text must remain intact');
  }
}

async function checkFormatted(page, body, entry, scenario) {
  const html = body.locator('.reader-body-html');
  const region = body.locator('.reader-formatted-region');
  await html.waitFor();
  assert.equal(await region.getAttribute('role'), 'region');
  assert.equal(await region.getAttribute('aria-label'), 'Formatted message');
  assert.equal(await region.getAttribute('tabindex'), '0', 'Overflow needs a keyboard-focusable region');
  const comparison = await html.evaluate((node, expectedHTML) => {
    // Template contents are inert: preparing the expected tree must not fetch
    // fixture images or otherwise introduce a second rendering/network path.
    const template = document.createElement('template');
    template.innerHTML = expectedHTML;
    const expected = template.content;
    const snapshot = root => ({
      text: root.textContent.replace(/\s+/g, ' ').trim(),
      links: [...root.querySelectorAll('a')].map(link => ({ text: link.textContent, href: link.getAttribute('href'), target: link.getAttribute('target'), rel: link.getAttribute('rel') })),
      images: [...root.querySelectorAll('img')].map(image => ({ src: image.getAttribute('src'), alt: image.getAttribute('alt') })),
      tables: root.querySelectorAll('table').length,
      code: [...root.querySelectorAll('pre code')].map(code => code.textContent),
      deleted: [...root.querySelectorAll('del')].map(node => node.textContent),
      inserted: [...root.querySelectorAll('ins')].map(node => node.textContent),
    });
    return { actual: snapshot(node), expected: snapshot(expected) };
  }, entry.bodyHtml);
  assert.deepEqual(comparison.actual, comparison.expected, 'Formatted text, links, tables, code and diffs must remain intact');
  for (const marker of entry.formattedMarkers) assert(comparison.actual.text.includes(marker), `Missing formatted content: ${marker}`);
  assert.equal(await html.locator('pre code').count(), entry.expectedCodeBlocks);
  scenario.codeMetrics = await html.locator('pre code').evaluateAll(nodes => nodes.map(code => ({
    codeSize: Number.parseFloat(getComputedStyle(code).fontSize),
    preSize: Number.parseFloat(getComputedStyle(code.closest('pre')).fontSize),
    codeFamily: getComputedStyle(code).fontFamily, preFamily: getComputedStyle(code.closest('pre')).fontFamily,
  })));
  for (const metrics of scenario.codeMetrics) {
    assert.equal(metrics.codeSize, metrics.preSize, 'Nested code must not shrink a second time');
    assert.equal(metrics.codeFamily, metrics.preFamily, 'Code and its block must share a font family');
    assert(metrics.codeSize >= 14, `Code is too small: ${JSON.stringify(metrics)}`);
  }
  if (entry.expectedDeletedText) assert.equal(await html.locator('del').innerText(), entry.expectedDeletedText);
  if (entry.expectedInsertedText) assert.equal(await html.locator('ins').innerText(), entry.expectedInsertedText);
  if (entry.expectedReceiptTotal) {
    assert.equal(await html.locator('table caption').innerText(), 'Order details in USD');
    assert.equal(await html.locator('table thead th').count(), 3);
    assert.equal(await html.locator('table tbody tr').count(), 4);
    assert((await html.locator('table tfoot').innerText()).includes(entry.expectedReceiptTotal), 'Receipt total is missing');
  }
  scenario.formattedRegion = await region.evaluate(node => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: getComputedStyle(node).overflowX }));
  assert(['auto', 'scroll'].includes(scenario.formattedRegion.overflowX), 'Oversized content must remain scrollable');
  if (scenario.formattedRegion.scrollWidth > scenario.formattedRegion.clientWidth + 1) {
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await poll(() => region.evaluate(node => node.scrollLeft > 0), 'Keyboard cannot reach overflowing formatted content');
    await region.evaluate(node => { node.scrollLeft = 0; });
  }
  return html.innerHTML();
}

try {
  const moduleName = process.env.ORCA_PLAYWRIGHT_MODULE;
  const { chromium } = await import(moduleName?.startsWith('/') ? pathToFileURL(moduleName).href : moduleName ?? 'playwright');
  browser = await chromium.launch({ headless: true, executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined, args: ['--disable-background-networking'] });
  results.browserVersion = browser.version();
  try { results.interactionProfile = await profileReaderInteractions({ browser, origin, out, screenshots: results.screenshots }); }
  catch (error) { results.interactionProfile = error.readerProfile; throw error; }
  for (const { width, theme, textSize, entry, smoke } of matrix) {
    const name = `${entry.id}-${width}-${theme}-${textSize}${smoke ? '-smoke' : ''}`;
    const scenario = { name, case: entry.id, viewport: { width, height: width <= 760 ? 844 : 1000 }, theme, textSize, smoke, status: 'running', substitutedResponses: 0, containment: [], controls: [] };
    results.scenarios.push(scenario); activeScenario = scenario;
    const context = await browser.newContext({ viewport: scenario.viewport, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    context.setDefaultTimeout(12000);
    let authenticatedFixture = false;
    try {
      await context.addInitScript(preferences => localStorage.setItem('orca-reader-preferences', JSON.stringify(preferences)), { theme, textSize, motion: 'reduced' });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin.origin) return route.continue();
        results.externalRequestsBlocked.push({ scenario: name, origin: url.origin, path: url.pathname });
        return route.abort();
      });
      // APIRequestContext does not use browser routing. Both requests below are
      // fixed literal loopback paths, with redirects disabled and no credentials
      // copied from connection.json. Login sets only the synthetic fixture cookie.
      const login = await context.request.get(`${origin.origin}/__fixture/login`, { maxRedirects: 0 });
      assert.equal(login.status(), 302, 'Synthetic fixture login required');
      assert.equal(login.headers().location, '/', 'Unexpected fixture login destination');
      const session = await context.request.get(`${origin.origin}/v1/auth/session`, { maxRedirects: 0 });
      assert(session.ok(), 'Synthetic fixture session did not authenticate');
      assert.equal((await session.json()).user?.id, 'compose-fixture-user', 'Refusing a non-synthetic authenticated session');
      authenticatedFixture = true;
      const page = await context.newPage(); activePage = page;
      page.on('pageerror', error => results.pageErrors.push({ scenario: name, message: error.message, stack: error.stack }));
      page.on('console', message => { if (message.type() === 'error') results.consoleErrors.push({ scenario: name, text: message.text() }); });
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin.origin && url.pathname.startsWith('/v1/')) results.requests.push({ scenario: name, method: request.method(), path: url.pathname, accountId: url.searchParams.get('accountId') });
      });
      await page.route(url => url.origin === origin.origin && url.pathname === '/v1/threads/first-thread', async route => {
        try {
          const url = new URL(route.request().url());
          assert.equal(route.request().method(), 'GET');
          assert.equal(url.searchParams.get('accountId'), 'first');
          const response = await route.fetch({ maxRedirects: 0 });
          assert(response.ok(), `Fixture thread request failed: ${response.status()}`);
          const detail = await response.json();
          assert.equal(detail.account.id, 'first');
          assert.equal(detail.thread.id, 'first-thread');
          assert.equal(detail.messages.length, 1);
          assert.equal(detail.messages[0].id, 'first-message');
          assert.equal(detail.messages[0].accountId, 'first');
          // Keep every identity, recipient, attachment and threading field from
          // the real API result. Replace four message presentation fields and
          // the thread's display title so screenshots have a coherent subject.
          Object.assign(detail.messages[0], { bodyHtml: entry.bodyHtml, bodyText: entry.bodyText, subject: entry.subject, from: entry.from });
          detail.thread.subject = entry.subject;
          scenario.substitutedResponses += 1;
          await route.fulfill({ response, json: detail });
        } catch (error) {
          scenario.boundaryFailure = true;
          results.routeErrors.push({ scenario: name, message: error.message });
          await route.abort().catch(() => {});
        }
      });
      await page.goto(`${origin.origin}/?thread=first-thread&accountId=first`, { waitUntil: 'domcontentloaded' });
      const reader = page.locator('.message-reader');
      const body = reader.locator('.reader-content');
      await body.waitFor();
      assert.equal(await body.count(), 1, 'Only the selected synthetic message should be rendered');
      assert(scenario.substitutedResponses > 0, 'Production reader never received the synthetic thread');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('html').getAttribute('data-reader-size'), textSize);
      assert.equal(await reader.locator('#reader-title').innerText(), entry.subject);
      scenario.fonts = await settle(page);
      const address = reader.locator('.reader-sender-address');
      assert.equal(await address.innerText(), entry.from.email);
      assert(await address.isVisible(), 'Sender address must be visible before opening message details');
      scenario.containment.push(await assertContained(page, 'initial'));
      if (!smoke) await screenshot(page, `${name}-overview`, reader.locator('#reader-title'));
      if (smoke) {
        await checkFormatted(page, body, entry, scenario);
        scenario.containment.push(await assertContained(page, 'breakpoint-formatted'));
        await screenshot(page, `${name}-header`, reader.locator('.reader-sender'));
      } else if (entry.bodyHtml) {
        const originalHTML = await checkFormatted(page, body, entry, scenario);
        const imageAttempts = () => results.externalRequestsBlocked.filter(request => request.scenario === name && request.path === entry.remoteImagePath).length;
        if (entry.remoteImagePath) {
          await poll(() => imageAttempts() > 0, 'Synthetic remote image did not exercise the external-request blocker');
          await poll(() => body.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth === 0)), 'Synthetic image must finish blocked, never load remotely');
          scenario.imageAttemptsBeforeToggle = imageAttempts();
        }
        const originalElement = await body.locator('.reader-body-html').elementHandle();
        const originalLink = await body.locator('.reader-body-html a').first().elementHandle();
        const originalImage = entry.remoteImagePath ? await body.locator('.reader-body-html img').elementHandle() : null;
        const controls = body.locator('.reader-display-controls');
        const formatted = controls.getByRole('button', { name: 'Formatted', exact: true });
        const plain = controls.getByRole('button', { name: 'Plain text', exact: true });
        scenario.controls.push({ state: 'selected-formatted', ...await assertControl(formatted, { selected: true }) });
        scenario.controls.push({ state: 'plain-default', ...await assertControl(plain, { selected: false }) });
        await plain.hover();
        scenario.controls.push({ state: 'plain-hover', ...await assertControl(plain, { selected: false }) });
        await focusByKeyboard(page, formatted);
        scenario.controls.push({ state: 'formatted-keyboard-focus', ...await assertControl(formatted, { selected: true, focused: true }) });
        await screenshot(page, `${name}-formatted`, controls);
        if (entry.expectedCodeBlocks) await screenshot(page, `${name}-code-and-diff`, body.locator('pre'));
        if (entry.expectedReceiptTotal) await screenshot(page, `${name}-receipt-total`, body.locator('tfoot'));
        await plain.click();
        await body.locator('.reader-formatted-region').waitFor({ state: 'hidden' });
        assert.equal(await body.locator('.reader-formatted-region').getAttribute('hidden'), '', 'Plain text should hide the retained formatted region');
        assert.equal(await body.locator('.reader-body-html').innerHTML(), originalHTML, 'Hidden formatted content must remain intact');
        scenario.controls.push({ state: 'selected-plain', ...await assertControl(plain, { selected: true }) });
        await focusByKeyboard(page, plain);
        scenario.controls.push({ state: 'plain-keyboard-focus', ...await assertControl(plain, { selected: true, focused: true }) });
        await screenshot(page, `${name}-plain`, controls);
        await checkQuotes(page, body, entry, name);
        scenario.containment.push(await assertContained(page, 'plain-and-quotes'));
        await formatted.click();
        await body.locator('.reader-formatted-region').waitFor({ state: 'visible' });
        await settle(page);
        assert.equal(await body.locator('.reader-body-html').innerHTML(), originalHTML, 'Display toggle must restore exactly the same formatted DOM');
        assert(await originalElement.evaluate(node => node.isConnected && node === document.querySelector('.reader-body-html')), 'Display toggle must retain the original formatted DOM node');
        assert(await originalLink.evaluate(node => node.isConnected && node === document.querySelector('.reader-body-html a')), 'Display toggle must retain descendants without reassigning innerHTML');
        await formatted.click();
        assert.equal(await body.locator('.reader-body-html').innerHTML(), originalHTML, 'Repeated selection must not alter formatted content');
        await settle(page);
        assert(await originalLink.evaluate(node => node.isConnected && node === document.querySelector('.reader-body-html a')), 'Repeated selection must retain the original descendant link');
        if (entry.remoteImagePath) {
          scenario.imageAttemptsAfterToggle = imageAttempts();
          assert.equal(scenario.imageAttemptsAfterToggle, scenario.imageAttemptsBeforeToggle, 'Switching display must not refetch blocked remote images');
          assert(await originalImage.evaluate(node => node.isConnected && node === document.querySelector('.reader-body-html img')), 'Switching display must retain the original image element');
        }
        await originalElement.dispose();
        await originalLink.dispose();
        await originalImage?.dispose();
        scenario.containment.push(await assertContained(page, 'formatted-restored'));
      } else {
        assert.equal(await body.locator('.reader-display-controls').count(), 0, 'Text-only messages must not advertise unavailable HTML');
        await screenshot(page, `${name}-plain`, body);
        await checkQuotes(page, body, entry, name);
        scenario.containment.push(await assertContained(page, 'plain-quotes-expanded'));
      }
      const reply = reader.locator('.reader-reply-actions').getByRole('button', { name: 'Reply', exact: true });
      await reply.scrollIntoViewIfNeeded();
      assert(await reply.isVisible() && await reply.isEnabled(), 'Reply must remain available after reading/toggling');
      // Do not activate Reply: this reader-only test must not create drafts or
      // modify the compose fixture's existing delivery ledger.
      if (!smoke) await screenshot(page, `${name}-reply-available`, reply);
      assert.equal(results.routeErrors.filter(error => error.scenario === name).length, 0, 'Thread substitution failed');
      assert.equal(results.pageErrors.filter(error => error.scenario === name).length, 0, 'Browser page errors detected');
      // Opening the real app also refreshes its synthetic provider and may
      // mark the selected fixture thread read. Its transport never calls Gmail.
      const writes = results.requests.filter(request => request.scenario === name && request.method !== 'GET'
        && !(request.method === 'POST' && request.path === '/v1/sync/gmail')
        && !(request.method === 'PATCH' && request.path === '/v1/threads/first-thread/read' && request.accountId === 'first'));
      if (writes.length) scenario.boundaryFailure = true;
      assert.deepEqual(writes, [], 'Reader verification must not create drafts, send, or perform unrelated writes');
      scenario.status = 'passed';
    } catch (error) {
      scenario.status = 'failed'; scenario.error = error.stack;
      if (activePage) {
        await screenshot(activePage, `${name}-failure`).catch(() => {});
        await appendFile(join(out, 'failure-dom.txt'), `\n=== ${name} ===\n${await activePage.locator('body').innerText()}\n`).catch(() => {});
      }
      if (!authenticatedFixture || scenario.boundaryFailure) throw error;
      // Cases own separate authenticated synthetic contexts. Keep collecting
      // evidence; the aggregate gate below still fails on any scenario error.
    } finally {
      await context.close(); activePage = null;
    }
  }
  assert.equal(results.scenarios.length, results.expectedScenarios);
  results.failedScenarios = results.scenarios.filter(scenario => scenario.status !== 'passed').map(scenario => ({ name: scenario.name, error: scenario.error }));
  assert.equal(results.failedScenarios.length, 0, JSON.stringify(results.failedScenarios));
  assert.equal(results.pageErrors.length, 0, JSON.stringify(results.pageErrors));
  results.status = 'passed';
} catch (error) {
  results.status = 'failed'; results.error = error.stack;
  if (activeScenario?.status === 'running') activeScenario.status = 'failed';
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await browser?.close();
}
console.log(JSON.stringify({ status: results.status, browserVersion: results.browserVersion, completedScenarios: results.scenarios.filter(item => item.status === 'passed').length, expectedScenarios: results.expectedScenarios, pageErrors: results.pageErrors, error: results.error }, null, 2));
