/** Synthetic loopback-only production-browser compose verification.
 * node compose-fixture-e2e.mjs <connection.json> <evidence-directory>
 * Uses an installed Playwright, optionally ORCA_PLAYWRIGHT_MODULE and
 * ORCA_CHROMIUM_EXECUTABLE. Never attaches to an existing browser/profile.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [connectionFile, outputDirectory] = process.argv.slice(2);
assert(connectionFile && outputDirectory, 'connection.json and evidence directory required');
const fixture = JSON.parse(await readFile(connectionFile, 'utf8'));
const origin = new URL(fixture.url);
assert(origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname), 'Synthetic loopback fixture required');
assert(origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash);
const out = resolve(outputDirectory); await mkdir(out, {recursive:true});
const moduleName = process.env.ORCA_PLAYWRIGHT_MODULE;
const {chromium} = await import(moduleName?.startsWith('/') ? pathToFileURL(moduleName).href : moduleName ?? 'playwright');
const browser = await chromium.launch({headless:true, executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE || undefined, args:['--disable-background-networking']});
const results = {startedAt:new Date().toISOString(),viewport:{width:1440,height:1000},syntheticOnly:true,browserVersion:browser.version(),fixtureOrigin:origin.origin,scenarios:[],responses:[],requests:[],pageErrors:[],externalRequestsBlocked:[]};
let activePage;
let activeContext;
async function poll(check, message, timeout=12000) {
 const end=Date.now()+timeout;
 while(Date.now()<end) { const value=await check(); if(value) return value; await new Promise(r=>setTimeout(r,50)); }
 throw new Error(message);
}
async function api(context,path,method='GET',body) {
 assert(path.startsWith('/') && !path.startsWith('//'));
 const response=await context.request.fetch(origin.origin+path,{method,data:body});
 assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);
 if(response.status()===204) return null;
 return response.json();
}
async function ledger(context) { return api(context,'/__fixture/deliveries'); }
async function drafts(context,account='first') { return api(context,`/v1/drafts?accountId=${account}`); }
async function saved(context,subject,account='first') {
 return poll(async()=> (await drafts(context,account)).find(d=>d.subject===subject && d.providerSyncStatus==='synced'),`Draft ${subject} did not save`);
}
async function sendTwice(scope) {
 const send=scope.getByRole('button',{name:/^Send(?: reply)?$/,exact:true});
 // Dispatch the same two rapid DOM click commands a double tap can produce,
 // before React's disabled button paint. The rest of each journey uses UI input.
 await send.evaluate(button=>{button.click();button.click();});
}
async function assertDelivery(context,before,subject,account,body,extra={}) {
 const records=await poll(async()=>{const all=await ledger(context);return all.length>before?all:null;},'No fixture delivery');
 assert.equal(records.length,before+1,'Exactly one provider invocation required');
 const record=records.at(-1); assert.equal(record.accountId,account); assert.equal(record.draft.subject,subject); assert.equal(record.draft.body.text,body);
 for(const [key,value] of Object.entries(extra)) assert.deepEqual(record.draft[key],value);
 return record;
}
async function screenshot(page,name) {await page.screenshot({path:join(out,name+'.png'),fullPage:true});}
async function newCompose(page) {
 await page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).first().click();
 const scope=page.locator('.compose-workspace-panel'); await scope.waitFor();
 await scope.getByRole('combobox',{name:'Message format'}).selectOption('plain');
 return scope;
}
const measurements=[];
async function measure(page,theme,state) {
 const geometry=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
  const toolbar=document.querySelector('.compose-workspace-panel .compose-formatting'), notice=document.querySelector('.compose-conflict');
  const t=rect(toolbar),n=notice?rect(notice):null;
  return {toolbar:t,notice:n,overlap:n?Math.max(0,Math.min(t.right,n.right)-Math.max(t.x,n.x))*Math.max(0,Math.min(t.bottom,n.bottom)-Math.max(t.y,n.y)):0,buttons:[...toolbar.querySelectorAll('button')].map(b=>{const r=rect(b),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:b.getAttribute('aria-label')||b.textContent,disabled:b.disabled,hit:b===hit||b.contains(hit),rect:r}})};
 });
 measurements.push({theme,state,...geometry});await screenshot(page,`${theme}-${state}`);
}
try {
 for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:theme,serviceWorkers:'block'});
  await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin.origin?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>results.pageErrors.push(e.message));
  await page.goto(origin.origin+'/__fixture/login'); const scope=await newCompose(page);
  const subject='Focused conflict '+theme;await scope.getByRole('textbox',{name:'Subject',exact:true}).fill(subject);
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill('Before remote conflict.');
  await scope.getByRole('combobox',{name:'Add To recipient'}).fill('maya@example.com');await scope.getByRole('combobox',{name:'Add To recipient'}).press('Enter');
  await scope.getByRole('button',{name:'Add Cc or Bcc'}).click();
  const original=await saved(context,subject);await scope.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
  await scope.locator('input[type=file]').setInputFiles({name:'conflict-keep.txt',mimeType:'text/plain',buffer:Buffer.from('kept conflict bytes')});
  await measure(page,theme,'ordinary');
  await api(context,`/v1/drafts/${original.id}?accountId=first`,'PATCH',{revision:original.revision,subject:'remote '+theme,body:{text:'Remote preserved',html:null}});
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill('Writing after conflict.\n\nThe latest version survives.');
  await scope.getByRole('alert',{name:'Draft recovery choice'}).waitFor();
  await measure(page,theme,'conflict');
  const attach=scope.locator('.compose-formatting button').last();
  let attachUsable=false;try {await attach.click({trial:true,timeout:1500});attachUsable=true;}catch{}
  measurements.at(-1).attachUsable=attachUsable;
  const keep=scope.getByRole('button',{name:'Keep mine as a new draft',exact:true});
  await keep.hover();await screenshot(page,`${theme}-recovery-hover`);
  await keep.focus();await screenshot(page,`${theme}-recovery-focus`);
  await scope.locator('.compose-conflict summary').click();
  await screenshot(page,`${theme}-recovery-expanded`);
  // Reduced viewport plus long body exercises the newly permitted panel scroll.
  await page.setViewportSize({width:1440,height:700});
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill(Array.from({length:20},(_,i)=>`Synthetic long line ${i}`).join('\n'));
  const send=scope.getByRole('button',{name:'Send',exact:true});
  await send.scrollIntoViewIfNeeded();
  const footerVisible=await send.evaluate(b=>{const r=b.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.y>=0&&r.bottom<=innerHeight&&(b===hit||b.contains(hit));});
  assert(footerVisible,'Send footer must remain reachable by panel scrolling');
  await screenshot(page,`${theme}-short-viewport-footer`);
  measurements.at(-1).shortViewportFooterReachable=footerVisible;
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill('Writing after conflict.\n\nThe latest version survives.');
  await keep.scrollIntoViewIfNeeded();await keep.click();
  await scope.getByRole('alert',{name:'Draft recovery choice'}).waitFor({state:'hidden'});
  const recovered=await saved(context,subject);assert.notEqual(recovered.id,original.id);
  assert.equal(recovered.body.text,'Writing after conflict.\n\nThe latest version survives.');
  assert.equal((await api(context,`/v1/drafts/${original.id}?accountId=first`)).body.text,'Remote preserved');
  measurements.at(-1).recoveryUsable=true;
  // Leave the next theme a fresh compose, without sending any mail.
  page.once('dialog',d=>d.accept());await scope.getByRole('button',{name:'Discard',exact:true}).click();
  await scope.waitFor({state:'hidden'});await context.close();
 }
 assert.equal(results.pageErrors.length,0);
} finally {await browser.close();await writeFile(join(out,'geometry.json'),JSON.stringify({measurements,pageErrors:results.pageErrors},null,2));}
assert(measurements.every(m=>m.overlap===0),'Formatting toolbar overlaps draft conflict notice');
