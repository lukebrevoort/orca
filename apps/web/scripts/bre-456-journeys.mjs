import { webSourceIdentity } from './verification-revision.mjs';
/** Production UI + real synthetic API, independently reopened SQLite and provider ledger.
 * F04 is a recorded dependency, never simulated delivery. No live mail or credentials. */
import assert from 'node:assert/strict';
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
assert(['127.0.0.1','localhost'].includes(new URL(origin).hostname));await mkdir(out,{recursive:true});
const result={revision:await webSourceIdentity(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scenarios:[],assertions:0,failures:[],requests:[],pageErrors:[],screenshots:[],blocked:[{journey:'F04',reason:'BRE-455 notification contract not committed. No browser delivery enabled.'}]};
const check=(ok,label,detail)=>{result.assertions++;if(!ok)throw new Error(label+': '+JSON.stringify(detail));};
function db(sql,params=[]){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute(sys.argv[2],json.loads(sys.argv[3]))])); c.commit()',join(fixture.directory,'mail.sqlite'),sql,JSON.stringify(params)],{encoding:'utf8'}));}
async function screenshot(page,name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,name+'.png')});result.screenshots.push(name+'.png');}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:theme,serviceWorkers:'block',reducedMotion:'reduce'});
 await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await context.request.get(origin+'/__fixture/login');
 const page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/v1/'))result.requests.push({theme,path:new URL(request.url()).pathname,method:request.method()});});
 async function api(path,body){const response=await context.request.fetch(origin+path,body?{method:'POST',data:body}:{});check(response.ok(),path,await response.clone?.()?.text?.());return response.json();}
 try{
 db("delete from email_labels where email_id='first-message'");
 db("update emails set is_read=0 where id='first-message'");db("update threads set is_read=0 where id='first-thread'");
 await page.goto(origin+'/');await page.getByRole('heading',{name:'No important conversations yet',exact:true}).waitFor();
 const primaryCount=await page.locator('.desktop-sidebar-content button:visible').count();
 await screenshot(page,theme+'-important-empty-desktop');
 await page.getByRole('button',{name:'Review All Mail',exact:true}).click();
 const row=page.locator('.message-row-wrap').filter({has:page.getByRole('button',{name:/first account conversation/})}).first();
 // Actual fixture state before a list-only correction (no reader activation).
 const before=db('select id,account_id,is_read from emails order by id');
 const placementBefore=db('select * from email_labels order by id');
 const direct=row.getByRole('button',{name:'Important',exact:true});
 await direct.hover();await screenshot(page,theme+'-importance-hover');await direct.focus();await screenshot(page,theme+'-importance-focus');
 let release,started;const gate=new Promise(r=>release=r),written=new Promise(r=>started=r);
 await page.route('**/v1/importance/choices',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 const requestBefore=result.requests.filter(r=>r.path==='/v1/importance/choices').length;
 const acknowledged=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/importance/choices');
 await direct.evaluate(button=>{button.click();button.click();});await written;
 check(await direct.isDisabled(),'F01 repeated command disables owned target');await screenshot(page,theme+'-importance-saving');release();await acknowledged;
 await page.unroute('**/v1/importance/choices');
 check(result.requests.filter(r=>r.path==='/v1/importance/choices').length===requestBefore+1,'F01 rapid duplicate action invokes API once');
 await page.getByText('Choice saved in Orca.',{exact:false}).waitFor();
 const choices=db("select account_id,kind,target,choice,revision from importance_choices where account_id='first' and kind='conversation' and target='first-thread'");
 check(choices[0]?.choice==='important','F01 choice independently persisted',choices);
 check(db("select * from email_labels where email_id='first-message'").length===0,'F01 retained archived conversation remains independent of provider Inbox');
 check(JSON.stringify(before)===JSON.stringify(db('select id,account_id,is_read from emails order by id')),'F01 importance does not mark read');
 check(JSON.stringify(placementBefore)===JSON.stringify(db('select * from email_labels order by id')),'F01 importance does not move mail');
 await page.getByRole('navigation',{name:'Mail filters'}).getByRole('button',{name:'Important',exact:true}).click();
 await page.locator('.important-row').filter({hasText:'first account conversation'}).waitFor();
 await page.reload();await page.locator('.important-row').filter({hasText:'first account conversation'}).waitFor();
 await screenshot(page,theme+'-important-persisted-desktop');
 await page.getByRole('button',{name:'Review importance of first-thread',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Conversation importance',exact:true});
 await dialog.getByText('Inheritance and sender choices',{exact:true}).click();
 await dialog.getByRole('button',{name:'Choose for an exact sender…',exact:true}).click();
 const choicesBeforePreview=db('select * from importance_choices order by account_id,kind,target');
 const operationsBeforePreview=db('select * from importance_operations order by account_id,operation_id');
 await dialog.getByRole('button',{name:'Preview sender choice',exact:true}).click();
 await dialog.getByRole('button',{name:'Confirm exact-sender choice',exact:true}).waitFor();
 const previewState=db('select * from importance_choices order by account_id,kind,target');
 check(JSON.stringify(previewState)===JSON.stringify(choicesBeforePreview),'F03 sender preview has zero preference writes');
 check(JSON.stringify(db('select * from importance_operations order by account_id,operation_id'))===JSON.stringify(operationsBeforePreview),'F03 preview creates no operation or temporary choice');
 await screenshot(page,theme+'-sender-preview-desktop');
 await dialog.getByRole('button',{name:'Confirm exact-sender choice',exact:true}).click();
 await dialog.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Review importance of first-thread',exact:true}).click();
 await dialog.getByText('Inheritance and sender choices',{exact:true}).click();
 await dialog.getByRole('button',{name:'Use current sender preferences (Important)',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.locator('.important-row').filter({hasText:'first account conversation'}).waitFor();
 check((await api('/v1/importance/conversations/first-thread?accountId=first')).importance.effective==='important','F01 reset retains current inherited Important');
 await page.locator('.important-row').filter({hasText:'first account conversation'}).click();await page.locator('.reader-body').waitFor();
 await page.getByRole('button',{name:'Not important',exact:true}).first().click();
 await page.getByText('Choice saved in Orca.',{exact:false}).waitFor();
 await page.getByRole('button',{name:'Undo importance change',exact:true}).click();
 await page.getByText('Previous choice restored.',{exact:false}).waitFor();
 check((await api('/v1/importance/conversations/first-thread?accountId=first')).importance.effective==='important','F01 exact revision Undo restores inherited result');
 await screenshot(page,theme+'-reader-desktop');
 // F05: narrow reading, explicit All Mail and account isolation.
 await page.setViewportSize({width:390,height:844});await page.locator('.reader-body').first().scrollIntoViewIfNeeded();await screenshot(page,theme+'-reader-mobile');
 check((await api('/v1/importance/conversations/second-thread?accountId=second')).importance.effective==='unreviewed','F05 second account remains isolated');
 // F02: Drafts/compose/Zen are separately exercised by the complete 16-case fixture.
 await page.goto(origin+'/?destination=drafts');await page.getByRole('heading',{name:'Drafts',exact:true}).waitFor();await screenshot(page,theme+'-drafts-mobile');
 await page.goto(origin+'/settings#writing');
 const signature=page.getByRole('textbox',{name:'Default signature',exact:true});await signature.fill('BRE456 '+theme+' signature');
 await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption('appearance');
 check(await signature.isVisible()===false,'P11 one active panel');
 await page.getByRole('button',{name:'Save account choices',exact:true}).click();
 await page.getByText('Account preferences saved.',{exact:false}).waitFor();
 const preferences=await api('/v1/preferences');check(preferences.signature==='BRE456 '+theme+' signature','P11 shared Save persists inactive section');
 for(const section of ['account','appearance','attention','writing','notifications','connected','agents','privacy']){
  await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption(section);
  check(await page.locator('.settings-section:visible').count()===1,'P11 exactly one visible section '+section);
  check(await page.locator('.settings-section:visible').evaluate(node=>Number(getComputedStyle(node).opacity)===1),'P11 active section is immediately readable '+section);
 }
 await screenshot(page,theme+'-settings-mobile');
 // Retained utility/legacy route inventory, genuine server responses only.
 await page.setViewportSize({width:1440,height:1000});
 for(const [surface,path] of [['P02','/?destination=all'],['P09','/?destination=organization-studio&section=views'],['P10','/?destination=organization-studio'],['P12','/settings/gmail'],['P14','/?destination=later'],['P15','/?destination=summary'],['P16','/settings/reading']]){
  await page.goto(origin+path);await page.evaluate(()=>document.fonts.ready);await screenshot(page,theme+'-'+surface+'-retained');
 }
 const providers=await api('/__fixture/deliveries');check(providers.length===0,'No provider sends in read/importance/settings journeys',providers.length);
 result.scenarios.push({theme,primaryControlCount:primaryCount,journeys:['F01','F03 sender preview','F05','P11 cross-section save'],providerRequests:providers.length});
 // Reset through actual revision-guarded API for the next theme.
 for(const target of [{kind:'conversation',threadId:'first-thread'},{kind:'sender',address:'maya@example.com'}]){
  if(target.kind==='sender'){const preview=await api('/v1/importance/preview',{accountId:'first',address:target.address,choice:null});await api('/v1/importance/choices',{accountId:'first',target,choice:null,expectedRevision:preview.current.revision,operationId:crypto.randomUUID(),confirmation:preview.confirmation});}
  else{const snapshot=await api('/v1/importance/conversations/first-thread?accountId=first');await api('/v1/importance/choices',{accountId:'first',target,choice:null,expectedRevision:snapshot.importance.conversation.revision,operationId:crypto.randomUUID()});}
 }
 }catch(error){result.failures.push({theme,message:error.message,stack:error.stack});await screenshot(page,theme+'-failure');}
 await context.close();
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures}));}
process.exitCode=result.failures.length||result.pageErrors.length?1:0;
