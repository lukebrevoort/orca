/** Interrupted original authenticated identity: real U response held while cookie
 * becomes V, then guidance GET/Close must remain atomically bound to U. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});const result={revision:await webSourceIdentity(),scenarios:[],assertions:0,failures:[],pageErrors:[]};const check=(ok,label,detail)=>{result.assertions++;if(!ok)result.failures.push({label,detail});};
function db(reset=false){return JSON.parse(execFileSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if sys.argv[2]=='reset':
 c.execute("delete from user_preferences where user_id in ('u','v')");c.commit()
print(json.dumps([dict(r) for r in c.execute("select user_id,first_view_guidance_completed_at from user_preferences order by user_id")]))`,fixture.databasePath,reset?'reset':'read'],{encoding:'utf8'}));}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:390,height:844}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());db(true);await context.request.get(origin+'/__fixture/login');const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.message));
 let release,started,holding=true;const gate=new Promise(resolve=>release=resolve),held=new Promise(resolve=>started=resolve),identities=[],requests=[];
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/v1/preferences'&&url.searchParams.get('include')==='first_view_guidance')requests.push({method:request.method(),owner:request.headers()['x-orca-expected-user-id']??null});});
 await page.route('**/v1/auth/session',async route=>{if(!holding)return route.continue();const response=await route.fetch();assert(response.ok());const identity=await response.json();assert.equal(identity.user.id,'u');identities.push(identity);started();await gate;await route.fulfill({response}).catch(()=>{});});
 try{
  await page.goto(origin+'/?destination=organization-studio&section=views',{waitUntil:'domcontentloaded'});let timer;try{await Promise.race([held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Original identity response barrier exceeded 8s')),8000);})]);}finally{clearTimeout(timer);}
  await page.getByRole('heading',{name:'Checking your key.',exact:true}).waitFor();await context.request.get(origin+'/__fixture/login-other');const before=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json()),databaseBefore=db();assert.equal(before.firstViewGuidanceCompletedAt,null);
  holding=false;release();await page.waitForFunction(()=>document.querySelector('.desktop-account strong')?.textContent==='v');await page.getByRole('button',{name:'Getting started',exact:true}).click();const help=page.getByRole('dialog',{name:'Getting started with Views',exact:true});await help.getByRole('alert').waitFor();
  const rejected=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/preferences'&&response.request().method()==='PATCH');await help.getByRole('button',{name:'Close Getting started',exact:true}).click();const response=await rejected;
  const after=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json()),databaseAfter=db();
  check(response.status()===409,'Held original identity cannot authorize a replacement-owner guidance PATCH',{theme,status:response.status()});check(requests.length>=2&&requests.every(request=>request.owner==='u'),'Held identity keeps all guidance reads/writes bound to original U',{theme,requests});check(after.firstViewGuidanceCompletedAt===null,'Replacement V HTTP completion remains unchanged',{theme,after});check(JSON.stringify(databaseBefore)===JSON.stringify(databaseAfter),'Independent SQLite remains unchanged after held original identity',{theme,databaseBefore,databaseAfter});
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-held-identity.png')});result.scenarios.push({theme,identities,requests,status:response.status(),before,after,databaseBefore,databaseAfter});
 }catch(error){result.failures.push({theme,message:error.message});}finally{release();await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
