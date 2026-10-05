/** Diagnostic-only production-build gates. Never run this browser locally.
 * Both bundles use the same synthetic API/data; external requests stay blocked.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only in the authorized isolated hosted workflow');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a disposable GitHub-hosted runner');
const sourceSha = 'd9a70ed6131c170cb2c746cc9af97a9b3bb62987';
assert.equal(process.env.PR217_PRODUCT_SHA, sourceSha, 'Workflow and diagnostic product pins must match');
const baselineSha = '24c0de70a9371191485210f7acd4ce8bc7ab54d8';
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/, 'An exact integrated product SHA is required');
assert.equal(process.env.PR217_BASELINE_SHA, baselineSha);
execFileSync('git', ['merge-base', '--is-ancestor', baselineSha, sourceSha]);
execFileSync('git', ['diff', '--exit-code', sourceSha, 'HEAD', '--', '.',
  ':(exclude).github/workflows/mobile-web-217-screenshots.yml',
  ':(exclude)apps/api/scripts/mobile-web-217-fixture.ts',
  ':(exclude)apps/web/scripts/mobile-web-217-screenshots.mjs']);
assert(process.env.RUNNER_TEMP && process.argv[2], 'Hosted temporary and output directories are required');
const runnerRoot = await realpath(process.env.RUNNER_TEMP);
const baselineRoot = join(runnerRoot, 'mobile217-baseline-source');
assert.equal(execFileSync('git', ['-C', baselineRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineSha);
const out = resolve(process.argv[2]);
assert.equal(out, join(runnerRoot, 'mobile-web-217-evidence'), 'Export only to the task-owned evidence directory');
await mkdir(out, { recursive: false, mode: 0o700 });
const work = await mkdtemp(join(runnerRoot, 'mobile217-private-'));
const fixedTime = '2026-10-05T12:00:00.000Z';
const initialDraft = {
  subject: 'A quieter inbox',
  body: 'Hi Maya,\n\nHere is the latest mobile direction. I would love your thoughts on the inbox and writing space.\n\nAlex',
  to: ['maya@example.com'], cc: [], bcc: [],
};
const longCc = 'design-review-team-with-a-long-address@example.com';
const longBcc = 'independent-accessibility-review-group@example.com';
const desktopStages = ['inbox', 'compose', 'compose-long-recipients', 'zen', 'settings'];
const results = {
  sourceSha, baselineSha,
  diagnosticSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  syntheticOnly: true, platform: 'Chromium mobile web; not native iOS',
  startedAt: new Date().toISOString(), fixedContentTime: fixedTime,
  cases: [], desktopComparisons: [], pageErrors: [], blockedOrigins: [],
  baselineMethod: 'Separate pinned-main and integrated-PR production web builds; identical candidate synthetic API fixture, mail, date origin, locale, viewport and fallback fonts',
  clockMethod: 'Date-only offset from a common synthetic epoch; Date advances normally and all native timer, performance, animation-frame and AbortSignal APIs are untouched',
  desktopDiffPolicy: { maximumChannelDelta: 16, maximumChangedPixelRatio: 0.003, geometricToleranceCssPx: 1 },
  limitations: [
    'All external browser requests, including Google Fonts, are blocked. Screenshots use installed fallback fonts; production webfont appearance is not verified.',
    'The 400px viewport checks available layout height, not a real software keyboard, Safari, native iOS, device safe areas or hardware.',
    'The desktop baseline compares web bundles against the same synthetic API; it is not an independent baseline backend regression test.',
    'Pixel/geometry gates cover five selected desktop surfaces. They do not establish full release, accessibility or cross-browser sign-off.',
    'No real mail, deployment, sending, credentials, browser traces, database files or storage exports are included.',
  ],
};
const fixtures = [];
let browser;
async function poll(fn, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
function safeError(error) {
  let message = String(error?.message ?? error);
  for (const fixture of fixtures) if (fixture.token) message = message.replaceAll(fixture.token, '[ephemeral credential removed]');
  return message;
}
async function startFixture(variant) {
  const child = spawn('bun', ['--no-env-file', 'apps/api/scripts/mobile-web-217-fixture.ts'], {
    env: { ...process.env, TMPDIR: work, MOBILE217_WEB_VARIANT: variant }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixture = { child, variant, token: null, processError: null, origin: null };
  fixtures.push(fixture);
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  // Drain private logs without exporting error strings that might contain a session.
  child.stderr.resume();
  child.on('error', error => { fixture.processError = error.code ?? 'spawn error'; });
  const connectionFile = await poll(() => {
    assert.equal(fixture.processError, null, `Could not start ${variant} fixture`);
    assert.equal(child.exitCode, null, `${variant} fixture exited before it was ready`);
    return stdout.split('\n').map(line => line.trim()).find(line => line.endsWith('/connection.json'));
  }, `${variant} fixture did not become ready`);
  assert(connectionFile.startsWith(work + sep), 'Connection metadata must stay in private task storage');
  const metadata = JSON.parse(await readFile(connectionFile, 'utf8'));
  fixture.token = metadata.token;
  const url = new URL(metadata.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.protocol, 'http:');
  fixture.origin = url.origin;
  return fixture;
}
async function request(context, fixture, method, path, data) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  const response = await context.request[method](fixture.origin + path, { data, maxRedirects: 0 });
  assert(response.ok(), `Synthetic ${method.toUpperCase()} ${path.split('?')[0]} failed (${response.status()})`);
  return response;
}
async function prepare(context, fixture) {
  const login = await context.request.get(fixture.origin + '/__fixture/login', { maxRedirects: 0 });
  assert.equal(login.status(), 302);
  assert.equal(login.headers().location, '/');
  const session = await request(context, fixture, 'get', '/v1/auth/session');
  assert.equal((await session.json()).user?.id, 'compose-fixture-user');
  await request(context, fixture, 'patch', '/v1/preferences?include=first_view_guidance', { firstViewGuidanceCompletedAt: fixedTime });
  const drafts = await request(context, fixture, 'get', '/v1/drafts?accountId=first');
  for (const draft of await drafts.json()) await request(context, fixture, 'delete', `/v1/drafts/${encodeURIComponent(draft.id)}?accountId=first`);
}
async function geometry(page) {
  return page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
    theme: document.documentElement.dataset.theme, density: document.documentElement.dataset.readerDensity,
  }));
}
async function noOverflow(page, description) {
  const value = await geometry(page);
  assert(value.documentWidth <= value.width + 1 && value.bodyWidth <= value.width + 1, `${description}: horizontal overflow`);
  return value;
}
async function surfaceState(page, state) {
  await poll(async () => {
    const url = new URL(page.url());
    const compose = url.searchParams.get('compose') === '1';
    const zen = url.searchParams.get('zen') === '1';
    return compose === (state !== 'inbox') && zen === (state === 'zen');
  }, `History did not settle at ${state}`);
  await page.getByRole('dialog', { name: 'Zen writing mode', exact: true }).waitFor({ state: state === 'zen' ? 'visible' : 'hidden' });
  await page.locator('.compose-workspace-panel').waitFor({ state: state === 'inbox' ? 'hidden' : 'attached' });
}
async function screenshot(page, result, stage) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const file = `${result.label}-${stage}.png`;
  await page.screenshot({ path: join(out, file), animations: 'disabled', caret: 'hide', fullPage: false });
  result.screenshots[stage] = file;
}
async function resetScroll(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const selector of ['.desktop-workspace', '.panel-body', '.zen-canvas']) {
      for (const element of document.querySelectorAll(selector)) element.scrollTop = 0;
    }
  });
}
async function reachable(locator, description, { scroll = false, partial = false } = {}) {
  if (scroll) await locator.scrollIntoViewIfNeeded();
  await locator.waitFor();
  const value = await locator.evaluate((element, partial) => {
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2; const y = partial ? (Math.max(0, rect.y) + Math.min(innerHeight, rect.bottom)) / 2 : rect.y + rect.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight, receivesPointer: Boolean(top && (top === element || element.contains(top))) };
  }, partial);
  assert(value.width > 0 && value.height > 0 && value.x >= -1 && value.x + value.width <= value.viewportWidth + 1, `${description}: horizontal bounds`);
  const verticallyVisible = partial ? Math.min(value.y + value.height, value.viewportHeight) - Math.max(value.y, 0) >= 44 : value.y >= -1 && value.y + value.height <= value.viewportHeight + 1;
  assert(verticallyVisible && value.receivesPointer, `${description}: clipped or covered`);
  return value;
}
async function readableLabel(locator, description) {
  const value = await locator.evaluate(element => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const chain = []; for (let node = element; node; node = node.parentElement) chain.unshift(node);
    let background = [255, 255, 255]; let opacity = 1;
    for (const node of chain) {
      const style = getComputedStyle(node); const layer = rgba(style.backgroundColor); const alpha = layer[3] / 255;
      background = background.map((channel, i) => layer[i] * alpha + channel * (1 - alpha));
      opacity *= Number(style.opacity);
    }
    const style = getComputedStyle(element); const ink = rgba(style.color);
    const alpha = ink[3] / 255 * opacity; const foreground = background.map((channel, i) => ink[i] * alpha + channel * (1 - alpha));
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const levels = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return { text: element.textContent.trim(), color: style.color, background, opacity, contrast: (levels[0] + 0.05) / (levels[1] + 0.05) };
  });
  assert(value.text.length > 0 && value.opacity > 0, `${description}: missing visible label`);
  assert(value.contrast >= 4.5, `${description}: text contrast ${value.contrast.toFixed(2)} is below 4.5`);
  return value;
}
async function assertDraft(scope, expected) {
  assert.equal(await scope.getByRole('textbox', { name: 'Subject', exact: true }).inputValue(), expected.subject);
  const body = await scope.getByRole('textbox', { name: 'Message body', exact: true }).innerText();
  assert.equal(body.replace(/\s+/g, ' ').trim(), expected.body.replace(/\s+/g, ' ').trim(), 'Draft body must be retained');
  for (const [kind, label] of [['to', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc']]) {
    const chips = scope.getByRole('combobox', { name: `Add ${label} recipient`, exact: true }).locator('..').locator('.compose-recipient-chip > span');
    assert.deepEqual(await chips.allTextContents(), expected.recipientLabels[kind], `Retained ${label} chips changed`);
  }
}
async function assertDurableDraft(context, fixture, expected) {
  await poll(async () => {
    const response = await request(context, fixture, 'get', '/v1/drafts?accountId=first');
    const drafts = await response.json();
    return drafts.some(draft => draft.subject === expected.subject && draft.body.text.replace(/\s+/g, ' ').trim() === expected.body.replace(/\s+/g, ' ').trim()
      && ['to', 'cc', 'bcc'].every(kind => JSON.stringify(draft[kind].map(recipient => recipient.email).sort()) === JSON.stringify([...expected[kind]].sort())));
  }, 'Synthetic API did not retain the complete draft');
}
async function addRecipient(scope, kind, address) {
  const input = scope.getByRole('combobox', { name: `Add ${kind} recipient`, exact: true });
  await input.fill(address); await input.press('Enter');
}
async function waitSaved(scope) {
  try { await scope.getByText('Saved to Orca and Gmail', { exact: true }).waitFor(); }
  catch (error) {
    // Only synthetic visible status text; never cookies, request bodies or storage.
    const statuses = await scope.locator('.compose-save-status').allTextContents().catch(() => []);
    throw new Error(`Draft save did not settle; visible status: ${statuses.join(' | ') || '(none)'}. ${safeError(error)}`);
  }
}
function installAdvancingDate({ epoch }) {
  const NativeDate = globalThis.Date;
  const nativeNow = NativeDate.now.bind(NativeDate);
  const offset = new NativeDate(epoch).getTime() - nativeNow();
  function DiagnosticDate(...args) {
    if (new.target) return Reflect.construct(NativeDate, args.length ? args : [nativeNow() + offset], new.target);
    return new NativeDate(nativeNow() + offset).toString();
  }
  Object.setPrototypeOf(DiagnosticDate, NativeDate);
  DiagnosticDate.prototype = NativeDate.prototype;
  DiagnosticDate.now = () => nativeNow() + offset;
  globalThis.Date = DiagnosticDate;
}

async function recipientBounds(scope, description) {
  for (const chip of await scope.locator('.compose-recipient-chip').all()) {
    const metrics = await chip.evaluate(element => {
      const text = element.querySelector('span');
      return { scroll: element.scrollWidth, client: element.clientWidth, textScroll: text?.scrollWidth ?? 0, textClient: text?.clientWidth ?? 0 };
    });
    assert(metrics.scroll <= metrics.client + 1 && metrics.textScroll <= metrics.textClient + 1, `${description}: long recipient content overflows`);
  }
}
async function shortViewport(page, result, expected, size) {
  await page.setViewportSize({ width: size.width, height: 400 });
  const panel = page.locator('.compose-workspace-panel');
  await resetScroll(page);
  result.shortCompose = await noOverflow(page, '400px compose');
  await reachable(page.getByRole('button', { name: 'Close panel', exact: true }), '400px close compose');
  await recipientBounds(panel, '400px compose');
  await screenshot(page, result, 'short-compose-recipients');
  await reachable(panel.getByRole('textbox', { name: 'Message body', exact: true }), '400px message body', { scroll: true, partial: true });
  await reachable(panel.locator('.compose-delivery-actions button').last(), '400px delivery controls', { scroll: true });
  await screenshot(page, result, 'short-compose-controls');
  await page.getByRole('button', { name: 'Open in Zen', exact: true }).click();
  await surfaceState(page, 'zen');
  const zen = page.getByRole('dialog', { name: 'Zen writing mode', exact: true });
  await assertDraft(zen, expected); await resetScroll(page);
  result.shortZen = await noOverflow(page, '400px Zen');
  await recipientBounds(zen, '400px Zen');
  await screenshot(page, result, 'short-zen-recipients');
  await reachable(zen.locator('.compose-delivery-actions button').last(), '400px Zen delivery controls', { scroll: true });
  await screenshot(page, result, 'short-zen-controls');
  await reachable(zen.getByRole('button', { name: 'Save & close', exact: true }), '400px Zen close', { scroll: true });
  await zen.getByRole('button', { name: 'Save & close', exact: true }).click();
  await surfaceState(page, 'compose'); await assertDraft(panel, expected);
  await page.setViewportSize(size); await resetScroll(page);
  result.checks.push('400px compose/Zen: long Cc/Bcc wrap; body, delivery and close controls remain reachable; draft retained');
}
async function mobileInboxGates(page, result) {
  const active = page.locator('.desktop-mobile-navigation [aria-current="page"]').first();
  result.activeLabel = await readableLabel(active.locator('span').last(), 'Active mobile navigation');
  const select = page.getByRole('button', { name: 'Select', exact: true });
  await select.click();
  const done = page.getByRole('button', { name: 'Done selecting', exact: true });
  assert.equal(await done.getAttribute('aria-pressed'), 'true');
  result.selectionLabel = await readableLabel(done, 'Selected selection-mode control');
  const choice = page.locator('.message-initial-select').first();
  await choice.click(); assert.equal(await choice.getAttribute('aria-pressed'), 'true');
  result.selectedGlyph = await readableLabel(choice.locator('span'), 'Selected conversation checkmark');
  await resetScroll(page); await noOverflow(page, 'Selected inbox'); await screenshot(page, result, 'selection');
  await page.getByRole('button', { name: 'Clear selection and exit', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.message-initial-select[aria-pressed="true"]').count(), 0);
  const row = page.locator('.message-row').filter({ hasText: 'One more idea' });
  await row.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => ({ windowY: scrollY, workspaceY: document.querySelector('.desktop-workspace').scrollTop }));
  assert(scrollBefore.windowY + scrollBefore.workspaceY > 100, 'Inbox scroll gate must actually scroll');
  result.stickyCompose = await reachable(page.locator('.mobile-mail-compose'), 'Sticky compose after inbox scroll');
  await screenshot(page, result, 'inbox-scrolled');
  await row.click(); await page.locator('.message-reader #reader-title').filter({ hasText: 'One more idea' }).waitFor();
  await noOverflow(page, 'Message reader'); await screenshot(page, result, 'reader');
  await page.locator('.reader-back').click();
  await poll(() => !new URL(page.url()).searchParams.has('thread'), 'Reader close did not clear history');
  await row.waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const scrollAfter = await page.evaluate(() => ({ windowY: scrollY, workspaceY: document.querySelector('.desktop-workspace').scrollTop }));
  result.readerReturn = { before: scrollBefore, after: scrollAfter };
  await reachable(row, 'Returned inbox message after reader close');
  await page.goForward(); await page.locator('.message-reader #reader-title').filter({ hasText: 'One more idea' }).waitFor();
  await page.goBack(); await row.waitFor();
  await screenshot(page, result, 'reader-return'); await resetScroll(page);
  result.checks.push('Selection mode on/off and selected/active text contrast >=4.5; actual inbox scroll; sticky compose hit-test; reader close and Back/Forward return');
}
async function settingsGates(page, result, mobile) {
  const settings = page.locator('#settings-title');
  if (mobile) {
    const more = page.locator('.desktop-mobile-more');
    const menu = page.getByRole('dialog', { name: 'Navigation menu', exact: true });
    await more.click(); await menu.waitFor(); await screenshot(page, result, 'more');
    await menu.getByRole('button', { name: 'Close navigation menu', exact: true }).click(); await menu.waitFor({ state: 'hidden' });
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    await more.click(); await menu.waitFor(); await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
    await more.click(); await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  } else await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.waitFor(); assert.equal(new URL(page.url()).pathname, '/settings');
  await page.getByRole('heading', { name: 'Connected accounts', exact: true }).waitFor();
  await page.waitForLoadState('networkidle'); await resetScroll(page);
  await noOverflow(page, 'Settings'); await screenshot(page, result, 'settings');
  await page.goBack(); await page.locator('.message-row').filter({ hasText: 'A quieter place to write' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(await page.getByRole('dialog', { name: 'Navigation menu', exact: true }).count(), 0);
  await page.goForward(); await settings.waitFor(); await page.goBack();
  await page.locator('.message-row').filter({ hasText: 'A quieter place to write' }).waitFor();
  result.checks.push(mobile ? 'More close button/Escape/reopen, Settings navigation and Back/Forward without a stranded menu' : 'Settings navigation and Back/Forward');
}
async function runCase(fixture, viewport, theme, density) {
  const mobile = viewport.width < 760;
  const result = { label: `${fixture.variant}-${viewport.width}-${theme}-${density}`, variant: fixture.variant, viewport, theme, density, checks: [], screenshots: {}, draftRequests: [], draftResponses: [] };
  results.cases.push(result);
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });
  await context.addInitScript(({ theme, density }) => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, density, motion: 'reduced', composeZenByDefault: false })), { theme, density });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === fixture.origin) return route.continue();
    results.blockedOrigins.push(url.origin); return route.abort();
  });
  await context.routeWebSocket('**/*', socket => { results.blockedOrigins.push(new URL(socket.url()).origin); socket.close(); });
  await context.addInitScript(installAdvancingDate, { epoch: fixedTime });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const draftKind = value => {
    const url = new URL(value);
    if (url.origin !== fixture.origin || !/^\/v1\/drafts(?:\/|$)/.test(url.pathname)) return null;
    return url.pathname === '/v1/drafts' ? 'list' : url.pathname.endsWith('/send') ? 'send' : 'item';
  };
  page.on('request', request => { const kind = draftKind(request.url()); if (kind) result.draftRequests.push({ kind, method: request.method() }); });
  page.on('response', response => { const kind = draftKind(response.url()); if (kind) result.draftResponses.push({ kind, method: response.request().method(), status: response.status() }); });
  page.on('pageerror', error => results.pageErrors.push({ label: result.label, message: safeError(error) }));
  try {
    await prepare(context, fixture); await page.goto(fixture.origin + '/');
    await page.locator('.message-row').filter({ hasText: 'A quieter place to write' }).waitFor();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal(await page.locator('html').getAttribute('data-reader-density'), density);
    result.inbox = await noOverflow(page, 'Inbox'); await screenshot(page, result, 'inbox');
    result.fonts = await page.evaluate(() => [...document.fonts].map(font => ({ family: font.family, status: font.status })));
    result.checks.push('Requested theme/density; inbox has no horizontal overflow');
    result.timingProbe = await page.evaluate(() => new Promise(resolve => {
      const started = Date.now(); const performanceStarted = performance.now();
      setTimeout(() => resolve({ dateElapsedMs: Date.now() - started, performanceElapsedMs: performance.now() - performanceStarted }), 100);
    }));
    assert(result.timingProbe.dateElapsedMs >= 80 && result.timingProbe.performanceElapsedMs >= 80, 'Native timer and advancing Date probe failed');
    const compose = mobile ? page.locator('.mobile-mail-compose') : page.locator('.desktop-compose');
    await compose.click(); await surfaceState(page, 'compose');
    const panel = page.locator('.compose-workspace-panel');
    const expected = structuredClone(initialDraft);
    await panel.getByRole('combobox', { name: 'Message format' }).selectOption('plain');
    await addRecipient(panel, 'To', initialDraft.to[0]);
    await panel.getByRole('textbox', { name: 'Subject', exact: true }).fill(expected.subject);
    await panel.getByRole('textbox', { name: 'Message body', exact: true }).fill(expected.body);
    await waitSaved(panel); await assertDurableDraft(context, fixture, expected);
    await page.getByRole('heading', { name: 'New message', exact: true }).click(); await resetScroll(page);
    result.compose = await noOverflow(page, 'Compose'); await screenshot(page, result, 'compose');
    await panel.getByRole('button', { name: 'Add Cc or Bcc', exact: true }).click();
    await addRecipient(panel, 'Cc', longCc); await addRecipient(panel, 'Bcc', longBcc);
    expected.cc.push(longCc); expected.bcc.push(longBcc);
    await waitSaved(panel); await assertDurableDraft(context, fixture, expected);
    expected.recipientLabels = {};
    for (const [kind, label] of [['to', 'To'], ['cc', 'Cc'], ['bcc', 'Bcc']]) {
      expected.recipientLabels[kind] = await panel.getByRole('combobox', { name: `Add ${label} recipient`, exact: true }).locator('..').locator('.compose-recipient-chip > span').allTextContents();
      assert.equal(expected.recipientLabels[kind].length, expected[kind].length);
    }
    await page.getByRole('heading', { name: 'New message', exact: true }).click(); await resetScroll(page);
    await noOverflow(page, 'Long recipients'); await screenshot(page, result, 'compose-long-recipients');
    await page.getByRole('button', { name: 'Open in Zen', exact: true }).click(); await surfaceState(page, 'zen');
    const zen = page.getByRole('dialog', { name: 'Zen writing mode', exact: true });
    await assertDraft(zen, expected); await resetScroll(page); await noOverflow(page, 'Zen'); await screenshot(page, result, 'zen');
    await zen.getByRole('button', { name: 'Save & close', exact: true }).click(); await surfaceState(page, 'compose');
    await assertDraft(panel, expected);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click(); await surfaceState(page, 'inbox');
    await compose.click(); await surfaceState(page, 'compose'); await assertDraft(panel, expected);
    if (mobile) await shortViewport(page, result, expected, viewport);
    // Interrupt an edit before waiting for autosave, then traverse the real browser history.
    expected.body += '\n\nThis interrupted edit must survive navigation.';
    await panel.getByRole('textbox', { name: 'Message body', exact: true }).fill(expected.body);
    await page.goBack(); await surfaceState(page, 'inbox');
    await page.goForward(); await surfaceState(page, 'compose'); await assertDraft(panel, expected);
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await page.getByRole('button', { name: 'Open in Zen', exact: true }).click(); await surfaceState(page, 'zen');
      await page.goBack(); await surfaceState(page, 'compose'); await assertDraft(panel, expected);
      await page.goForward(); await surfaceState(page, 'zen'); await assertDraft(zen, expected);
      await zen.getByRole('button', { name: 'Save & close', exact: true }).click(); await surfaceState(page, 'compose');
      await page.getByRole('button', { name: 'Close panel', exact: true }).click(); await surfaceState(page, 'inbox');
      await compose.click(); await surfaceState(page, 'compose'); await assertDraft(panel, expected);
    }
    await waitSaved(panel); await assertDurableDraft(context, fixture, expected);
    await page.reload(); await surfaceState(page, 'compose'); await assertDraft(panel, expected);
    await screenshot(page, result, 'draft-restored');
    await page.getByRole('button', { name: 'Close panel', exact: true }).click(); await surfaceState(page, 'inbox');
    result.checks.push('Complete To/Cc/Bcc/subject/body retained through Compose > Zen > Close, immediate interrupted-edit Back/Forward, two repeated history cycles and reload; API content verified');
    if (mobile) await mobileInboxGates(page, result);
    await settingsGates(page, result, mobile);
    const deliveries = await request(context, fixture, 'get', '/__fixture/deliveries'); assert.deepEqual(await deliveries.json(), [], 'No send was requested');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = safeError(error); await screenshot(page, result, 'failure').catch(() => {});
  } finally { await context.close(); }
}
async function compareDesktop() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.abort());
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage();
  try {
    for (const theme of ['light', 'dark']) for (const density of ['calm', 'compact']) {
      const cases = ['baseline', 'candidate'].map(variant => results.cases.find(item => item.variant === variant && item.viewport.width === 1440 && item.theme === theme && item.density === density));
      for (const stage of desktopStages) {
        const comparison = { theme, density, stage, status: 'failed' }; results.desktopComparisons.push(comparison);
        try {
          assert(cases.every(item => item?.screenshots[stage]), `Missing desktop ${stage} evidence`);
          const [baseline, candidate] = await Promise.all(cases.map(item => readFile(join(out, item.screenshots[stage]))));
          comparison.baseline = cases[0].screenshots[stage]; comparison.candidate = cases[1].screenshots[stage];
          const pixelResult = await page.evaluate(async ({ before, after, channelDelta }) => {
            const load = data => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Cannot decode screenshot')); image.src = `data:image/png;base64,${data}`; });
            const [a, b] = await Promise.all([load(before), load(after)]);
            if (a.width !== b.width || a.height !== b.height) throw new Error('Screenshot dimensions differ');
            const canvas = document.createElement('canvas'); canvas.width = a.width; canvas.height = a.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(a, 0, 0); const left = context.getImageData(0, 0, a.width, a.height);
            context.drawImage(b, 0, 0); const right = context.getImageData(0, 0, b.width, b.height);
            const diff = context.createImageData(a.width, a.height); let changed = 0;
            for (let i = 0; i < left.data.length; i += 4) {
              const delta = Math.max(...[0, 1, 2, 3].map(channel => Math.abs(left.data[i + channel] - right.data[i + channel])));
              const differs = delta > channelDelta; if (differs) changed += 1;
              diff.data[i] = differs ? 255 : 230; diff.data[i + 1] = differs ? 0 : 230; diff.data[i + 2] = differs ? 110 : 230; diff.data[i + 3] = 255;
            }
            context.putImageData(diff, 0, 0);
            return { width: a.width, height: a.height, changedPixels: changed, changedPixelRatio: changed / (a.width * a.height), diffPng: canvas.toDataURL('image/png').split(',')[1] };
          }, { before: baseline.toString('base64'), after: candidate.toString('base64'), channelDelta: results.desktopDiffPolicy.maximumChannelDelta });
          const { diffPng, ...metrics } = pixelResult; Object.assign(comparison, metrics);
          comparison.diff = `desktop-diff-1440-${theme}-${density}-${stage}.png`;
          await writeFile(join(out, comparison.diff), Buffer.from(diffPng, 'base64'));
          if (stage === 'inbox' || stage === 'compose') {
            for (const field of ['documentWidth', 'bodyWidth', 'width', 'height']) assert(Math.abs(cases[0][stage][field] - cases[1][stage][field]) <= results.desktopDiffPolicy.geometricToleranceCssPx, `Desktop ${stage} ${field} changed`);
          }
          assert(metrics.changedPixelRatio <= results.desktopDiffPolicy.maximumChangedPixelRatio, `Desktop ${stage} differs in ${(metrics.changedPixelRatio * 100).toFixed(3)}% of pixels`);
          comparison.status = 'passed';
        } catch (error) { comparison.error = safeError(error); }
      }
    }
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
  results.browserVersion = browser.version();
  for (const variant of ['baseline', 'candidate']) {
    const fixture = await startFixture(variant);
    const sizes = variant === 'baseline' ? [{ width: 1440, height: 1000 }] : [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 1440, height: 1000 }];
    for (const viewport of sizes) for (const theme of ['light', 'dark']) for (const density of ['calm', 'compact']) await runCase(fixture, viewport, theme, density);
  }
  await compareDesktop();
  results.status = results.cases.length === 16 && results.cases.every(item => item.status === 'passed') && results.desktopComparisons.length === 20 && results.desktopComparisons.every(item => item.status === 'passed') && results.pageErrors.length === 0 ? 'passed' : 'failed';
} catch (error) { results.status = 'failed'; results.error = safeError(error); }
finally {
  if (browser) await browser.close();
  for (const fixture of fixtures) {
    fixture.child.kill('SIGTERM');
    await new Promise(resolve => { if (fixture.child.exitCode !== null) return resolve(); fixture.child.once('exit', resolve); setTimeout(resolve, 3000); });
    if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL');
  }
  await rm(work, { recursive: true, force: true });
  results.blockedOrigins = [...new Set(results.blockedOrigins)].sort();
  results.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  // Artifact directory contains only screenshot PNGs and the token-scanned summary.
  for (const file of await readdir(out)) {
    assert(file === 'results.json' || /^[a-z0-9-]+\.png$/.test(file), 'Unexpected evidence file');
    const bytes = await readFile(join(out, file));
    if (fixtures.some(fixture => fixture.token && bytes.includes(Buffer.from(fixture.token)))) {
      await rm(out, { recursive: true, force: true }); throw new Error('Refusing evidence containing ephemeral credentials');
    }
  }
}
console.log(JSON.stringify({ status: results.status, sourceSha, baselineSha, cases: results.cases.map(({ label, status, error }) => ({ label, status, error })), desktopComparisons: results.desktopComparisons.map(({ theme, density, stage, status, error }) => ({ theme, density, stage, status, error })) }, null, 2));
if (results.status !== 'passed') process.exitCode = 1;
