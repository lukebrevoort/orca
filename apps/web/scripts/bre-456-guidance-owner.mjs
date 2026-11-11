/** CORE03 audit only: real mounted-U guidance -> V cookie -> dismiss.
 * No preference success mocks; HTTP plus independently opened SQLite. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});
const result={revision:await webSourceIdentity(),scenarios:[],assertions:0,failures:[],requests:[],pageErrors:[]};
const check=(ok,label,detail)=>{result.assertions++;if(!ok)result.failures.push({label,detail});};
function db(reset=false){return JSON.parse(execFileSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if sys.argv[2]=='reset':
 c.execute("delete from user_preferences where user_id in ('u','v')");c.commit()
print(json.dumps([dict(r) for r in c.execute("select user_id,first_view_guidance_completed_at from user_preferences where user_id in ('u','v') order by user_id")]))`,fixture.databasePath,reset?'reset':'read'],{encoding:'utf8'}));}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark'])for(const action of ['skip','close']){
 const context=await browser.newContext({viewport:{width:1024,height:900}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname==='/v1/preferences')result.requests.push({theme,action,method:request.method(),expectedOwner:request.headers()['x-orca-expected-user-id']??null,body:request.postDataJSON()});});
 try{
  db(true);await context.request.get(origin+'/__fixture/login-other');const originalV=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json());
  await context.request.get(origin+'/__fixture/login');const originalU=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json());const identity=await context.request.get(origin+'/v1/auth/session').then(response=>response.json());
  assert.equal(identity.user.id,'u');assert.equal(originalU.firstViewGuidanceCompletedAt,null);assert.equal(originalV.firstViewGuidanceCompletedAt,null);
  await page.goto(origin+'/?destination=organization-studio&section=views');await page.waitForFunction(()=>document.querySelector('.desktop-account strong')?.textContent==='u');await page.getByRole('button',{name:'Getting started',exact:true}).click();const help=page.getByRole('dialog',{name:'Getting started with Views',exact:true});await help.getByRole('button',{name:'Skip for now',exact:true}).waitFor();
  await context.request.get(origin+'/__fixture/login-other');const replacement=await context.request.get(origin+'/v1/auth/session').then(response=>response.json());assert.equal(replacement.user.id,'v');
  const before=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json()),databaseBefore=db();assert.equal(before.firstViewGuidanceCompletedAt,null);
  const requestStart=result.requests.length,ack=page.waitForResponse(response=>new URL(response.url()).pathname==='/v1/preferences'&&response.request().method()==='PATCH');
  await help.getByRole('button',{name:action==='skip'?'Skip for now':'Close Getting started',exact:true}).click();const response=await ack,body=response.ok()?await response.json():{status:response.status(),note:"Non-2xx browser body is not consumed by the product helper; verify status, original-owner header and independent HTTP/SQLite instead."};
  const after=await context.request.get(origin+'/v1/preferences?include=first_view_guidance').then(response=>response.json()),databaseAfter=db();
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+action+'.png')});
  const writes=result.requests.slice(requestStart).filter(request=>request.method==='PATCH');
  result.scenarios.push({theme,action,identity:identity.user.id,replacement:replacement.user.id,originalU,originalV,before,after,databaseBefore,databaseAfter,patch:{status:response.status(),body,writes}});
  check(response.status()===409,'Atomic owner guard rejects the stale guidance PATCH',{theme,action,status:response.status()});
  check(writes.length===1&&writes[0].expectedOwner==='u','Dismissal keeps the original verified owner precondition',{theme,action,writes});
  check(after.firstViewGuidanceCompletedAt===before.firstViewGuidanceCompletedAt,'Mounted U guidance dismissal never completes replacement V guidance',{theme,action,before,after});
  check(JSON.stringify(databaseAfter)===JSON.stringify(databaseBefore),'Independent SQLite preferences remain unchanged after cross-owner guidance dismissal',{theme,action,databaseBefore,databaseAfter});
 }catch(error){result.failures.push({theme,action,message:error.message,body:await page.locator('body').innerText().catch(()=>null)});await page.screenshot({path:join(out,theme+'-'+action+'-precondition-failure.png')}).catch(()=>{});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}
process.exitCode=result.failures.length||result.pageErrors.length?1:0;
