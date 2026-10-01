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
const results = {startedAt:new Date().toISOString(),viewport:{width:1440,height:1000},syntheticOnly:true,browserVersion:browser.version(),fixtureOrigin:origin.origin,scenarios:[],requests:[],pageErrors:[],externalRequestsBlocked:[]};
let activePage;
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
try {
 for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,colorScheme:theme});
  await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
  await context.route('**/*',route=> {
   const u=new URL(route.request().url());
   if(u.origin===origin.origin) return route.continue();
   results.externalRequestsBlocked.push({theme,origin:u.origin,path:u.pathname}); return route.abort();
  });
  const page=await context.newPage(); activePage=page;
  page.on('pageerror',error=>results.pageErrors.push({theme,message:error.message}));
  page.on('request',request=> {
   const url=new URL(request.url());
   if(url.pathname.startsWith('/v1/drafts')) results.requests.push({theme,method:request.method(),path:url.pathname,query:url.search,body:request.postData()});
  });
  await page.goto(origin.origin+'/__fixture/login');
  await page.locator('button.message-row').filter({hasText:'second account conversation'}).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  if(theme==='light') assert.equal((await ledger(context)).length,0,'Start a fresh fixture for this validation run');
  const prefix=`Browser ${theme} ${Date.now()}`;
  // Durable text/recipient recovery through a real reload, then in-session files.
  let scope=await newCompose(page);
  const subject=prefix+' new'; const body='First line\n\nSecond line with exact words.';
  await scope.getByRole('textbox',{name:'Subject',exact:true}).fill(subject);
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill(body);
  await scope.getByRole('combobox',{name:'Add To recipient'}).fill('maya@example.com');
  await scope.getByRole('combobox',{name:'Add To recipient'}).press('Enter');
  await saved(context,subject);
  await scope.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
  await poll(async()=>await page.evaluate(()=>Object.values(localStorage).some(v=>{try{const d=JSON.parse(v);return d.subject===document.querySelector('[aria-label=Subject]')?.value && Number.isInteger(d.revision);}catch{return false;}})),'Local saved revision not checkpointed');
  await screenshot(page,`${theme}-draft-before-reload`);
  await page.reload(); scope=page.locator('.compose-workspace-panel'); await scope.waitFor();
  await poll(async()=>await scope.getByRole('textbox',{name:'Subject',exact:true}).inputValue()===subject,'Reloaded draft did not hydrate');
  await scope.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
  assert.equal(await scope.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),subject);
  assert.deepEqual(await scope.getByRole('textbox',{name:'Message body',exact:true}).locator('p').allTextContents(),body.split('\n'));
  await scope.getByRole('button',{name:'Add Cc or Bcc'}).click();
  await scope.getByRole('combobox',{name:'Add Cc recipient'}).fill('cc@example.com');
  await scope.getByRole('combobox',{name:'Add Bcc recipient'}).fill('bcc@example.com');
  await scope.locator('input[type=file]').setInputFiles([{name:'remove.txt',mimeType:'text/plain',buffer:Buffer.from('remove bytes')},{name:'keep.txt',mimeType:'text/plain',buffer:Buffer.from('keep bytes')}]);
  await scope.getByRole('button',{name:'Remove remove.txt',exact:true}).click();
  await scope.getByRole('button',{name:'Remove keep.txt',exact:true}).waitFor();
  assert.equal(await scope.getByRole('button',{name:'Remove remove.txt',exact:true}).count(),0);
  await screenshot(page,`${theme}-attachment-removed`);
  let before=(await ledger(context)).length;
  await sendTwice(scope);
  const delivery=await assertDelivery(context,before,subject,'first',body);
  assert.deepEqual(delivery.draft.to.map(r=>r.email),['maya@example.com']);
  assert.deepEqual(delivery.draft.cc.map(r=>r.email),['cc@example.com']); assert.deepEqual(delivery.draft.bcc.map(r=>r.email),['bcc@example.com']);
  assert.equal(delivery.draft.body.html,null); assert.deepEqual(delivery.draft.attachments.map(a=>a.filename),['keep.txt']);
  assert.equal(delivery.draft.attachments[0].contentBase64,Buffer.from('keep bytes').toString('base64'));
  await scope.waitFor({state:'hidden'});
  results.scenarios.push({theme,name:'new-compose-reload-recipients-attachment-removal-double-send',status:'passed',account:'first',draftId:delivery.draft.id});
  // A reply from the second account while the workspace profile remains first.
  await page.locator('button.message-row').filter({hasText:'second account conversation'}).click();
  await page.getByRole('button',{name:'Reply',exact:true}).click();
  const reply=page.locator('.compose-workspace-reply');await reply.waitFor();
  await reply.getByText('Maya',{exact:true}).waitFor();
  await reply.getByRole('combobox',{name:'Message format'}).selectOption('plain');
  const replyBody=prefix+' second account reply\n\nExactly once.';
  await reply.getByRole('textbox',{name:'Message body',exact:true}).fill(replyBody);
  await screenshot(page,`${theme}-second-account-reply`);
  before=(await ledger(context)).length;
  await sendTwice(reply);
  const replyDelivery=await assertDelivery(context,before,'Re: second account conversation','second',replyBody);
  assert.equal(replyDelivery.draft.accountId,'second'); assert.equal(replyDelivery.draft.context.threadId,'second-thread');
  assert.deepEqual(replyDelivery.draft.to.map(r=>r.email),['maya@example.com']);
  results.scenarios.push({theme,name:'second-account-reply-double-send',status:'passed',account:'second',draftId:replyDelivery.draft.id});
  await reply.waitFor({state:'hidden'});
  // Invalid pending address never dispatches; then provoke a real SQLite
  // revision conflict and retain edits/files made after the conflict.
  scope=await newCompose(page);
  const conflictSubject=prefix+' conflict';
  const initialBody='Before remote conflict.';
  await scope.getByRole('textbox',{name:'Subject',exact:true}).fill(conflictSubject);
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill(initialBody);
  await scope.getByRole('combobox',{name:'Add To recipient'}).fill('maya@example.com');
  await scope.getByRole('combobox',{name:'Add To recipient'}).press('Enter');
  await scope.getByRole('button',{name:'Add Cc or Bcc'}).click();
  await scope.getByRole('combobox',{name:'Add Cc recipient'}).fill('unfinished');
  before=(await ledger(context)).length;
  const sendsBeforeInvalid=results.requests.filter(r=>r.method==='POST' && r.path.endsWith('/send')).length;
  await sendTwice(scope);
  await scope.getByText(/Check the highlighted address/).waitFor();
  assert.equal((await ledger(context)).length,before);
  assert.equal(results.requests.filter(r=>r.method==='POST' && r.path.endsWith('/send')).length,sendsBeforeInvalid);
  assert.equal(await scope.getByRole('textbox',{name:'Message body',exact:true}).innerText(),initialBody);
  await screenshot(page,`${theme}-invalid-recipient-retained`);
  results.scenarios.push({theme,name:'invalid-pending-recipient-no-dispatch',status:'passed'});
  await scope.getByRole('combobox',{name:'Add Cc recipient'}).fill('');
  const original=await saved(context,conflictSubject);
  await scope.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
  const remoteSubject=prefix+' remote preserved'; const remoteBody='Remote version stays untouched.';
  await api(context,`/v1/drafts/${original.id}?accountId=first`,'PATCH',{revision:original.revision,subject:remoteSubject,body:{text:remoteBody,html:null}});
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill('Editing triggers revision conflict.');
  await scope.getByRole('alert',{name:'Draft recovery choice'}).waitFor();
  const latestBody='Writing after conflict.\n\nThe latest version survives.';
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill(latestBody);
  await scope.locator('input[type=file]').setInputFiles([{name:'conflict-remove.txt',mimeType:'text/plain',buffer:Buffer.from('removed')},{name:'conflict-keep.txt',mimeType:'text/plain',buffer:Buffer.from('kept conflict bytes')}]);
  await scope.getByRole('button',{name:'Remove conflict-remove.txt',exact:true}).click();
  await screenshot(page,`${theme}-conflict-latest-writing`);
  await scope.getByRole('button',{name:'Keep mine as a new draft',exact:true}).click();
  await scope.getByRole('alert',{name:'Draft recovery choice'}).waitFor({state:'hidden'});
  const recovered=await saved(context,conflictSubject); assert.notEqual(recovered.id,original.id);
  before=(await ledger(context)).length;
  await sendTwice(scope);
  const recoveredDelivery=await assertDelivery(context,before,conflictSubject,'first',latestBody);
  assert.equal(recoveredDelivery.draft.id,recovered.id);
  assert.deepEqual(recoveredDelivery.draft.attachments.map(a=>a.filename),['conflict-keep.txt']);
  assert.equal(recoveredDelivery.draft.attachments[0].contentBase64,Buffer.from('kept conflict bytes').toString('base64'));
  const preserved=await api(context,`/v1/drafts/${original.id}?accountId=first`);
  assert.equal(preserved.subject,remoteSubject); assert.equal(preserved.body.text,remoteBody); assert.equal(preserved.deliveryStatus,'draft');
  await scope.waitFor({state:'hidden'});
  results.scenarios.push({theme,name:'conflict-copy-latest-writing-removed-attachment-original-preserved',status:'passed',originalId:original.id,copyId:recovered.id});
  // Delete only this test's synthetic preserved original so the next new
  // composer does not intentionally resume it. Never a user-owned draft.
  await api(context,`/v1/drafts/${original.id}?accountId=first`,'DELETE');
  // Reset only this isolated synthetic profile's recovered draft checkpoint.
  await page.evaluate(()=>localStorage.clear());
  await page.reload();
  await page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).first().waitFor();
  scope=await newCompose(page);
  assert.equal(await scope.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),'');
  const uncertainSubject=prefix+' uncertain'; const uncertainBody='Synthetic lost response.\n\nDo not deliver twice.';
  await scope.getByRole('textbox',{name:'Subject',exact:true}).fill(uncertainSubject);
  await scope.getByRole('textbox',{name:'Message body',exact:true}).fill(uncertainBody);
  await scope.getByRole('combobox',{name:'Add To recipient'}).fill('maya@example.com');
  await scope.getByRole('combobox',{name:'Add To recipient'}).press('Enter');
  await api(context,'/__fixture/outcome','POST',{outcome:'ambiguous'});
  before=(await ledger(context)).length;
  await sendTwice(scope);
  await scope.getByText(/could not be confirmed/).waitFor();
  const uncertainDelivery=await assertDelivery(context,before,uncertainSubject,'first',uncertainBody);
  await screenshot(page,`${theme}-uncertain-delivery-retained`);
  const responsePromise=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname.endsWith('/send'));
  await sendTwice(scope); await responsePromise;
  await scope.getByText(/could not be confirmed/).waitFor();
  assert.equal((await ledger(context)).length,before+1,'Uncertain replay must not invoke the provider again');
  const uncertainDraft=await api(context,`/v1/drafts/${uncertainDelivery.draft.id}?accountId=first`);
  assert.equal(uncertainDraft.deliveryStatus,'ambiguous'); assert.equal(uncertainDraft.body.text,uncertainBody);
  const replayRequests=results.requests.filter(r=>r.method==='POST' && r.path===`/v1/drafts/${uncertainDraft.id}/send`);
  assert(replayRequests.length>=2,'Expected original dispatch and replay');
  const commands=replayRequests.map(r=>JSON.parse(r.body));
  assert.equal(new Set(commands.map(c=>c.idempotencyKey)).size,1,'Replay must preserve the send key');
  assert.equal(new Set(commands.map(c=>c.revision)).size,1,'Replay must preserve delivery revision');
  results.scenarios.push({theme,name:'uncertain-delivery-retains-content-replay-no-provider-repeat',status:'passed',draftId:uncertainDraft.id});
  await api(context,'/__fixture/outcome','POST',{outcome:'sent'});
  results.deliveries=await ledger(context);
  await context.close(); activePage=null;
 }
 assert.equal(results.pageErrors.length,0,JSON.stringify(results.pageErrors));
 results.expectedProviderInvocations=8;
 results.providerInvocations=results.deliveries.length;
 assert.equal(results.providerInvocations,8);
 results.finishedAt=new Date().toISOString();
 assert.equal(results.scenarios.length,10);
 await writeFile(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify({browserVersion:results.browserVersion,scenarios:results.scenarios,pageErrors:results.pageErrors},null,2));
} catch(error) {
 results.error=error.stack;
 if(activePage) {await screenshot(activePage,'failure').catch(()=>{});await writeFile(join(out,'failure-dom.txt'),await activePage.locator('body').innerText()).catch(()=>{});}
 await writeFile(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
 throw error;
} finally {await browser.close();}
