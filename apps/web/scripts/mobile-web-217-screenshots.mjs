/** Diagnostic-only rendered evidence. Product code equals PR217 d6e63ffc.
 * Requires an isolated GitHub-hosted job. No real data, providers or deployments.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only in the authorized isolated hosted workflow');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Use a disposable GitHub-hosted runner');
const sourceSha = 'd6e63ffcebd66a6ddec4e705a701d62ab71217c1';
execFileSync('git', ['diff','--exit-code',sourceSha,'HEAD','--','apps/web/src','apps/web/public','apps/web/index.html','apps/web/vite.config.ts','apps/web/package.json','apps/api/src','apps/api/drizzle','packages','bun.lock','package.json']);
const out = resolve(process.argv[2]);
await mkdir(out, { recursive: false, mode: 0o700 });
const work = await mkdtemp(join(process.env.RUNNER_TEMP, 'mobile217-private-'));
const fixtureProcess = spawn('bun', ['--no-env-file','apps/api/scripts/mobile-web-217-fixture.ts'], {env:{...process.env,TMPDIR:work},stdio:['ignore','pipe','pipe']});
let fixtureOutput = ''; let fixtureError = ''; let browser; let activePage; let token;
fixtureProcess.stdout.on('data', b => {fixtureOutput += b});
fixtureProcess.stderr.on('data', b => {fixtureError += b});
const results={sourceSha,diagnosticSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),syntheticOnly:true,platform:'mobile web in Chromium; not native iOS',startedAt:new Date().toISOString(),cases:[],pageErrors:[],blockedOrigins:[],limitations:['Native Safari keyboard and device safe areas were not tested','Screenshots and focused layout/interaction checks are not a full release or regression sign-off']};
async function poll(fn, timeout=20000) { const end=Date.now()+timeout; while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for synthetic fixture or rendered state'); }
async function capture(page,name){await page.screenshot({path:join(out,name+'.png'),animations:'disabled',fullPage:false});}
async function geometry(page){return page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,theme:document.documentElement.dataset.theme,density:document.documentElement.dataset.readerDensity}));}
try {
  const connectionFile = await poll(()=>fixtureOutput.split('\n').map(s=>s.trim()).find(s=>s.endsWith('/connection.json')));
  const fixture = JSON.parse(await readFile(connectionFile,'utf8')); token=fixture.token;
  const origin=new URL(fixture.url); assert.equal(origin.hostname,'127.0.0.1'); assert.equal(origin.protocol,'http:');
  browser=await chromium.launch({headless:true,args:['--disable-background-networking']}); results.browserVersion=browser.version();
  const matrix=[{width:390,height:844,density:'calm'},{width:320,height:740,density:'calm'},{width:320,height:740,density:'compact'},{width:1440,height:1000,density:'calm'}];
  for(const theme of ['light','dark']) for(const viewport of matrix){
    const {density,...size}=viewport; const label=`${size.width}-${theme}-${density}`;
    const result={label,viewport:size,theme,density,checks:[]};results.cases.push(result);
    const context=await browser.newContext({viewport:size,deviceScaleFactor:1,colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'});
    await context.addInitScript(({theme,density})=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,density,motion:'reduced'})),{theme,density});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin.origin)return route.continue();results.blockedOrigins.push(url.origin);return route.abort();});
    const page=await context.newPage();activePage=page;page.setDefaultTimeout(15000);
    page.on('pageerror',e=>results.pageErrors.push({label,message:e.message}));
    try {
      const login=await context.request.get(origin.origin+'/__fixture/login');assert(login.ok());
      const session=await context.request.get(origin.origin+'/v1/auth/session');assert.equal((await session.json()).user?.id,'compose-fixture-user');
      // Dismiss only synthetic onboarding state, and clear earlier synthetic drafts.
      await context.request.patch(origin.origin+'/v1/preferences?include=first_view_guidance',{data:{firstViewGuidanceCompletedAt:new Date().toISOString()}});
      const drafts=await context.request.get(origin.origin+'/v1/drafts?accountId=first');
      for(const draft of await drafts.json()) await context.request.delete(origin.origin+`/v1/drafts/${draft.id}?accountId=first`);
      await page.goto(origin.origin+'/');
      await page.locator('.message-row').filter({hasText:'A quieter place to write'}).waitFor();
      await page.evaluate(()=>document.fonts.ready);
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      assert.equal(await page.locator('html').getAttribute('data-reader-density'),density);
      result.inbox=await geometry(page);await capture(page,`${label}-inbox`);
      assert(result.inbox.documentWidth<=size.width+1,'Inbox horizontal overflow');result.checks.push('inbox no horizontal overflow');
      const compose=size.width<760?page.locator('.mobile-mail-compose'):page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).filter({visible:true}).first();
      await compose.click();const panel=page.locator('.compose-workspace-panel');await panel.waitFor();
      const subject=panel.getByRole('textbox',{name:'Subject',exact:true});await subject.waitFor();
      await panel.getByRole('combobox',{name:'Message format'}).selectOption('plain');
      await panel.getByRole('combobox',{name:'Add To recipient'}).fill('maya@example.com');await panel.getByRole('combobox',{name:'Add To recipient'}).press('Enter');
      await subject.fill('A quieter inbox');
      await panel.getByRole('textbox',{name:'Message body',exact:true}).fill('Hi Maya,\n\nHere’s the latest mobile direction. I’d love your thoughts on the inbox and writing space.\n\nAlex');
      await panel.getByText('Saved to Orca and Gmail',{exact:true}).waitFor();
      await page.getByRole('heading',{name:'New message',exact:true}).click();
      await page.locator('.panel-body').evaluate(el=>{el.scrollTop=0;});
      result.compose=await geometry(page);await capture(page,`${label}-compose`);
      assert(result.compose.documentWidth<=size.width+1,'Compose horizontal overflow');result.checks.push('compose no horizontal overflow; synthetic draft saved');
      await panel.getByRole('button',{name:'Add Cc or Bcc'}).click();
      await panel.getByRole('combobox',{name:'Add Cc recipient'}).fill('design-review-team-with-a-long-address@example.com');await panel.getByRole('combobox',{name:'Add Cc recipient'}).press('Enter');
      await panel.getByRole('combobox',{name:'Add Bcc recipient'}).fill('review@example.com');await panel.getByRole('combobox',{name:'Add Bcc recipient'}).press('Enter');
      await page.getByRole('heading',{name:'New message',exact:true}).click();await page.locator('.panel-body').evaluate(el=>{el.scrollTop=0;});
      await capture(page,`${label}-compose-long-recipients`);
      await page.getByRole('button',{name:'Open in Zen',exact:true}).click();await page.getByRole('dialog',{name:'Zen writing mode',exact:true}).waitFor();
      await capture(page,`${label}-zen`);
      await page.getByRole('button',{name:'Save & close',exact:true}).click();
      await page.getByRole('dialog',{name:'Zen writing mode',exact:true}).waitFor({state:'hidden'});
      // Zen closes only the expanded view; closing the panel preserves the draft.
      if(await page.getByRole('button',{name:'Close panel',exact:true}).isVisible()) await page.getByRole('button',{name:'Close panel',exact:true}).click();
      await page.locator('.compose-workspace-panel').waitFor({state:'hidden'});
      await compose.click();await panel.waitFor();assert.equal(await subject.inputValue(),'A quieter inbox');
      result.checks.push('Cc/Bcc long recipient chips; Zen open/close; compose reopen retained draft');
      await page.getByRole('button',{name:'Close panel',exact:true}).click();await panel.waitFor({state:'hidden'});
      if(size.width<760){
        await page.locator('.desktop-mobile-more').click();
        await page.getByRole('menuitem',{name:'Settings',exact:true}).waitFor();
        await capture(page,`${label}-more`);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog',{name:'Navigation menu',exact:true}).waitFor({state:'hidden'});
        await page.locator('.message-row').last().scrollIntoViewIfNeeded();
        const box=await compose.boundingBox();assert(box&&box.y>=0&&box.y+box.height<=size.height,'Compose must stay visible after inbox scroll');
        result.checks.push('More exposes Settings; Escape closes menu; Compose remains visible after inbox scroll');
      }
      result.status='passed';
    }catch(error){result.status='failed';result.error=error.message;await capture(page,`${label}-failure`).catch(()=>{});}
    finally{await context.close();activePage=null;}
  }
  results.status=results.cases.every(c=>c.status==='passed')&&results.pageErrors.length===0?'passed':'failed';
}catch(error){results.status='failed';results.error=error.message;if(activePage)await capture(activePage,'failure').catch(()=>{});}
finally{
  if(browser)await browser.close();fixtureProcess.kill('SIGTERM');
  await new Promise(r=>{if(fixtureProcess.exitCode!==null)return r();fixtureProcess.once('exit',r);setTimeout(r,3000);});
  await rm(work,{recursive:true,force:true});
  // No raw fixture logs, databases, connection metadata, cookies, storage or traces are exported.
  await writeFile(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
  for(const file of await readdir(out)){const bytes=await readFile(join(out,file));if(token&&bytes.includes(Buffer.from(token))){await rm(out,{recursive:true,force:true});throw new Error('Refusing evidence containing ephemeral credentials');}}
}
console.log(JSON.stringify({status:results.status,sourceSha,cases:results.cases.map(c=>({label:c.label,status:c.status,error:c.error}))},null,2));
if(results.status!=='passed')process.exitCode=1;
