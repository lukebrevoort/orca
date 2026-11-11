/** Important-default reader audit, with same-conversation All Mail control.
 * Actual UI/HTTP + independent SQLite. Direct choices remain read/placement-free. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});const result={revision:await webSourceIdentity(),scenarios:[],assertions:0,failures:[],requests:[],pageErrors:[],policy:'Existing normal All Mail open sets pendingReaderRead; a committed owned reader marks the thread read. Importance choice alone must not mark read or move.'};
const check=(ok,label,detail)=>{result.assertions++;if(!ok)result.failures.push({label,detail});};
function db(sql,params=[]){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;r=[dict(x) for x in c.execute(sys.argv[2],json.loads(sys.argv[3]))];c.commit();print(json.dumps(r))',join(fixture.directory,'mail.sqlite'),sql,JSON.stringify(params)],{encoding:'utf8'}));}
function unread(){db("update emails set is_read=0 where account_id='first' and thread_id='first-thread'");db("update threads set is_read=0 where id='first-thread'");}
function rows(){return {emails:db("select id,account_id,is_read from emails where account_id='first' and thread_id='first-thread' order by id"),threads:db("select id,account_id,is_read from threads where id='first-thread'")};}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await context.request.get(origin+'/__fixture/login');const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/v1/'))result.requests.push({theme,path:new URL(request.url()).pathname,query:new URL(request.url()).search,method:request.method()});});
 async function open(row){const ack=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/threads/first-thread/read'&&response.request().method()==='PATCH',{timeout:8000}).then(response=>response.status()).catch(error=>({missingReadAck:error.message}));await row.focus();await page.keyboard.press('Enter');await page.locator('.message-reader .reader-heading h1').waitFor();return ack;}
 async function truth(){const response=await context.request.get(origin+'/v1/threads/first-thread?accountId=first');assert(response.ok());return {http:await response.json(),database:rows()};}
 try{
  unread();await page.goto(origin+'/?destination=all');const all=page.locator('button.message-row').filter({hasText:'first account conversation'}).first();await all.waitFor();const normalAck=await open(all),normal=await truth();check(normalAck===204&&normal.database.emails.every(row=>row.is_read===1),'Normal owned All Mail reader opening establishes the read policy',{theme,normalAck,normal});await page.getByRole('navigation',{name:'Reader controls',exact:true}).getByRole('button',{name:'All Mail',exact:true}).click();
  unread();const beforeChoice=rows(),placement=db('select * from email_labels order by id');const snapshot=await context.request.get(origin+'/v1/importance/conversations/first-thread?accountId=first').then(response=>response.json());const choice=await context.request.post(origin+'/v1/importance/choices',{data:{accountId:'first',target:{kind:'conversation',threadId:'first-thread'},choice:'important',expectedRevision:snapshot.importance.conversation.revision,operationId:crypto.randomUUID()}});assert(choice.ok());check(JSON.stringify(rows())===JSON.stringify(beforeChoice),'Direct importance choice alone still never marks read',{theme});check(JSON.stringify(db('select * from email_labels order by id'))===JSON.stringify(placement),'Direct importance choice alone still never moves mail',{theme});
  const flows=[];
  for(const exit of ['Back','Escape']){
   unread();await page.goto(origin+'/');const row=page.locator('button.important-row').filter({hasText:'first account conversation'});await row.waitFor();assert((await row.innerText()).includes('Unread'));
   const ack=await open(row),opened=await truth();check(ack===204&&opened.database.emails.every(row=>row.is_read===1)&&opened.http.messages.every(message=>!message.unread),'Owned Important reader opening follows normal read policy in HTTP and independent SQLite',{theme,exit,ack,opened});
   if(exit==='Back')await page.getByRole('navigation',{name:'Reader controls',exact:true}).getByRole('button',{name:'Important',exact:true}).click();else await page.keyboard.press('Escape');await row.waitFor();
   // Allow the existing bounded restoration loop its four animation frames.
   await page.evaluate(async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>requestAnimationFrame(resolve));});
   const focus=await row.evaluate(node=>({restored:node===document.activeElement,activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),activeText:document.activeElement?.textContent?.slice(0,120)}));check(focus.restored,'Important reader '+exit+' restores keyboard focus to the exact source row',{theme,exit,focus});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+exit+'.png')});flows.push({exit,ack,opened,focus});
  }
  const deliveries=await context.request.get(origin+'/__fixture/deliveries').then(response=>response.json());check(deliveries.length===0,'Reader and importance audit never sends synthetic mail',{theme});result.scenarios.push({theme,normalAck,normal,flows,syntheticDeliveries:deliveries.length});
 }catch(error){result.failures.push({theme,message:error.message});await page.screenshot({path:join(out,theme+'-precondition-failure.png')}).catch(()=>{});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
