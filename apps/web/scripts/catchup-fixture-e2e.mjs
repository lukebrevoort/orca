/** Disposable loopback-only catch-up evidence; never connects a live mailbox. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
const [connectionFile, out, revision = 'head'] = process.argv.slice(2);
const origin = new URL(JSON.parse(await readFile(connectionFile, 'utf8')).url);
assert.equal(origin.hostname, '127.0.0.1');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true, executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE || undefined});
const benchmark = process.env.CATCHUP_BENCH === '1';
const report = {revision, syntheticOnly:true, browser:browser.version(), scenarios:[], errors:[]};
try {
for (const width of (benchmark?[1440]:process.env.CATCHUP_DEBUG?[390]:[1440,390])) for (const theme of (benchmark||process.env.CATCHUP_DEBUG?['light']:['light','dark'])) for (const kind of (benchmark?['read']:process.env.CATCHUP_DEBUG?[process.env.CATCHUP_DEBUG==='single'?'single':'mixed']:['mixed','read','single'])) {
 const context = await browser.newContext({viewport:{width,height:900},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'});
 let marked=false, incoming=false, detailServed=false, readCalls=0;
 const count=benchmark?240:kind==='single'?1:60;
 await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced',density:'compact'})),theme);
 await context.route('**/*',async route=>{
  const req=route.request(), url=new URL(req.url());
  if(url.origin!==origin.origin) return route.abort();
  if(url.pathname==='/v1/threads/first-thread/read') {
   readCalls++; if(revision==='head') assert(detailServed,'read must follow message-detail snapshot'); marked=true;
   return route.fulfill({status:204});
  }
  if(!['GET','HEAD'].includes(req.method()) && !(req.method()==='POST' && url.pathname==='/v1/sync/gmail')) return route.abort();
  if(url.pathname==='/v1/inbox') {
   const response=await route.fetch(); const data=await response.json();
   data.messages=data.messages.map(m=>m.threadId==='first-thread'?{...m,unread:(kind==='mixed'&&!marked)||incoming, snippet:incoming?'New synthetic reply arrived':m.snippet, receivedAt:incoming?'2026-10-14T19:00:00.000Z':m.receivedAt}:m);
   return route.fulfill({response,json:data});
  }
  if(url.pathname==='/v1/threads/first-thread') {
   const response=await route.fetch(); const d=await response.json();
   const base=d.messages[0];
   d.messages=Array.from({length:count+(incoming?1:0)},(_,i)=>({...base,id:i===0?'first-message':`catchup-${i}`,providerMessageId:`synthetic-${i}`,from:{name:i%2?'Maya Chen':'Alex Rivera',email:i%2?'maya@example.com':'alex@example.com'},receivedAt:new Date(Date.UTC(2026,9,1,8,i)).toISOString(),unread:i===count?true:kind==='mixed'&&!marked&&i>=count-3,bodyText:`Synthetic project update ${i+1}.\n\n`+Array.from({length:15},(_,j)=>`Paragraph ${j+1}: Review context and decisions remain accessible while catching up on this conversation.`).join('\n\n')+'\n\nOn Monday, Alex wrote:\n> Earlier synthetic context remains available.',bodyHtml:null,attachments:[{id:`attachment-${i}`,filename:'synthetic-notes.txt',mimeType:'text/plain',size:128}]}));
   d.thread.messageCount=d.messages.length; d.thread.subject=`Synthetic ${kind} conversation`; detailServed=true;
   return route.fulfill({response,json:d});
  }
  return route.continue();
 });
 await context.request.get(origin.origin+'/__fixture/login',{maxRedirects:0});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(origin.origin,{waitUntil:'networkidle'});
 const row=page.locator('button.message-row').filter({hasText:'first account conversation'});
 await row.click(); await page.locator('.reader-card-toggle[aria-expanded="true"]').waitFor();
 await page.evaluate(()=>document.fonts.ready);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const prefix=`${revision}-${width}-${theme}-${kind}`;
 await page.screenshot({path:join(out,prefix+'-entry.png')});
 const entry = await page.locator('.reader-card-toggle[aria-expanded="true"]').getAttribute('aria-controls');
 if(revision==='head') {
  assert.equal(entry,`reader-card-${count===1?'first-message':`catchup-${kind==='mixed'?count-3:count-1}`}`);
  assert.equal(await page.locator('.reader-catchup-count').innerText(),`${kind==='mixed'?3:0} unread at entry`);
 }
 const scenario={width,theme,kind,entry,readCalls};report.scenarios.push(scenario);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
 if(benchmark) {
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  await page.evaluate(()=>{
   window.__geometryCalls=0;
   for(const method of ['getBoundingClientRect','getClientRects']) {
    const original=Element.prototype[method];Element.prototype[method]=function(...args){window.__geometryCalls++;return original.apply(this,args);};
   }
  });
  const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  await page.locator('.reader-earlier').click();
  scenario.samples=[];
  scenario.measurementWindow = "two animation frames plus 180ms quiet-period work, reported separately";
  for(let trial=-2;trial<10;trial++) for(const operation of ['expand','collapse','scroll']) {
   const before=await metrics();
   const sample=await page.evaluate(async operation=>{
    window.__geometryCalls=0;const start=performance.now();
    if(operation==='scroll') {const w=document.querySelector('.desktop-workspace');w.scrollTop=w.scrollTop===900?500:900;}
    else document.querySelector('[aria-controls="reader-card-first-message"]').click();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {elapsedMs:performance.now()-start,geometryCalls:window.__geometryCalls,domNodes:document.querySelectorAll('.reader-message-list *').length};
   },operation);
   const immediate=await metrics();
   await page.waitForTimeout(180);
   const after=await metrics();
   const settledGeometryCalls=await page.evaluate(()=>window.__geometryCalls);
   if(trial>=0) scenario.samples.push({trial,operation,...sample,settledGeometryCalls,immediateTaskDurationMs:(immediate.TaskDuration-before.TaskDuration)*1000,...Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration'].map(k=>[k+'Ms',(after[k]-before[k])*1000]))});
  }
  await context.close();continue;
 }
 // Comparable keyboard operation, quoted content, attachments and scroll-away return.
 const earlier=page.locator('.reader-earlier');
 if(count>1) {
  await earlier.click();
  const first=page.locator('[aria-controls="reader-card-first-message"]');
  await first.focus();await page.keyboard.press('Enter');
  assert.equal(await first.getAttribute('aria-expanded'),'true');
  await page.locator('#reader-card-first-message .reader-quoted summary').click();
  assert(await page.locator('#reader-card-first-message .reader-attachments').isVisible());
  await first.focus();await page.keyboard.press('Enter');
  await page.screenshot({path:join(out,prefix+'-compact-focus.png')});
  await first.evaluate(node=>node.blur()); await first.hover();
  await page.screenshot({path:join(out,prefix+'-compact-hover.png')});
 }
 await page.evaluate(mobile=>{if(mobile)window.scrollTo(0,900);else document.querySelector('.desktop-workspace').scrollTop=900;},width===390);
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const position = () => page.evaluate(() => {
  const workspace=document.querySelector('.desktop-workspace');
  const contained=['auto','scroll'].includes(getComputedStyle(workspace).overflowY);
  const top=contained?workspace.getBoundingClientRect().top:Math.max(0,document.querySelector(".desktop-workspace-header")?.getBoundingClientRect().bottom??0);
  const node=[...document.querySelectorAll('.reader-message article')].find(n=>n.getClientRects().length && n.getBoundingClientRect().bottom>top);
  return {key:node?.querySelector('.reader-card-toggle')?.getAttribute('aria-controls'),offset:node?node.getBoundingClientRect().top-top:null};
 });
 scenario.anchorBefore=await position();
 scenario.beforeReturn=await page.evaluate(m=>m?scrollY:document.querySelector('.desktop-workspace').scrollTop,width===390);
 await page.screenshot({path:join(out,prefix+'-position.png')});
 // Escape leaves without Playwright scrolling the Back control into view.
 await page.keyboard.press('Escape');await row.waitFor({state:'visible'});await row.click();
 await page.locator('.reader-card-toggle[aria-expanded="true"]').waitFor();
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 scenario.afterReturn=await page.evaluate(m=>m?scrollY:document.querySelector('.desktop-workspace').scrollTop,width===390);
 await page.screenshot({path:join(out,prefix+'-return.png')});
 scenario.afterReturn=await page.evaluate(m=>m?scrollY:document.querySelector('.desktop-workspace').scrollTop,width===390);
 scenario.anchorAfter=await position();
 if(revision==='head') assert(scenario.anchorBefore.key===scenario.anchorAfter.key && Math.abs(scenario.anchorBefore.offset-scenario.anchorAfter.offset)<3,JSON.stringify(scenario));
 if(kind==='mixed') {
  const before=await page.evaluate(m=>m?scrollY:document.querySelector('.desktop-workspace').scrollTop,width===390);
  incoming=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('[aria-controls="reader-card-catchup-60"]').waitFor({state:'attached'});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  scenario.afterIncoming=await page.evaluate(m=>m?scrollY:document.querySelector('.desktop-workspace').scrollTop,width===390);
  if(revision==='head') {
   assert.equal(await page.locator('.reader-catchup-count').innerText(),'0 unread at entry · 1 new unread');
   assert(Math.abs(before-scenario.afterIncoming)<3,'incoming must not jump');
  }
  await page.screenshot({path:join(out,prefix+'-incoming.png')});
 }
 scenario.finalReadCalls=readCalls;
 if(revision==='head') assert.equal(readCalls,kind==='mixed'?1:0,'return and incoming mail must not cause additional read writes');
 await context.close();
}
assert.deepEqual(report.errors,[]);
} finally { await writeFile(join(out,revision+'-results.json'),JSON.stringify(report,null,2));await browser.close(); }
