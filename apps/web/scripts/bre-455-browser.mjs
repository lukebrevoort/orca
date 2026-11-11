/** Actual Chromium Notification constructors + real API/Gmail persistence +
 * independent SQLite. Constructor success is NOT OS banner/display proof. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});
const result={revision:await webSourceIdentity(),scope:'Real browser constructor and server report; no OS display or closed-tab delivery proof',scenarios:[],assertions:0,failures:[],pageErrors:[],requests:[],fixtureApiRequests:[],externalRequestsBlocked:[]};
const check=(ok,label,detail)=>{result.assertions++;assert(ok,label+' '+JSON.stringify(detail));};
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' barrier exceeded 10s')),10000);})]);}finally{clearTimeout(timer);}}
function db(sql){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute(sys.argv[2])]))',fixture.databasePath,sql],{encoding:'utf8'}));}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
async function makeContext(theme,permission='granted'){
 const context=await browser.newContext({viewport:{width:1024,height:900},colorScheme:theme,serviceWorkers:'block'});
 if(permission==='granted')await context.grantPermissions(['notifications'],{origin});
 await context.addInitScript(({theme,permission})=>{
  localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'}));
  window.__notifications=[];window.__permissionRequests=0;
  const Native=window.Notification;
  if(permission==='unavailable'){Object.defineProperty(window,'Notification',{value:undefined,configurable:true});return;}
  window.Notification=new Proxy(Native,{construct(target,args){const notification=Reflect.construct(target,args);window.__notifications.push({title:args[0],options:args[1],native:notification instanceof Native});return notification;},get(target,key){if(key==='requestPermission')return (...args)=>{window.__permissionRequests++;return Native.requestPermission(...args);};return Reflect.get(target,key,target);}});
 },{theme,permission});
 await context.route('**/*',r=>{if(new URL(r.request().url()).origin===origin)return r.continue();result.externalRequestsBlocked.push(r.request().url());return r.abort();});
 await context.request.get(origin+'/__fixture/login');const page=await context.newPage();page.setDefaultTimeout(10000);
 page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/v1/notifications/'))result.requests.push({theme,permission,path:new URL(request.url()).pathname,method:request.method(),body:request.postDataJSON()});});
 await page.goto(origin+'/settings#notifications');await page.getByRole('button',{name:'Set up important-only notifications',exact:true}).waitFor();
 return {context,page};
}
async function api(context,path,body,method=body?'POST':'GET'){result.fixtureApiRequests.push({path,method});const response=await context.request.fetch(origin+path,{method,...(body?{data:body}:{})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.json();}
async function configure(page){await page.getByRole('button',{name:'Set up important-only notifications',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Important-only notification choices',exact:true});await dialog.getByRole('checkbox',{name:'u@example.com',exact:true}).check();return dialog;}
async function checkNow(page){const button=page.getByRole('button',{name:'Check for important mail now',exact:true});await button.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Check for important mail now'&&!button.disabled));await button.click();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Check for important mail now'&&!button.disabled));}
async function constructorCount(page){return page.evaluate(()=>window.__notifications.length);}
async function screenshot(page,name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,name+'.png')});}
async function adopt(page){const dialog=await configure(page);await dialog.getByRole('button',{name:'Enable important-only notifications',exact:true}).click();await dialog.waitFor({state:'hidden'});await checkNow(page);return page.evaluate(()=>localStorage.getItem('orca:important-notifications:v1:u'));}
try{for(const theme of ['light','dark']){
 const {context,page}=await makeContext(theme);
 try{
 check(await page.evaluate(()=>window.__permissionRequests)===0,'No permission request on Settings entry');
 const installationsBefore=db('select * from important_notification_installations');
 let dialog=await configure(page);
 await page.setViewportSize({width:390,height:844});
 for(let tab=0;tab<12;tab++){await page.keyboard.press('Tab');check(await dialog.evaluate(node=>node.contains(document.activeElement)),'Notification choices retain keyboard focus inside modal');}
 await screenshot(page,theme+'-choices-mobile');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 // The existing shared TopLayer contract restores the opener in one frame.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 check(await page.getByRole('button',{name:'Set up important-only notifications',exact:true}).evaluate(node=>node===document.activeElement),'Cancel restores setup trigger focus');
 await page.setViewportSize({width:1024,height:900});
 check(JSON.stringify(db('select * from important_notification_installations'))===JSON.stringify(installationsBefore),'Cancel preserves policy and previous choices');
 await api(context,'/__fixture/old',{});
 // Ambiguous adoption reconciles the original UUID instead of applying again.
 let dropped=false,releaseSave,saveStarted;const saveGate=new Promise(resolve=>releaseSave=resolve),saved=new Promise(resolve=>saveStarted=resolve);
 await page.route('**/v1/notifications/installations/*',async route=>{if(route.request().method()==='PUT'&&!dropped){dropped=true;const response=await route.fetch();assert(response.ok());saveStarted();await saveGate;return route.abort('failed');}return route.continue();});
 dialog=await configure(page);await dialog.getByRole('button',{name:'Enable important-only notifications',exact:true}).click();await bounded(saved,'adoption acknowledgement');
 check(await dialog.getByRole('button',{name:'Saving notification choices…',exact:true}).isDisabled(),'Pending adoption disables repeated submission');
 await screenshot(page,theme+'-saving');releaseSave();await dialog.waitFor({state:'hidden'});
 await page.getByRole('button',{name:'Review important-only choices',exact:true}).waitFor();
 const id=await page.evaluate(()=>localStorage.getItem('orca:important-notifications:v1:u'));
 const installation=await api(context,`/v1/notifications/installations/${id}?channel=open_app`);
 check(installation.policy.enabled&&installation.policy.accountIds.length===1&&installation.policy.accountIds[0]==='a','Actual explicit account adoption persisted');
 check(installation.revision===1,'Lost adoption acknowledgement reconciles once',installation.revision);
 await checkNow(page);check(await constructorCount(page)===0,'No historical unread backlog after adoption');
 await screenshot(page,theme+'-adopted');
 const thread='browser-main-'+theme;await api(context,'/__fixture/fresh',{id:'browser-fresh-'+theme,thread});
 await checkNow(page);await page.waitForFunction(()=>window.__notifications.length===1);
 const constructors=await page.evaluate(()=>window.__notifications);
 check(constructors[0].native,'Real native Chromium Notification constructor returned');
 check(constructors[0].options.data.accountId==='a'&&constructors[0].options.data.threadId==='gmail:a:'+thread,'Constructor carries exact owned conversation identity');
 const constructedRows=db("select * from important_notification_web_deliveries where state='constructed'");
 check(constructedRows.some(row=>row.installation_id===id),'Independent SQLite records constructed report');
 check(db("select * from email_labels where email_id='gmail:a:browser-fresh-"+theme+"'").every(row=>!String(row.label_id).includes('INBOX')),'Important automated archived arrival does not require Inbox placement');
 await api(context,'/__fixture/fresh',{id:'browser-repeat-'+theme,thread});await checkNow(page);check(await constructorCount(page)===1,'15-minute cooldown suppresses repeated conversation');
 await api(context,'/__fixture/advance',{milliseconds:900000});await checkNow(page);check(await constructorCount(page)===1,'Suppressed mail is not replayed at cooldown boundary');
 await api(context,'/__fixture/fresh',{id:'browser-boundary-'+theme,thread});await checkNow(page);check(await constructorCount(page)===2,'New fresh arrival after cooldown can construct');
 // Real server claim is held, then importance is corrected before delivery.
 const queued='queued-'+theme;await api(context,'/__fixture/fresh',{id:'browser-queued-'+theme,thread:queued});
 let release,started,hold=true;const gate=new Promise(r=>release=r),claimed=new Promise(r=>started=r);
 await page.route('**/v1/notifications/installations/*/claim',async route=>{if(hold){hold=false;const response=await route.fetch();assert(response.ok());started();await gate;return route.fulfill({response});}return route.continue();});
 await page.getByRole('button',{name:'Check for important mail now',exact:true}).click();await bounded(claimed,'queued claim');
 const snapshot=await api(context,`/v1/importance/conversations/${encodeURIComponent('gmail:a:'+queued)}?accountId=a`);
 await api(context,'/v1/importance/choices',{accountId:'a',target:{kind:'conversation',threadId:'gmail:a:'+queued},choice:'not_important',expectedRevision:snapshot.importance.conversation.revision,operationId:crypto.randomUUID()});
 const ack=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/claim'));release();await ack;
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Check for important mail now'&&!button.disabled));
 await page.unroute('**/v1/notifications/installations/*/claim');
 check(await constructorCount(page)===2,'Queued correction suppresses construction after final independent claim recheck');
 check(db("select * from important_notification_web_deliveries where installation_id='"+id+"' and state='dead'").length>=1,'Server independently invalidates corrected claim');
 // A new owner cannot consume the previous owner's queued envelope.
 const ownerThread='owner-'+theme;await api(context,'/__fixture/fresh',{id:'browser-owner-'+theme,thread:ownerThread});
 let releaseOwner,ownerStarted;const ownerGate=new Promise(r=>releaseOwner=r),ownerClaimed=new Promise(r=>ownerStarted=r);let ownerHold=true;
 await page.route('**/v1/notifications/installations/*/claim',async route=>{if(ownerHold){ownerHold=false;const response=await route.fetch();assert(response.ok());ownerStarted();await ownerGate;return route.fulfill({response});}return route.continue();});
 await page.getByRole('button',{name:'Check for important mail now',exact:true}).click();await bounded(ownerClaimed,'owner claim');
 await context.request.get(origin+'/__fixture/login-other');const ownerAck=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/claim'));releaseOwner();await ownerAck;
 await page.getByRole('heading',{name:'Your signed-in account changed',exact:true}).waitFor();
 check(await constructorCount(page)===2,'Changed session owner never constructs old queued alert');
 check(await page.locator('.important-notification-settings,.desktop-account').count()===0,'Notification and shell account choices hide after ownership change');
 await page.unroute('**/v1/notifications/installations/*/claim');
 await screenshot(page,theme+'-owner-barrier');
 result.scenarios.push({theme,name:'adoption-reconcile-freshness-cooldown-correction-owner',installationId:id,actualConstructors:await page.evaluate(()=>window.__notifications),providerCalls:(await api(context,'/__fixture/state')).providerCalls});
 }catch(error){result.failures.push({theme,message:error.message,stack:error.stack});await screenshot(page,theme+'-failure').catch(()=>{});}
 finally{await context.close();}
}
for(const theme of ['light','dark'])for(const name of ['claim-report-response-loss','lease-expiry','same-policy-save','constructor-failure','superseded-settings']){
 const {context,page}=await makeContext(theme);
 try{
  if(name==='superseded-settings'){
   let original;
   await page.route('**/v1/notifications/installations/*',async route=>{
    if(route.request().method()!=='PUT')return route.continue();
    original=route.request().postDataJSON();const response=await route.fetch();assert(response.ok());const receipt=await response.json();
    await api(context,new URL(route.request().url()).pathname,{...original,enabled:false,expectedRevision:receipt.current.revision,operationId:crypto.randomUUID()},'PUT');
    return route.abort('failed');
   });
   const dialog=await configure(page);await dialog.getByRole('button',{name:'Enable important-only notifications',exact:true}).click();
   await page.getByText('A newer notification choice is current. Review it before changing again.',{exact:true}).waitFor();
   const id=await page.evaluate(()=>localStorage.getItem('orca:important-notifications:v1:u'));
   const current=await api(context,`/v1/notifications/installations/${id}?channel=open_app`);
   check(current.revision===2&&!current.policy.enabled,'Original settings reconcile renders newer paused policy');
   const writes=result.requests.filter(request=>request.body?.operationId===original.operationId&&request.method==='PUT');
   check(writes.length===1,'Superseded settings operation is not reapplied');
   await screenshot(page,theme+'-'+name);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  }else{
   const id=await adopt(page),thread=name+'-'+theme;
   await api(context,'/__fixture/fresh',{id:'fresh-'+thread,thread});
   if(name==='claim-report-response-loss'){
    let dropClaim=true,dropReport=true;
    await page.route('**/v1/notifications/installations/*/claim',async route=>{if(dropClaim){dropClaim=false;const response=await route.fetch();assert(response.ok());return route.abort('failed');}return route.continue();});
    await page.route('**/v1/notifications/installations/*/report',async route=>{if(dropReport){dropReport=false;const response=await route.fetch();assert(response.ok());return route.abort('failed');}return route.continue();});
    const start=result.requests.length;await checkNow(page);check(await constructorCount(page)===1,'Lost claim/report responses never duplicate construction');
    const calls=result.requests.slice(start),claims=calls.filter(request=>request.path.endsWith('/claim')),reports=calls.filter(request=>request.path.endsWith('/report'));
    check(claims.length===3&&new Set(claims.map(request=>request.body.operationId)).size===1,'Lost claim response retries original UUID then independently rechecks');
    check(reports.length===2&&JSON.stringify(reports[0].body)===JSON.stringify(reports[1].body),'Lost report acknowledgement retries original IDs and outcome');
   }else if(name==='constructor-failure'){
    await page.evaluate(()=>{const Native=Notification;window.Notification=new Proxy(Native,{construct(){throw new Error('Synthetic constructor failure boundary');}});});
    await checkNow(page);check(await constructorCount(page)===0,'Throwing constructor boundary constructs no notification');
    check(db("select * from important_notification_web_deliveries where installation_id='"+id+"' and state='failed'").length===1,'Constructor failure reports terminal failed state');
    await checkNow(page);check(await constructorCount(page)===0,'Failed notification is not replayed');
   }else{
    let release,started,finished,hold=true;const gate=new Promise(resolve=>release=resolve),claimed=new Promise(resolve=>started=resolve),released=new Promise(resolve=>finished=resolve);
    await page.route('**/v1/notifications/installations/*/claim',async route=>{if(hold){hold=false;const response=await route.fetch();assert(response.ok());started();await gate;await route.fulfill({response});finished();return;}return route.continue();});
    await page.getByRole('button',{name:'Check for important mail now',exact:true}).click();await bounded(claimed,name+' claim');
    if(name==='lease-expiry')await api(context,'/__fixture/advance',{milliseconds:31000});
    else{const current=await api(context,`/v1/notifications/installations/${id}?channel=open_app`);await api(context,`/v1/notifications/installations/${id}`,{channel:'open_app',policyVersion:1,enabled:true,accountIds:['a'],permission:'granted',expectedRevision:current.revision,operationId:crypto.randomUUID()},'PUT');}
    release();await bounded(released,name+' release');await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Check for important mail now'&&!button.disabled));
    check(await constructorCount(page)===(name==='lease-expiry'?0:1),name==='lease-expiry'?'Expired claim cannot construct late alert':'Identical current policy revision preserves valid same-generation claim');
    await page.unroute('**/v1/notifications/installations/*/claim');
   }
   check((await api(context,'/__fixture/state')).providerCalls===0,'Notification retry/failure does not invoke provider writes');
   await screenshot(page,theme+'-'+name);
  }
  result.scenarios.push({theme,name,actualConstructors:await page.evaluate(()=>window.__notifications)});
 }catch(error){result.failures.push({theme,name,message:error.message});await screenshot(page,theme+'-'+name+'-failure').catch(()=>{});}finally{await context.close();}
}
for(const permission of ['default','unavailable']){
 const {context,page}=await makeContext('light',permission);
 try{const before=db('select * from important_notification_installations');const dialog=await configure(page);await dialog.getByRole('button',{name:'Enable important-only notifications',exact:true}).click();await dialog.getByRole('alert').waitFor();
 check(JSON.stringify(db('select * from important_notification_installations'))===JSON.stringify(before),'Denied/unavailable permission leaves existing policies unchanged');
 check(await constructorCount(page)===0,'Denied/unavailable permission creates no browser notification');
 check(await page.evaluate(()=>window.__permissionRequests)===(permission==='default'?1:0),'Permission request only occurs for explicit supported Enable action');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();result.scenarios.push({name:'permission-'+permission});
 }catch(error){result.failures.push({permission,message:error.message});await screenshot(page,permission+'-failure').catch(()=>{});}finally{await context.close();}
}
}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}
process.exitCode=result.failures.length||result.pageErrors.length?1:0;
