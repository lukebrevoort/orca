/** BRE-418 full demo journey. Vite defaults to port 5191; no connected API fixture. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.DEMO_APP_URL ?? 'http://localhost:5191';
const output = process.env.DEMO_APP_OUTPUT ?? '/tmp/bre418-app';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const writes = []; const errors = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    const press = name => page.getByRole('button', { name, exact: true }).click();
    const capture = name => page.screenshot({ path: join(output, `${theme}-${width}-${name}.png`), animations: 'disabled' });
    const openView = async name => {
      if (width < 760) { await page.locator('.desktop-mobile-more').click(); await page.getByRole('menuitem', { name: `${name}, saved view`, exact: true }).click(); }
      else await press(`${name}, saved view`);
    };
    try {
      await page.goto(`${base}/dev/inbox`);
      await page.locator('button.message-row').first().waitFor();
      if (theme === 'dark') await press('Switch to Orca Black');
      await page.addStyleTag({ content: '@view-transition { navigation: none; }' });
      const boot = await page.evaluate(() => { window.__demoJourneyBoot = crypto.randomUUID(); return window.__demoJourneyBoot; });
      const count = await page.locator('button.message-row').count();
      assert.equal((await page.locator('.desktop-sidebar-item').filter({ hasText: /^Inbox\d+$/ }).innerText()).replace(/\s/g, ''), `Inbox${count}`);
      await capture('inbox-count');
      await press('Select'); await press('Select Mom: Dinner on Sunday?'); await press('Create sender View');
      await page.getByRole('textbox', { name: /View name/ }).fill('Family sample');
      assert.match(await page.locator('.view-scope-sentence').innerText(), /family@example.com/);
      assert.doesNotMatch(await page.locator('.view-scope-sentence').innerText(), /deploy@/);
      await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
      await capture('mom-preview'); await press('Save');
      await page.getByRole('heading', { name: 'Family sample', exact: true }).waitFor();
      const viewId = new URL(page.url()).searchParams.get('destination').slice(5);
      assert.equal(await page.locator('.saved-view-results .view-thread-row').count(), 1);
      await capture('saved');
      const savedPosition = await page.evaluate(() => history.state.__orcaViewNavigationPosition);
      await page.getByRole('link', { name: 'Add senders', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('addSendersTo'), viewId);
      assert.equal(await page.evaluate(() => history.state.__orcaViewNavigationPosition), savedPosition + 1);
      assert.match(await page.evaluate(() => history.state.__orcaSurfaceHistoryV1.signature), /"destination":"all"/);
      await press('Select Anika Lee: Design direction'); await press('Add senders to existing View');
      assert.equal(await page.getByRole('combobox', { name: 'Saved View to grow' }).inputValue(), viewId);
      await press('Preview added senders');
      assert.match(await page.locator('.selected-view-authoring').innerText(), /family@example.com/);
      assert.match(await page.locator('.selected-view-authoring').innerText(), /anika@example.com/);
      await page.getByRole('button', { name: 'Save changes', exact: true }).scrollIntoViewIfNeeded();
      await capture('grow-review'); await press('Save changes');
      await page.getByRole('heading', { name: 'Family sample', exact: true }).waitFor();
      assert.ok(await page.locator('.saved-view-results .view-thread-row').count() > 1);
      await page.goBack(); await page.getByRole('button', { name: 'Select Anika Lee: Design direction', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('addSendersTo'), viewId);
      assert.equal(await page.evaluate(() => history.state.__orcaViewNavigationPosition), savedPosition + 1);
      await page.goBack(); await page.getByRole('heading', { name: 'Family sample', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => history.state.__orcaViewNavigationPosition), savedPosition);
      await page.goForward(); await page.getByRole('button', { name: 'Select Anika Lee: Design direction', exact: true }).waitFor();
      await page.goForward(); await page.getByRole('heading', { name: 'Family sample', exact: true }).waitFor();
      await press('Edit'); await page.getByRole('textbox', { name: /View name/ }).fill('Family renamed'); await press('Save changes');
      await page.getByRole('heading', { name: 'Family renamed', exact: true }).waitFor();
      if (width < 760) await page.locator('.desktop-mobile-navigation').getByRole('button', { name: 'Inbox', exact: true }).click();
      else await page.locator('.desktop-sidebar-item').filter({ hasText: /^Inbox\d+$/ }).click();
      await openView('Family renamed');
      await page.getByRole('heading', { name: 'Family renamed', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('destination'), `view:${viewId}`);
      assert.equal(await page.evaluate(() => window.__demoJourneyBoot), boot);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await capture('reopened');
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      await page.reload(); await page.getByRole('heading', { name: 'View unavailable', exact: true }).waitFor();
      await capture('refresh-resets');
      await page.locator(width < 760 ? '.desktop-mobile-compose' : '.desktop-compose').click();
      await page.locator('input[name="to-recipient"]').fill('family@example.com');
      await page.locator('[contenteditable="true"]').first().fill('A sample message only.');
      const helper = page.locator('.compose-delivery-bar');
      assert.match(await helper.innerText(), /Demo send only — no real email is sent/);
      assert.doesNotMatch(await helper.innerText(), /Gmail has confirmed/);
      await capture('demo-send');
      await press('Send');
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}: count/create/grow/edit/reopen/session-reset; no API writes`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
