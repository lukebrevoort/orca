/** Production corner feedback with a loopback API and synthetic Linear. No live tickets. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const [connectionFile,outputDirectory]=process.argv.slice(2);
assert(connectionFile && outputDirectory);
const {url}=JSON.parse(await readFile(connectionFile,'utf8'));
const origin=new URL(url);
assert(origin.protocol==='http:' && origin.hostname==='127.0.0.1' && origin.pathname==='/');
const out=resolve(outputDirectory);await mkdir(out,{recursive:false});
const results={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),startedAt:new Date().toISOString(),syntheticOnly:true,scenarios:[],pageErrors:[],externalRequestsBlocked:[]};
const browser=await chromium.launch({executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE||undefined,headless:true});
results.browser=browser.version();let current;
async function api(context,path,method='GET',data){const response=await context.request.fetch(url+path,{method,data,headers:{origin:url}});assert(response.ok(),`${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function shot(page,name){await page.screenshot({path:join(out,name+'.png')});}
async function setup(theme,width,user='first'){
 const context=await browser.newContext({viewport:{width,height:844},colorScheme:theme,serviceWorkers:'block'});
 await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);
 await context.route('**/*',route=>{const target=new URL(route.request().url());if(target.origin===origin.origin)return route.continue();results.externalRequestsBlocked.push(target.origin);return route.abort();});
 const page=await context.newPage();current=page;page.on('pageerror',error=>results.pageErrors.push({message:error.message,url:page.url()}));
 await page.goto(url+'/__fixture/login?user='+user,{waitUntil:'networkidle'});
 return {context,page};
}
try{
 for(const theme of ['light','dark'])for(const width of [1440,390,320]){
  const {context,page}=await setup(theme,width);
  const trigger=page.getByRole('button',{name:'Feedback',exact:true});await trigger.waitFor();
  assert.equal(await page.getByRole('heading',{name:'Your feedback',exact:true}).count(),0,'No queue/dashboard');
  const bounds=await trigger.boundingBox();assert(bounds && bounds.x+bounds.width<=width && bounds.y+bounds.height<=844,'Corner button in viewport');
  await shot(page,`${theme}-${width}-corner`);
  await trigger.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Send feedback',exact:true});await dialog.waitFor();
  const message=dialog.getByLabel('Your feedback',{exact:true});
  assert.equal(await dialog.locator('textarea').count(),1,'One message composer');
  assert.equal(await dialog.locator('input,select').count(),0,'No title/type form');
  const send=dialog.getByRole('button',{name:'Send to Linear',exact:true});assert(await send.isDisabled());
  const text=`Synthetic ${theme} ${width}: make the next action easier to find.`;
  await message.fill(text);await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Feedback');
  await trigger.click();await dialog.waitFor();assert.equal(await message.inputValue(),text,'Close/reopen preserves draft');
  await send.hover();await shot(page,`${theme}-${width}-composer`);await send.focus();
  assert.notEqual(await send.evaluate(element=>getComputedStyle(element).outlineStyle),'none','Focus visible');
  for(let i=0;i<6;i++)await page.keyboard.press('Tab');
  assert(await dialog.evaluate(element=>element.contains(document.activeElement)),'Focus stays in composer');
  const submissionIds=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/v1/feedback/ticket' && request.method()==='POST')submissionIds.push(request.postDataJSON().id);});
  const before=await api(context,'/__fixture/deliveries');
  await api(context,'/__fixture/delivery','POST',{outcome:'failure'});
  await send.evaluate(button=>{button.click();button.click();});await dialog.getByRole('alert').waitFor();
  assert.equal((await api(context,'/__fixture/deliveries')).length,before.length,'Failure creates no ticket');
  assert.equal(await dialog.getByRole('link',{name:/BRE-FIXTURE/}).count(),0,'No false receipt');
  assert.equal(await message.inputValue(),text);await shot(page,`${theme}-${width}-failure`);
  await api(context,'/__fixture/delivery','POST',{outcome:'success'});
  let firstId;let calls=0;let release;const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/v1/feedback/ticket',async route=>{
   if(route.request().method()!=='POST')return route.continue();
   calls++;const data=route.request().postDataJSON();
   if(!firstId){firstId=data.id;const response=await route.fetch();assert(response.ok());await held;return route.abort('failed');}
   assert.equal(data.id,firstId,'Retry keeps original ID');return route.continue();
  });
  await dialog.getByRole('button',{name:/^(Retry submission|Send to Linear)$/}).evaluate(button=>{button.click();button.click();});
  await dialog.getByRole('button',{name:/Sending|Submitting/}).waitFor();await shot(page,`${theme}-${width}-sending`);release();
  await dialog.getByRole('alert').waitFor();assert.equal(calls,1,'Double click sends once');
  assert.equal((await api(context,'/__fixture/deliveries')).length,before.length+1,'Ticket exists after lost response');
  await dialog.getByRole('button',{name:/^(Retry submission|Send to Linear)$/}).click();
  const link=dialog.getByRole('link',{name:/BRE-FIXTURE/});await link.waitFor();assert.equal(calls,2);
  assert.equal(new Set(submissionIds).size,1,'Failure and lost-response retries preserve original submission ID');
  const after=await api(context,'/__fixture/deliveries');assert.equal(after.length,before.length+1,'Retry does not duplicate');
  assert.equal(after.at(-1).message,text);assert.equal(await link.getAttribute('href'),`https://linear.app/fixture/issue/${after.at(-1).issueId}`);
  await shot(page,`${theme}-${width}-sent`);
  const overflow=await page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth}));assert(overflow.body<=overflow.width+1,'No overflow');
  if(width===1440){await page.goto(url+'/',{waitUntil:'networkidle'});await page.getByRole('button',{name:'Feedback',exact:true}).waitFor();await page.getByText('No mail in Inbox yet',{exact:true}).waitFor();await shot(page,`${theme}-inbox-corner`);}
  results.scenarios.push(`${theme}/${width}: corner, single message, focus, close/reopen draft, failure, double click, lost response same-ID retry, confirmed Linear link`);
  await context.close();
 }
 const {context:other,page:otherPage}=await setup('light',390,'second');
 assert.equal((await api(other,'/v1/feedback/ticket')).available,false);
 assert.equal(await otherPage.getByRole('button',{name:'Feedback',exact:true}).count(),0,'Other user has no affordance');
 await shot(otherPage,'other-user-no-feedback');await other.close();
 const anonymous=await browser.newContext();const page=await anonymous.newPage();current=page;
 await page.goto(url+'/login',{waitUntil:'networkidle'});
 assert.equal(await page.getByRole('button',{name:'Feedback',exact:true}).count(),0,'Signed-out has no affordance');
 assert.equal((await anonymous.request.get(url+'/v1/feedback/ticket')).status(),401);await anonymous.close();
 assert.deepEqual(results.pageErrors,[]);results.status='passed';
}catch(error){results.status='failed';results.error=String(error.stack||error);if(current&&!current.isClosed())await shot(current,'failure').catch(()=>{});throw error;}
finally{results.finishedAt=new Date().toISOString();await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify({status:results.status,scenarios:results.scenarios,evidence:out},null,2));
