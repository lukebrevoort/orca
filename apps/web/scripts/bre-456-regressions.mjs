import { webSourceIdentity } from './verification-revision.mjs';
/** Real synthetic API/DB compose fixture; reader uses a documented post-sanitized input. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { join } from 'node:path';
const [connection,out,mode='candidate']=process.argv.slice(2);
const fixture=JSON.parse(await readFile(connection,'utf8'));const origin=new URL(fixture.url).origin;
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
await mkdir(out,{recursive:true});
const result={revision:await webSourceIdentity(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mode,scenarios:[],failures:[],requests:[],assertions:0};
const check=(condition,label,detail)=>{result.assertions++;if(!condition) result.failures.push({label,detail});};
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:theme,serviceWorkers:'block'});
 await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
 await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.request.get(origin+'/__fixture/login');
 const page=await context.newPage();page.setDefaultTimeout(12000);
 page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/drafts')&&r.method()!=='GET') result.requests.push({theme,method:r.method(),path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 await page.route('**/v1/threads/first-thread?*',async route=>{const response=await route.fetch();const detail=await response.json();const sample=JSON.parse(await readFile(new URL('./fixtures/reader-cases.json',import.meta.url),'utf8'))[0];detail.messages[0].bodyHtml=sample.html??sample.bodyHtml;detail.messages[0].bodyText=sample.text??sample.bodyText;await route.fulfill({response,json:detail});});
 await page.goto(origin+'/?destination=all&thread=first-thread&accountId=first');
 await page.locator('.reader-body-html').waitFor();await page.evaluate(()=>document.fonts.ready);
 const geometry=await page.locator('.reader-formatted-region').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
 check(geometry.scroll<=geometry.width+1,'BRE-460 ordinary formatted prose reflows',geometry);
 await page.screenshot({path:join(out,theme+'-reader.png')});
 await page.goto(origin+'/?destination=all');await page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).first().click();
 const panel=page.locator('.compose-workspace-panel');await panel.getByRole('textbox',{name:'Subject',exact:true}).fill('BRE456 '+theme);
 await panel.getByRole('combobox',{name:'Message format'}).selectOption('plain');
 await panel.getByRole('textbox',{name:'Message body',exact:true}).fill('');
 await panel.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
 let releasePatch, patchStarted;
 const gate=new Promise(r=>releasePatch=r), started=new Promise(r=>patchStarted=r);
 await page.route('**/v1/drafts/*?*',async route=>{if(route.request().method()==='PATCH'){const response=await route.fetch();patchStarted();await gate;await route.fulfill({response});}else await route.continue();});
 await panel.getByRole('combobox',{name:'Message format'}).selectOption('rich');
 await started;
 // Same intended format after an intermediate edit queues a duplicate signature
 // while the first acknowledgement is held at the real API boundary.
 await panel.getByRole('combobox',{name:'Message format'}).selectOption('plain');
 await panel.getByRole('combobox',{name:'Message format'}).selectOption('rich');
 await page.waitForTimeout(550);releasePatch();
 await page.waitForTimeout(1600);
 await page.unroute('**/v1/drafts/*?*');
 const saving=await panel.innerText();check(!saving.includes('Saving'),'BRE-462 format acknowledgement settles',saving);
 const files=n=>Array.from({length:n},(_,i)=>({name:'same-name.txt',mimeType:'text/plain',buffer:Buffer.from('file '+i)}));
 const stages=[];
 async function attachmentState(expected){
   await panel.locator('.compose-save-status-saved').waitFor();
   const ids=await panel.locator('.compose-attachment-chips li').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-attachment-id')));
   const drafts=await (await context.request.get(origin+'/v1/drafts?accountId=first')).json();
   const saved=drafts.find(d=>d.subject==='BRE456 '+theme);
   check(ids.length===expected,'BRE-463 visible count '+expected,ids.length);
   check(saved?.attachments.length===expected,'BRE-463 acknowledged count '+expected,saved?.attachments.length);
   check(JSON.stringify(saved?.attachments.map(a=>a.id))===JSON.stringify(ids),'BRE-463 owned attachment identities match '+expected);
   stages.push({expected,ids,serializedIds:saved?.attachments.map(a=>a.id)});
 }
 await attachmentState(0);
 await panel.locator('input[type=file]').setInputFiles(files(1));await attachmentState(1);
 await panel.locator('input[type=file]').setInputFiles(files(23));await attachmentState(24);
 await panel.locator('input[type=file]').setInputFiles(files(2));await attachmentState(25);
 const count=await panel.locator('.compose-attachment-chips li').count();
 const writes=result.requests.filter(r=>r.theme===theme&&r.body?.attachments);const counts=writes.map(r=>r.body.attachments.length);
 check(counts.every(n=>n<=25),'BRE-463 serialized attachments never exceed visible cap',counts);
 await page.reload();await page.locator('.compose-workspace-panel').waitFor();await attachmentState(25);
 check(await panel.getByText('Reattach before sending',{exact:false}).count()===0,'BRE-463 persisted bytes survive reload');
 const db=JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps([dict(r) for r in c.execute("select subject,attachments from message_drafts")]))',join(fixture.directory,'mail.sqlite')],{encoding:'utf8'}));
 result.scenarios.push({theme,geometry,visibleAttachments:count,serializedCounts:counts,stages,db});
 await page.screenshot({path:join(out,theme+'-compose.png')});for(const draft of await (await context.request.get(origin+'/v1/drafts?accountId=first')).json()) await context.request.delete(origin+'/v1/drafts/'+draft.id+'?accountId=first');await context.close();
 }}catch(error){result.failures.push({label:'execution',message:String(error),stack:error.stack});}
finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures}));}
process.exitCode=result.failures.length?1:0;
