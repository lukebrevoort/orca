import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const [origin, out] = process.argv.slice(2);
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const result = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), cases: [], failures: [] };
const check = (ok, message) => { if (!ok) result.failures.push(message); };
try {
  for (const theme of ['light', 'dark']) for (const failure of ['unavailable', 'server', 'offline']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(t => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme: t, motion: 'reduced' })), theme);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/v1/auth/outlook/connect') {
        if (failure === 'offline') return route.abort();
        return route.fulfill({ status: failure === 'unavailable' ? 503 : 500, contentType: 'application/json', body: JSON.stringify({ error: { code: failure === 'unavailable' ? 'provider_unavailable' : 'internal_error' } }) });
      }
      return url.pathname.startsWith('/v1/') ? route.abort() : route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/dev/settings`);
    const signature = page.getByRole('textbox', { name: 'Default signature' });
    const dialog = page.getByRole('dialog', { name: 'Leave without saving account choices?' });
    await signature.fill(`Unsaved ${theme} ${failure}`);
    await page.locator('.desktop-compose').click();
    await dialog.waitFor();
    await page.getByRole('button', { name: 'Stay in Settings', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await signature.evaluate(el => el === document.activeElement), `${theme}/${failure}: Stay returns focus to edited signature`);
    await page.getByRole('button', { name: 'Connect Outlook', exact: true }).click();
    // The reviewed candidate asks before the asynchronous request can fail.
    if (await dialog.isVisible()) await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await page.locator('.settings-outlook-error').waitFor();
    check(await signature.inputValue() === `Unsaved ${theme} ${failure}`, `${theme}/${failure}: failed authorization preserves signature`);
    check(await page.getByRole('button', { name: 'Save account choices', exact: true }).isEnabled(), `${theme}/${failure}: failed authorization keeps Save enabled`);
    await signature.focus();
    await page.locator('.desktop-compose').click();
    const protectedAfterFailure = await dialog.isVisible();
    check(protectedAfterFailure, `${theme}/${failure}: navigation remains guarded after failed authorization`);
    await page.screenshot({ path: `${out}/${theme}-${failure}.png` });
    result.cases.push({ theme, failure, protectedAfterFailure });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(`${out}/results.json`, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result, null, 2));
assert.equal(result.failures.length, 0);
