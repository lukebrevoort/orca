/** Real production bundle + isolated API/SQLite. No external requests.
 * bun apps/api/scripts/feedback-queue-fixture.ts
 * ORCA_CHROMIUM_EXECUTABLE=/usr/bin/chromium node apps/web/scripts/feedback-queue-e2e.mjs <connection.json> <new-evidence-dir>
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
const [connectionFile, outputDirectory] = process.argv.slice(2);
assert(connectionFile && outputDirectory, 'Connection file and new evidence directory required');
const { url } = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(url);
assert(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/');
const out = resolve(outputDirectory);
await mkdir(out, { recursive: false });
const results = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), dirty: Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()), startedAt: new Date().toISOString(), syntheticOnly: true, scenarios: [], pageErrors: [], externalRequestsBlocked: [], controls: [] };
const browser = await chromium.launch({ executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined, headless: true });
results.browser = browser.version();
let current;
let stage = "start";
async function poll(check, description) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(description);
}
async function api(context, path, method = 'GET', body) {
  const response = await context.request.fetch(url + path, { method, data: body, headers: { origin: url } });
  assert(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function screenshot(page, name) { await page.screenshot({ path: join(out, name + '.png'), fullPage: true }); }
async function contextFor(theme, width) {
  const context = await browser.newContext({ viewport: {width,height:1000}, colorScheme: theme, serviceWorkers:'block' });
  await context.addInitScript(theme => localStorage.setItem('orca-reader-preferences', JSON.stringify({theme,motion:'reduced'})), theme);
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin === origin.origin) return route.continue();
    results.externalRequestsBlocked.push(target.origin); return route.abort();
  });
  const page = await context.newPage(); current = page;
  page.on('pageerror', error => results.pageErrors.push({message:error.message,stack:error.stack,url:page.url(),stage}));
  page.on('dialog', dialog => dialog.accept());
  return {context,page};
}
try {
  for (const [theme, user] of [['light','first'],['dark','second']]) {
    const {context,page} = await contextFor(theme,1440);
    stage = theme + ': login';
    await page.goto(url + '/__fixture/login?user=' + user, {waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Feedback',exact:true}).waitFor();
    await page.getByText('Your first report will appear here once it’s saved.').waitFor();
    assert.equal((await api(context,'/v1/feedback/queue')).items.length,0,'Own-user queue initially empty');
    assert(await page.getByRole('button',{name:'Send feedback',exact:true}).isDisabled());
    await screenshot(page,`${theme}-desktop-empty`);
    await page.getByLabel('Short title').fill(`${theme}: Make the next step clear`);
    await page.getByLabel('Tell us more').fill('Synthetic feedback: keep the next action visible without leaving my place.');
    await page.getByLabel('Type',{exact:true}).selectOption('idea');
    const send = page.getByRole('button',{name:'Send feedback',exact:true});
    await send.hover(); await screenshot(page,`${theme}-desktop-hover`);
    await send.focus(); await screenshot(page,`${theme}-desktop-focus`);
    // Lose the response AFTER the real server commits, while retaining the request ID.
    let firstId;
    let releaseSubmission;
    const submissionHeld = new Promise(resolve => { releaseSubmission = resolve; });
    let count = 0;
    await page.route('**/v1/feedback/queue',async route => {
      if (route.request().method() !== 'POST') return route.continue();
      count++;
      const body = route.request().postDataJSON();
      if (!firstId) {
        firstId = body.id;
        const response = await route.fetch(); assert.equal(response.status(),201);
        await submissionHeld;
        return route.abort('failed');
      }
      assert.equal(body.id,firstId,'Retry must use original report ID');
      return route.continue();
    });
    await api(context,'/__fixture/delivery','POST',{outcome:'failure'});
    await send.evaluate(button => { button.click(); button.click(); });
    await page.getByRole('button',{name:'Saving feedback…',exact:true}).waitFor();
    await screenshot(page,`${theme}-desktop-saving`); releaseSubmission();
    await page.getByRole('button',{name:'Retry submission',exact:true}).waitFor();
    assert.equal(count,1,'Rapid duplicate click produces one submission');
    assert.equal((await api(context,'/v1/feedback/queue')).items.length,1,'Lost response was persisted once');
    assert.equal(await page.getByLabel('Short title').inputValue(),`${theme}: Make the next step clear`);
    await screenshot(page,`${theme}-desktop-uncertain`);
    await page.getByRole('button',{name:'Retry submission',exact:true}).click();
    await page.getByText('Feedback saved. It is queued in Orca.').waitFor();
    assert.equal((await api(context,'/v1/feedback/queue')).items.length,1);
    assert.equal(count,2);
    stage = theme + ': reload saved queue';
    await page.reload({waitUntil:'networkidle'});
    await page.getByRole('heading',{name:`${theme}: Make the next step clear`}).waitFor();
    await page.getByText('Queued',{exact:true}).waitFor();
    await screenshot(page,`${theme}-desktop-queued`);
    await api(context,'/__fixture/delivery','POST',{outcome:'success'});
    await page.getByRole('button',{name:'Retry Linear delivery'}).click();
    await page.getByText('Sent to Linear',{exact:true}).waitFor();
    const delivered = (await api(context,'/v1/feedback/queue')).items[0];
    assert.equal(delivered.status,'delivered'); assert(delivered.identifier);
    const externalLink = page.getByRole('link',{name:/Open BRE-FIXTURE/});
    assert.equal(await externalLink.getAttribute('href'),delivered.url);
    assert.equal(await externalLink.getAttribute('rel'),'noopener noreferrer');
    const ledger = await api(context,'/__fixture/deliveries');
    assert.equal(ledger.filter(item => item.title === delivered.title).length,1);
    await screenshot(page,`${theme}-desktop-delivered`);
    results.scenarios.push(`${theme}: real SQLite persistence, lost response and stable retry ID, double click, delivery failure/retry, linked work record, own-user isolation`);
    // Loading and retryable read failure preserve the real queue.
    let release;
    const held = new Promise(resolve => { release=resolve; });
    await page.route('**/v1/feedback/queue',async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await held; return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic temporary queue outage'}})});
    });
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.getByText('Loading feedback…').waitFor();
    await screenshot(page,`${theme}-desktop-loading`); release();
    await page.getByText('Synthetic temporary queue outage',{exact:false}).waitFor();
    await screenshot(page,`${theme}-desktop-read-error`);
    await page.unroute('**/v1/feedback/queue');
    await page.getByRole('button',{name:'Try again',exact:true}).click();
    await page.getByText('Sent to Linear',{exact:true}).waitFor();
    stage = theme + ': Settings to Feedback';
    await page.goto(url + '/settings', {waitUntil:'networkidle'});
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle'}), page.getByRole('navigation',{name:'Primary navigation',exact:true}).getByRole('button',{name:'Feedback',exact:true}).click()]);
    await page.getByRole('heading',{name:'Feedback',exact:true}).waitFor();
    for (const width of [390,320]) {
      stage = theme + ': mobile ' + width;
      await page.goto(url + '/settings', {waitUntil:'networkidle'});
      await page.setViewportSize({width,height:844});
      await page.getByRole('button',{name:/Open all spaces/}).click();
      await page.getByRole('menuitem',{name:'Feedback',exact:true}).scrollIntoViewIfNeeded();
      await screenshot(page,`${theme}-${width}-navigation`);
      await Promise.all([page.waitForNavigation({waitUntil:'networkidle'}), page.getByRole('menuitem',{name:'Feedback',exact:true}).click()]);
      await page.getByRole('heading',{name:'Feedback',exact:true}).waitFor();
      await page.getByText('Sent to Linear',{exact:true}).waitFor();
      const overflow = await page.evaluate(() => ({width:innerWidth,body:document.documentElement.scrollWidth}));
      assert(overflow.body<=overflow.width+1,`Horizontal overflow ${JSON.stringify(overflow)}`);
      await screenshot(page,`${theme}-${width}-queue`);
      if (width === 320) {
        await page.getByLabel('Short title').fill(`${theme}: Mobile feedback`);
        await page.getByLabel('Tell us more').fill('Synthetic mobile submission at 320 pixels.');
        await page.getByRole('button',{name:'Send feedback',exact:true}).click();
        await page.getByText('Feedback saved and added to the work queue in Linear.').waitFor();
        assert.equal((await api(context,'/v1/feedback/queue')).items.length,2);
        await screenshot(page,`${theme}-${width}-submitted`);
      }
      const controls = await page.locator('.orca-feedback-page button, .orca-feedback-page input, .orca-feedback-page select, .orca-feedback-page textarea').evaluateAll(elements => elements.map(element => {
        const style=getComputedStyle(element);return {tag:element.tagName,label:element.textContent || element.getAttribute('id'),color:style.color,background:style.backgroundColor,opacity:style.opacity,width:element.getBoundingClientRect().width};
      }));
      assert(controls.every(control => control.width>0));
      results.controls.push({theme,width,controls});
    }
    results.scenarios.push(`${theme}: loading/read error/recovery, desktop navigation, 390/320 mobile menu and overflow, focus/hover/disabled screenshots`);
    await context.close();
  }
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(url+'/v1/feedback/queue')).status(),401);
  await anonymous.close();
  assert.deepEqual(results.pageErrors,[]);
  results.status='passed';
} catch(error) {
  results.status='failed'; results.error=String(error.stack||error);
  if(current && !current.isClosed()) await screenshot(current,'failure').catch(()=>{});
  throw error;
} finally {
  results.finishedAt=new Date().toISOString();
  await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));
  await browser.close();
}
console.log(JSON.stringify({status:results.status,scenarios:results.scenarios,evidence:out},null,2));
