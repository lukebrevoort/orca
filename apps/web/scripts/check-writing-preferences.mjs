/** Isolated authenticated browser checks; all /v1 traffic is mocked, no provider writes.
 * PLAYWRIGHT_MODULE points to an installed Playwright module when not local.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.WRITING_URL ?? 'http://localhost:5190';
const output = process.env.WRITING_OUTPUT ?? join(homedir(), '.local/share/opencode/screenshots');
mkdirSync(output, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const { accountFixture, inboxFixture, authSessionFixture } = JSON.parse(execFileSync('bun', ['-e', 'import {accountFixture,inboxFixture,authSessionFixture} from "./packages/shared/src/fixtures.ts"; console.log(JSON.stringify({accountFixture,inboxFixture,authSessionFixture}))'], { encoding: 'utf8' }));
const account = { ...accountFixture, capabilities: { read: true, draft: true, send: true } };
const message = { ...inboxFixture[0], subject: 'A human group note' };
const detail = {
  account,
  thread: { id: message.threadId, provider: 'gmail', providerThreadId: 'provider-thread', subject: message.subject, latestReceivedAt: message.receivedAt, messageCount: 1, labels: message.labels, participants: [message.from], readState: 'read', attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: 10 } },
  messages: [{ ...message, to: [{ name: 'Luke', email: account.email }, { name: 'Dana', email: 'dana@example.com' }], cc: [{ name: 'Anika', email: 'anika@example.com' }, { name: 'Dana duplicate', email: 'DANA@example.com' }], bcc: [], bodyText: 'Let’s keep the whole group in the conversation.', bodyHtml: null, internetMessageId: '<group@example.com>', references: [], attachments: [] }],
};
delete detail.messages[0].threadId;
const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(10000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    let prefs = { signature: 'Best, Luke', composeFormat: 'plain', replyBehavior: 'reply_all', notifyByDefault: false };
    let preferenceFailure = false;
    const drafts = new Map(); const writes = []; const sends = []; const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.type() === 'confirm' && dialog.message().startsWith('Discard this draft') ? dialog.accept() : dialog.dismiss());
    await page.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({ theme, textSize: 'standard', density: 'calm', motion: 'reduced', composeZenByDefault: false, notifyByDefault: false })), theme);
    await page.route('**/v1/**', async route => {
      const request = route.request(); const url = new URL(request.url()); const method = request.method();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/v1/auth/session') return json({ ...authSessionFixture, onboardingCompletedAt: '2026-09-20T00:00:00.000Z' });
      if (url.pathname === '/v1/preferences') {
        if (method === 'PATCH') { prefs = { ...prefs, ...request.postDataJSON() }; return json(prefs); }
        if (preferenceFailure) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Synthetic preference outage' } } });
        return json(prefs);
      }
      if (url.pathname === '/v1/me') return json(account);
      if (url.pathname === '/v1/accounts') return json({ items: [account], nextCursor: null });
      if (url.pathname === '/v1/mcp/connections') return json({ items: [] });
      if (url.pathname === '/v1/organization/views') return json({ workspaceId: 'workspace-test', workspaceRevision: 1, items: [] });
      if (url.pathname === '/v1/sync/status') return json({ accounts: [{ ...account, state: 'idle', lastSyncedAt: '2026-09-20T00:00:00.000Z', error: null }] });
      if (url.pathname === '/v1/sync/gmail') return json({});
      if (url.pathname === '/v1/destinations') return json({ revision: 1, fallbackDestinationId: 'inbox', legacyDestinationIds: { normal: 'inbox', focus: 'focus', notify: 'signals', quiet: 'quiet', hidden: 'hidden' }, destinations: ['Inbox', 'Focus', 'Signals', 'Quiet', 'Hidden'].map((name, position) => ({ id: name.toLowerCase(), name, position, isFallback: position === 0, retiredAt: null, revision: 1, notificationPreference: 'quiet', delivery: 'proposal_only', counts: { total: position === 0 ? 1 : 0, unread: 0 } })) });
      if (url.pathname === '/v1/inbox') return json({ accounts: [account], messages: [message], nextCursor: null, counts: { attention: { focus: 0, normal: 1, quiet: 0, hidden: 0, all: 1 }, classification: { likely_human: 1, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 1 } } });
      if (url.pathname.startsWith('/v1/threads/')) return json(detail);
      if (url.pathname.startsWith('/v1/drafts')) {
        const id = url.pathname.split('/')[3];
        if (url.pathname.endsWith('/send')) { sends.push(request.postDataJSON()); return json({ draftId: id, status: 'sent', providerMessageId: 'fake', providerThreadId: null, error: null }); }
        if (method === 'DELETE') { drafts.delete(id); return route.fulfill({ status: 204 }); }
        if (method === 'POST' || method === 'PATCH') {
          const content = request.postDataJSON(); writes.push(content);
          const draft = { ...content, id: id ?? `draft-${drafts.size + 1}`, accountId: account.id, revision: (drafts.get(id)?.revision ?? 0) + 1, attachments: content.attachments ?? [], deliveryStatus: 'draft', providerSyncStatus: 'synced', providerSyncError: null, providerDraftId: null, providerMessageId: null, providerThreadId: null, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' };
          drafts.set(draft.id, draft); return json(draft);
        }
        return json(id ? drafts.get(id) : [...drafts.values()]);
      }
      if (['/v1/collections', '/v1/pins', '/v1/reminders', '/v1/attention/view-settings', '/v1/agent-event-mutes'].includes(url.pathname)) return json([]);
      if (url.pathname === '/v1/reminders/view-settings') return json({ displayName: 'Later' });
      if (url.pathname === '/v1/agent-events') return json({ events: [], nextCursor: null });
      if (url.pathname === '/v1/attention/resolve') return json({ behavior: 'normal', rule: null });
      return json({ items: [], nextCursor: null });
    });
    const shots = [];
    const capture = async name => { const path = join(output, `${stamp}-bre419-${theme}-${width}-${name}.png`); await page.screenshot({ path, animations: 'disabled' }); shots.push(path); };
    const compose = async () => { await page.locator(width < 760 ? '.desktop-mobile-compose' : '.desktop-compose').click(); await page.getByRole('combobox', { name: 'Message format' }).waitFor(); };
    try {
      await page.goto(`${base}/settings`);
      await page.getByLabel('Default signature').fill('Cheers, Luke');
      await page.locator('label.preference-option').filter({ hasText: 'Rich text' }).click();
      await page.evaluate(() => { window.__writingInvalidations = 0; window.addEventListener('orca-writing-preferences-changed', () => window.__writingInvalidations++); });
      await page.getByRole('button', { name: 'Save account choices', exact: true }).click();
      await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__writingInvalidations), 1);
      await page.getByLabel('Default signature').scrollIntoViewIfNeeded(); await capture('settings-saved');
      await page.goto(base); await compose();
      const body = page.getByRole('textbox', { name: 'Message body', exact: true });
      await page.waitForFunction(() => document.querySelector('[aria-label="Message body"]')?.textContent.includes('Cheers, Luke'));
      assert.equal(await page.getByRole('combobox', { name: 'Message format' }).inputValue(), 'rich');
      assert.equal((await body.innerText()).split('Cheers, Luke').length, 2);
      await capture('new-rich-signature');
      await body.fill('**Literal words**\n\nCheers, Luke');
      await page.getByRole('combobox', { name: 'Message format' }).selectOption('plain');
      assert.equal(await page.getByRole('button', { name: 'Bold, Command B' }).isDisabled(), true);
      await page.getByRole('combobox', { name: 'Message format' }).hover();
      await page.getByRole('combobox', { name: 'Message format' }).focus();
      await capture('plain-focused-disabled-formatting');
      await page.waitForTimeout(600);
      assert.equal(writes.at(-1).body.html, null);
      await page.getByRole('button', { name: 'Close panel', exact: true }).click();
      await page.goto(`${base}/settings`);
      await page.getByLabel('Default signature').fill('Next signature');
      await page.getByRole('button', { name: 'Save account choices', exact: true }).click(); await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
      await page.goto(base); await compose();
      await page.waitForFunction(() => document.querySelector('[aria-label="Message body"]')?.textContent.includes('Literal words'));
      assert.ok((await body.innerText()).includes('Cheers, Luke')); assert.ok(!(await body.innerText()).includes('Next signature'));
      assert.equal(await page.getByRole('combobox', { name: 'Message format' }).inputValue(), 'plain');
      await capture('recovered-writing-preserved');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await compose(); await page.waitForFunction(() => document.querySelector('[aria-label="Message body"]')?.textContent.includes('Next signature'));
      await capture('next-draft-updated-signature');
      await page.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.locator('.message-row').first().click();
      await page.getByRole('button', { name: 'Reply all (default)', exact: true }).click();
      await page.getByRole('button', { name: 'Edit recipients', exact: true }).click();
      await page.waitForTimeout(600);
      assert.deepEqual(writes.at(-1).to.map(contact => contact.email), [message.from.email, 'dana@example.com']);
      assert.deepEqual(writes.at(-1).cc.map(contact => contact.email), ['anika@example.com']);
      await body.scrollIntoViewIfNeeded(); await capture('default-reply-all');
      await page.getByRole('button', { name: 'Reply', exact: true }).click();
      await page.waitForTimeout(600);
      assert.deepEqual(writes.at(-1).to.map(contact => contact.email), [message.from.email]);
      assert.deepEqual(writes.at(-1).cc, []);
      await body.scrollIntoViewIfNeeded(); await capture('explicit-reply');
      preferenceFailure = true; drafts.clear();
      await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('orca-compose-draft:')) localStorage.removeItem(key); });
      await page.goto(base); await compose();
      await page.getByText('Writing defaults unavailable. New drafts use plain text without a signature.').waitFor();
      await body.fill('Still free to write'); await capture('defaults-unavailable');
      assert.equal(await page.getByRole('combobox', { name: 'Message format' }).inputValue(), 'plain');
      assert.equal(sends.length, 0);
      assert.deepEqual(errors, []);
      results.push({ theme, width, settingsInvalidation: true, newDraft: true, recoveredDraftPreserved: true, nextDraftFresh: true, defaultReplyAllRecipients: true, explicitReply: true, failureTyping: true, sends: sends.length, screenshots: shots });
      console.log(`PASS ${theme} ${width}`);
    } catch (error) {
      writeFileSync(join(output, `${stamp}-bre419-failure.txt`), await page.locator('body').innerText());
      console.error('Fixture browser failed:', { theme, width, url: page.url(), errors });
      throw error;
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
writeFileSync(join(output, `${stamp}-bre419-results.json`), JSON.stringify(results, null, 2));
