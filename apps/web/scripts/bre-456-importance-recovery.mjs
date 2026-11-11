/** Ambiguous/repeated/stale/account-switch browser commands against the real
 * loopback API and independent SQLite. Transport barriers never fake success. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});
const result={revision:await webSourceIdentity(),scenarios:[],failures:[],assertions:0,pageErrors:[]};
const check=(ok,label,detail)=>{result.assertions++;assert(ok,label+' '+JSON.stringify(detail));};
function choices(){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("select * from importance_choices order by account_id,kind,target")]))',join(fixture.directory,'mail.sqlite')],{encoding:'utf8'}));}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
async function scenario(theme,name,run){
 const context=await browser.newContext({viewport:{width:1024,height:900},colorScheme:theme,serviceWorkers:'block'});
 await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await context.request.get(origin+'/__fixture/login');
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.pageErrors.push(e.message));
 const commands=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/v1/importance/choices')commands.push(r.postDataJSON());});
 async function api(path,body){const response=await context.request.fetch(origin+path,body?{method:'POST',data:body}:{});assert(response.ok(),`${path}: ${response.status()}`);return response.json();}
 const read=()=>api('/v1/importance/conversations/first-thread?accountId=first');
 async function change(choice){const snapshot=await read();return api('/v1/importance/choices',{accountId:'first',target:{kind:'conversation',threadId:'first-thread'},choice,expectedRevision:snapshot.importance.conversation.revision,operationId:crypto.randomUUID()});}
 try{
 await change(null);await page.goto(origin+'/?destination=all');
 const row=page.locator('.message-row-wrap').filter({has:page.locator('button.message-row').filter({hasText:'first account conversation'})}).first();
 await row.getByRole('button',{name:'Important',exact:true}).waitFor();
 await run({context,page,row,api,read,change,commands});
 check((await api('/__fixture/deliveries')).length===0,'No provider writes during importance recovery');
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,`${theme}-${name}.png`)});
 result.scenarios.push({theme,name,browserCommands:commands.length,operationIds:commands.map(command=>command.operationId),database:choices()});
 }catch(error){result.failures.push({theme,name,message:error.message});await page.screenshot({path:join(out,`${theme}-${name}-failure.png`)}).catch(()=>{});}
 finally{await context.close();}
}
try{for(const theme of ['light','dark']){
 await scenario(theme,'committed-response-lost',async({page,row,read,commands})=>{
  let first=true;await page.route('**/v1/importance/choices',async route=>{if(first){first=false;const response=await route.fetch();assert(response.ok());await route.abort('failed');}else await route.continue();});
  await row.getByRole('button',{name:'Important',exact:true}).click();await page.getByRole('button',{name:'Undo importance change',exact:true}).waitFor();
  check(commands.length===1,'Lost committed response is reconciled without another mutation');check((await read()).importance.effective==='important','Committed choice independently current');
 });
 await scenario(theme,'uncommitted-response-lost',async({page,row,read,commands})=>{
  let first=true;await page.route('**/v1/importance/choices',async route=>{if(first){first=false;await route.abort('failed');}else await route.continue();});
  await row.getByRole('button',{name:'Important',exact:true}).click();await page.getByRole('button',{name:'Undo importance change',exact:true}).waitFor();
  check(commands.length===2,'Uncommitted loss performs one bounded retry');check(commands[0].operationId===commands[1].operationId,'Retry preserves the exact operation UUID');check(JSON.stringify(commands[0])===JSON.stringify(commands[1]),'Retry preserves the complete command');check((await read()).importance.effective==='important','Retried choice persisted');
 });
 await scenario(theme,'superseded-reconciliation',async({page,row,read,change,commands})=>{
  await page.route('**/v1/importance/choices',async route=>{const response=await route.fetch();assert(response.ok());await change('not_important');await route.abort('failed');});
  await row.getByRole('button',{name:'Important',exact:true}).click();await row.getByRole('button',{name:'Not important',exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.importance-control')].some(control=>control.textContent.includes('Not important · this conversation')));
  check((await read()).importance.effective==='not_important','Superseded receipt never reinstalls Important');check(await page.getByRole('button',{name:'Undo importance change',exact:true}).count()===0,'Superseded receipt offers no old Undo');check(commands.length===1,'Superseded command is never retried');
 });
 await scenario(theme,'stale-choice-review',async({page,row,read,change})=>{
  await change('important');await row.getByRole('button',{name:'Not important',exact:true}).click();await row.getByRole('alert').waitFor();
  check((await read()).importance.effective==='important','Stale choice cannot overwrite newer state');
  await row.getByRole('button',{name:'Review importance of first-thread',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Conversation importance',exact:true});
  await dialog.getByText('Currently',{exact:false}).waitFor();await dialog.getByRole('button',{name:'Not important',exact:true}).click();await dialog.waitFor({state:'hidden'});
  check((await read()).importance.effective==='not_important','Fresh explicit review can apply a new current command');
 });
 await scenario(theme,'stale-undo',async({page,row,read,change})=>{
  await row.getByRole('button',{name:'Important',exact:true}).click();await page.getByRole('button',{name:'Undo importance change',exact:true}).waitFor();await change('not_important');
  await page.getByRole('button',{name:'Undo importance change',exact:true}).click();await page.locator('.importance-receipt').filter({hasText:/changed|no longer|current/i}).waitFor();
  check((await read()).importance.effective==='not_important','Undo cannot overwrite a newer owned revision');
 });
 await scenario(theme,'stale-sender-preview',async({page,row,read,change})=>{
  await row.getByRole('button',{name:'Review importance of first-thread',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Conversation importance',exact:true});
  await dialog.getByText('Inheritance and sender choices',{exact:true}).click();await dialog.getByRole('button',{name:'Choose for an exact sender…',exact:true}).click();
  await dialog.getByRole('button',{name:'Preview sender choice',exact:true}).click();await dialog.getByRole('button',{name:'Confirm exact-sender choice',exact:true}).waitFor();
  const before=choices().filter(choice=>choice.kind==='sender');await change('important');await dialog.getByRole('button',{name:'Confirm exact-sender choice',exact:true}).click();await dialog.getByRole('alert').waitFor();
  check(JSON.stringify(choices().filter(choice=>choice.kind==='sender'))===JSON.stringify(before),'Stale sender preview cannot write a preference');check((await read()).importance.effective==='important','Newer conversation state remains current');
 });
 await scenario(theme,'old-account-page',async({page,change})=>{
  await change('important');let release,started,finished;const gate=new Promise(r=>release=r),requested=new Promise(r=>started=r),staleCompleted=new Promise(r=>finished=r);
  await page.route('**/v1/important?*',async route=>{if(new URL(route.request().url()).searchParams.get('accountId')==='first'){const response=await route.fetch();started();await gate;await route.fulfill({response});finished();}else await route.continue();});
  await page.getByRole('navigation',{name:'Mail filters'}).getByRole('button',{name:'Important',exact:true}).click();await requested;
  await page.getByRole('combobox',{name:'Important mail account',exact:true}).selectOption('second');await page.getByRole('heading',{name:'No important conversations yet',exact:true}).waitFor();
  // The owner switch aborts the old browser request. Wait for our real server
  // response barrier to be released; an aborted fetch need not emit response.
  release();await staleCompleted;
  check(await page.locator('.important-row').count()===0,'Old account response never installs in the new account');check(await page.getByRole('combobox',{name:'Important mail account',exact:true}).inputValue()==='second','Current account selection stays second');
 });
 await scenario(theme,'legacy-projection',async({page,row})=>{
  await page.route('**/v1/inbox?*',async route=>{const headers={...route.request().headers()};delete headers['x-orca-importance-version'];const response=await route.fetch({headers});assert(response.ok());await route.fulfill({response});});
  await page.reload();await row.getByText('Importance unavailable · this conversation',{exact:false}).waitFor();
  check(await row.getByRole('button',{name:'Important',exact:true}).count()===0,'Missing legacy projection cannot become an editable Unreviewed choice');
  check(await row.locator('.importance-control').innerText().then(text=>!text.includes('Unreviewed')),'Missing projection is unavailable, not Unreviewed');
 });
 for(const failure of ['old-server','offline','offline-after-empty'])await scenario(theme,failure,async({page})=>{
  const important=page.getByRole('navigation',{name:'Mail filters'}).getByRole('button',{name:'Important',exact:true});
  if(failure==='offline-after-empty'){await important.click();await page.getByRole('heading',{name:'No important conversations yet',exact:true}).waitFor();}
  await page.route('**/v1/important?*',route=>failure.startsWith('offline')?route.abort('internetdisconnected'):route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'not_found',message:'Synthetic older-server endpoint unavailable'}})}));
  if(failure==='offline-after-empty')await page.evaluate(()=>window.dispatchEvent(new Event('focus')));else await important.click();
  await page.getByRole('alert').filter({hasText:'Importance could not load.'}).waitFor();
  check(await page.getByRole('heading',{name:'No important conversations yet',exact:true}).count()===0,'Unavailable Important is never shown as an empty mailbox');
  check(await page.locator('.mail-count').count()===0,'Failed refresh never presents a current membership count');
  if(failure==='offline-after-empty')check(await page.getByRole('alert').innerText().then(text=>text.includes('last loaded snapshot')),'Genuine retained snapshot is explicitly identified');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+failure+'-mobile.png')});
  check(await page.getByRole('button',{name:'Retry Important',exact:true}).evaluate(node=>node.getBoundingClientRect().height>=44),'Failed-refresh retry remains a usable mobile control');
  await page.getByRole('navigation',{name:'Mail filters'}).getByRole('button',{name:'All Mail',exact:true}).click();await page.locator('button.message-row').filter({hasText:'first account conversation'}).first().waitFor();
  check(await page.getByRole('navigation',{name:'Mail filters'}).getByRole('button',{name:'Important',exact:true}).isVisible(),'Important and All Mail remain reachable after '+failure);
 });
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}
process.exitCode=result.failures.length||result.pageErrors.length?1:0;
