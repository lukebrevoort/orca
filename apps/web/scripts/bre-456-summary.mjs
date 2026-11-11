/** P15 current production snapshot: real cards/open/return/freshness/errors.
 * Waiting/codes and enabled reply-review are explicitly unavailable, not passes. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});const result={revision:await webSourceIdentity(),scenarios:[],assertions:0,failures:[],requests:[],pageErrors:[],notApplicable:['Waiting and codes: unavailable in canonical P15 current base','Enabled reply-review-specific behavior: PR295 is unintegrated draft']};
const check=(ok,label)=>{result.assertions++;assert(ok,label);};
function db(sql,params=[]){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;r=[dict(x) for x in c.execute(sys.argv[2],json.loads(sys.argv[3]))];c.commit();print(json.dumps(r))',join(fixture.directory,'mail.sqlite'),sql,JSON.stringify(params)],{encoding:'utf8'}));}
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await context.request.get(origin+'/__fixture/login');
 const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/'))result.requests.push({theme,path:new URL(r.url()).pathname,query:new URL(r.url()).search,method:r.method()});});
 try{
  db("update emails set subject='first account conversation' where id='first-message'");db("update threads set subject='first account conversation' where id='first-thread'");
  for(const accountId of ['first','second']){const response=await context.request.post(origin+'/v1/drafts?accountId='+accountId,{data:{subject:'Summary '+accountId+' '+theme,body:{text:'Unsent synthetic snapshot draft',html:null}}});assert(response.ok());}
  await page.goto(origin+'/?destination=summary');const summary=page.locator('.summary-page');await summary.getByRole('button',{name:'Open message: first account conversation',exact:true}).waitFor();
  check((await summary.innerText()).includes('For first@example.com'),'P15 snapshot identifies current account');
  check(await summary.getByRole('button',{name:'Open draft: Summary second '+theme,exact:true}).count()===0,'P15 excludes second-account saved drafts');
  check((await summary.innerText()).includes('Waiting and codes are not available here yet.'),'P15 unavailable boundary is truthful');
  check(await summary.getByRole('button',{name:/Draft follow-up|Approve reply/}).count()===0,'P15 does not present unavailable reply-review actions');
  const openMessage=summary.getByRole('button',{name:'Open message: first account conversation',exact:true});await openMessage.click();await page.locator('.message-reader').waitFor();await page.getByRole('navigation',{name:'Reader controls',exact:true}).getByRole('button',{name:'Summary',exact:true}).click();await openMessage.waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  check(await openMessage.evaluate(node=>node===document.activeElement),'P15 reader returns focus to actual source card');
  const draft=summary.getByRole('button',{name:'Open draft: Summary first '+theme,exact:true});await draft.click();await page.locator('.compose-workspace-panel').waitFor();check(await page.locator('.compose-workspace-panel').getByRole('textbox',{name:'Subject',exact:true}).inputValue()==='Summary first '+theme,'P15 opens exact saved draft without inventing a reply');await page.keyboard.press('Escape');await page.locator('.compose-workspace-panel').waitFor({state:'hidden'});await draft.waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  check(await draft.evaluate(node=>node===document.activeElement),'P15 draft close restores source-card focus');
  const changed='Fresh snapshot '+theme;db('update emails set subject=? where id=?',[changed,'first-message']);db('update threads set subject=? where id=?',[changed,'first-thread']);
  check(await openMessage.count()===1,'P15 snapshot stays stable until explicit refresh');await summary.getByRole('button',{name:'Refresh Summary',exact:true}).click();await summary.getByRole('button',{name:'Open message: '+changed,exact:true}).waitFor();
  let failed=true;await page.route('**/v1/inbox?*',route=>new URL(route.request().url()).searchParams.get('classification')==='human'&&failed?route.abort('internetdisconnected'):route.continue());await summary.getByRole('button',{name:'Refresh Summary',exact:true}).click();await summary.getByRole('alert').filter({hasText:'Mail could not be loaded.'}).waitFor();
  check(await summary.getByRole('button',{name:'Open draft: Summary first '+theme,exact:true}).isVisible(),'P15 scoped mail error retains independently loaded draft cards');
  failed=false;await summary.getByRole('button',{name:'Try again',exact:true}).click();await summary.getByRole('button',{name:'Open message: '+changed,exact:true}).waitFor();await page.unroute('**/v1/inbox?*');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-summary-mobile.png')});check(await summary.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'P15 cards reflow without content loss');
  let release,started,finished,hold=true;const gate=new Promise(resolve=>release=resolve),held=new Promise(resolve=>started=resolve),released=new Promise(resolve=>finished=resolve);
  await page.route('**/v1/inbox?*',async route=>{if(hold&&new URL(route.request().url()).searchParams.get('classification')==='human'){hold=false;const response=await route.fetch();assert(response.ok());started();await gate;await route.fulfill({response});finished();return;}return route.continue();});
  await summary.getByRole('button',{name:'Refresh Summary',exact:true}).click();let timer;try{await Promise.race([held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('P15 stale response barrier exceeded 8s')),8000);})]);}finally{clearTimeout(timer);}
  await page.getByRole('navigation',{name:'Mail filters',exact:true}).getByRole('button',{name:'All Mail',exact:true}).click();release();await released;await page.locator('.inbox-view').waitFor();check(await page.locator('.summary-page').count()===0,'P15 late response cannot reinstall the previous surface');await page.unroute('**/v1/inbox?*');
  const deliveries=await context.request.get(origin+'/__fixture/deliveries').then(r=>r.json());check(deliveries.length===0,'P15 never sends synthetic mail');result.scenarios.push({theme,syntheticDeliveries:deliveries.length,fixtureDraftSeeds:2,providerMirrorCalls:'not instrumented by this fixture; no total-provider-work claim'});
 }catch(error){result.failures.push({theme,message:error.message});await page.screenshot({path:join(out,theme+'-failure.png')}).catch(()=>{});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors,notApplicable:result.notApplicable}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
