/** BRE-447 combined Settings guard + mobile navigation verification. Synthetic only. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const [origin,out]=process.argv.slice(2);
assert(['localhost','127.0.0.1'].includes(new URL(origin).hostname));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const result={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),browser:browser.version(),cases:[],writes:[],failures:[]};
try {
 for(const theme of ['light','dark']) {
  const context=await browser.newContext({viewport:{width:390,height:900},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'});
  await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
  await context.route('**/*',route=>{
   const request=route.request(),url=new URL(request.url());
   if(url.pathname.startsWith('/v1/')&&!['GET','HEAD'].includes(request.method())) result.writes.push({method:request.method(),path:url.pathname});
   return url.origin===origin&&!url.pathname.startsWith('/v1/')?route.continue():route.abort();
  });
  const page=await context.newPage();await page.goto(`${origin}/dev/settings#writing`);
  const signature=page.getByRole('textbox',{name:'Default signature'});
  const leaveDialog=page.getByRole('dialog',{name:'Leave without saving account choices?'});
  const more=page.getByRole('button',{name:/^Open Mailboxes/});
  const navDialog=page.getByRole('dialog',{name:'Mailboxes'});
  await signature.fill(`Combined ${theme} edit`);
  await more.click();await navDialog.waitFor();
  await page.getByRole('menuitem',{name:/^All Mail(?:\s*[0-9]+)?$/}).click();
  await leaveDialog.waitFor();assert.equal(await navDialog.count(),0);
  await page.getByRole('button',{name:'Stay in Settings',exact:true}).click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await signature.inputValue(),`Combined ${theme} edit`);
  assert(await page.getByRole('button',{name:'Save account choices',exact:true}).isEnabled());
  assert(await signature.evaluate(el=>el===document.activeElement),'Stay returns to edited signature after navigation modal closes');
  await more.click();await navDialog.waitFor();
  await page.getByRole('menuitem',{name:/^All Mail(?:\s*[0-9]+)?$/}).click();
  await leaveDialog.waitFor();
  await page.screenshot({path:`${out}/${theme}-settings-navigation-guard.png`});
  const nativeDialogs=[];
  page.on('dialog',async dialog=>{nativeDialogs.push(dialog.type());await dialog.dismiss();});
  await page.getByRole('button',{name:'Leave without saving',exact:true}).click();
  await page.waitForURL(url=>url.pathname==='/dev/inbox'&&url.searchParams.get('destination')==='all');
  assert.equal(nativeDialogs.length,0,'Explicit leave requires no second native confirmation');
  const mobile=page.getByRole('navigation',{name:'Mobile primary',exact:true});
  await mobile.getByRole('button',{name:/^Mail$/}).click();
  assert.equal(await mobile.locator('[aria-current="page"]').count(),1);
  assert.equal(await more.getAttribute('data-has-current'),null);
  assert.equal(await more.getAttribute('aria-label'),'Open Mailboxes. Current: Important');
  await page.screenshot({path:`${out}/${theme}-inbox-current.png`});
  result.cases.push({theme,pass:true,journeys:['More→All Mail→Stay preserves edit and focus','Repeated More→All Mail→Leave once','Inbox has one current marker'],nativeDialogs});
  await context.close();
 }
 assert.equal(result.writes.length,0,'Navigation never writes API data');
} catch(error) {result.failures.push(String(error));throw error;}
finally {await browser.close();await writeFile(`${out}/results.json`,JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));
