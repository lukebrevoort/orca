/** BRE-417 browser evidence. VIEW_MANAGEMENT_URL defaults to isolated port 5192.
 * PLAYWRIGHT_MODULE may point to an installed Playwright index.mjs.
 * VIEW_MANAGEMENT_OUTPUT selects screenshot output (default /tmp/bre-417).
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.VIEW_MANAGEMENT_URL ?? 'http://localhost:5192';
const output = process.env.VIEW_MANAGEMENT_OUTPUT ?? '/tmp/bre-417';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(JSON.stringify({ name: error.name, message: error.message, stack: error.stack, url: page.url() })); });
    const screenshot = async name => page.screenshot({ path: join(output, `${theme}-${width}-${name}.png`), animations: 'disabled' });
    const press = name => page.getByRole('button', { name, exact: true }).click();
    const go = async path => {
      await page.goto(`${base}${path}`); await page.locator('.desktop-workspace').waitFor();
      await page.evaluate(() => { document.documentElement.dataset.motion = 'reduced'; });
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) {
        await page.getByRole('button', { name: theme === 'dark' ? 'Switch to Orca Black' : 'Switch to Light', exact: true }).click();
      }
      // Isolate the UI capture from Chromium's native cross-document cancellation.
      // Unchanged Settings → All Mail also emits AbortError with navigation:auto.
      await page.addStyleTag({ content: '@view-transition { navigation: none; }' });
    };
    const tools = async () => {
      if (width < 760) { await page.locator('.desktop-mobile-more').click(); await page.getByRole('menuitem', { name: 'Customize tools', exact: true }).click(); }
      else await press('Customize tools');
    };
    try {
      await go('/dev/inbox?destination=view%3Aview_weekly_production');
      await page.getByRole('heading', { name: 'Weekly production review', exact: true }).waitFor();
      if (width < 760) { await page.locator('.desktop-mobile-more').click(); await page.getByRole('menuitem', { name: 'Weekly production review, saved view' }).scrollIntoViewIfNeeded(); await page.getByRole('menuitem', { name: 'Weekly production review, saved view' }).focus(); }
      else await page.getByRole('button', { name: 'Weekly production review, saved view' }).focus();
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await screenshot('active-navigation-focus');
      if (width < 760) await page.keyboard.press('Escape');
      await tools();
      const row = page.locator('.desktop-space-list article').filter({ hasText: 'Weekly production review' });
      await row.getByRole('button', { name: 'Hide', exact: true }).click();
      // Hiding the active shortcut safely returns to Inbox and closes customization.
      await tools();
      const hidden = page.locator('.desktop-hidden-space-row').filter({ hasText: 'Weekly production review' });
      assert.equal(await hidden.getByRole('button', { name: 'Delete Weekly production review', exact: true }).isDisabled(), true);
      await hidden.getByRole('button', { name: 'Edit Weekly production review', exact: true }).focus();
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      await hidden.getByRole('button', { name: /Restore/ }).hover();
      await screenshot('hidden-edit-restore-disabled');
      await hidden.getByRole('button', { name: 'Edit Weekly production review', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Edit Weekly production review', exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('section'), 'views');
      assert.equal(new URL(page.url()).searchParams.get('editView'), 'view_weekly_production');
      await screenshot('direct-edit');
      await tools();
      await page.locator('.desktop-hidden-space-row').filter({ hasText: 'Weekly production review' }).getByRole('button', { name: /Restore/ }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      // Missing bookmarks recover into Views, preserving the search context.
      await go('/dev/inbox?destination=view%3Amissing&q=maya');
      await press('Browse views');
      await page.locator('#organization-views:not([hidden])').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('section'), 'views');
      assert.equal(new URL(page.url()).searchParams.get('q'), 'maya');
      await screenshot('missing-recovery');
      // The unsupported target has an actual editor and keeps the source selection mounted.
      await go('/dev/inbox?destination=all&addSendersTo=view_weekly_production');
      await page.getByText('Done selecting', { exact: true }).waitFor();
      await page.locator('.message-row').first().click();
      await press('Add senders to existing View');
      await page.getByRole('button', { name: 'Edit Weekly production review', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Preview added senders', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Edit Weekly production review', exact: true }).focus();
      await screenshot('blocked-growth-edit-action');
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Edit Weekly production review', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Return to selected senders', exact: true }).focus();
      await screenshot('growth-edit-source-return');
      const nameField = page.getByRole('textbox', { name: /View name/ });
      await nameField.fill('Unsaved source-preserving edit');
      await press('Return to selected senders');
      await page.getByRole('dialog', { name: 'Discard changes to this draft?' }).waitFor();
      await screenshot('growth-return-guard');
      await press('Keep editing');
      assert.equal(await nameField.inputValue(), 'Unsaved source-preserving edit');
      await press('Return to selected senders'); await press('Discard draft');
      assert.equal(await page.getByRole('combobox', { name: 'Saved View to grow' }).inputValue(), 'view_weekly_production');
      await press('Cancel');
      assert.equal(await page.locator('.message-row[aria-pressed=true]').count(), 1);
      await screenshot('selected-source-returned');
      await go('/dev/settings');
      await page.getByRole('link', { name: 'Manage saved views →', exact: true }).waitFor();
      await page.locator('#attention').scrollIntoViewIfNeeded();
      await screenshot('settings-entry');
      await page.getByRole('link', { name: 'Manage saved views →', exact: true }).click();
      await page.locator('#organization-views:not([hidden])').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('section'), 'views');
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}: navigation, hidden edit/restore, missing recovery, growth edit/source return, Settings`);
    } catch (error) { await screenshot('failure'); throw error; }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
