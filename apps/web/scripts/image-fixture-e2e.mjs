/** Full-app image flow using the loopback --images fixture and a fresh browser.
 * node image-fixture-e2e.mjs <connection.json> <new-evidence-directory> <tested-sha>
 * Real API, SQLite, origin guard, revision checks and UI; downloader is a synthetic
 * in-process boundary. No real mailbox, DNS lookup or sender request is used.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [connectionFile, evidenceDirectory, testedSha] = process.argv.slice(2);
assert(connectionFile && evidenceDirectory && /^[a-f0-9]{40}$/.test(testedSha ?? ''), 'Connection, evidence directory, and tested SHA required');
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),testedSha,'Fixture must run on the declared commit');
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'', 'Fixture requires a clean checkout');
const buildProof=JSON.parse(await readFile(process.env.ORCA_IMAGE_BUILD_PROOF ?? '', 'utf8'));
assert.equal(buildProof.commit,testedSha,'Build proof must name the tested commit');
for(const [path,expected] of Object.entries(buildProof.files)){
 assert(/^apps\/web\/dist\/(?:index\.html|assets\/index-[A-Za-z0-9_-]+\.js)$/.test(path),'Unexpected build proof path');
 assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),expected,'Built asset changed after build');
}
assert.equal(Object.keys(buildProof.files).length,2,'Expected index and entry bundle hashes');
const fixture=JSON.parse(await readFile(connectionFile,'utf8'));const origin=new URL(fixture.url);
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.pathname,'/');
const output=resolve(evidenceDirectory);await mkdir(output,{recursive:false});
const moduleName=process.env.ORCA_PLAYWRIGHT_MODULE;
const {chromium}=await import(moduleName?.startsWith('/') ? pathToFileURL(moduleName).href : moduleName ?? 'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-background-networking']});
const context=await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block',recordVideo:{dir:output,size:{width:1280,height:1000}}});
const blocked=[],errors=[];
await context.addInitScript(()=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:'light',motion:'reduced'})));
await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin.origin)return route.continue();blocked.push(url.origin);return route.abort();});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
const counts=async()=>{const response=await context.request.get(new URL('/__fixture/image-counts',origin).href);assert.equal(response.status(),200);return response.json();};
const pause=async()=>page.waitForTimeout(700);
const capture=async name=>{await page.screenshot({path:join(output,`${name}.png`),fullPage:true});};
const waitForCounts=async predicate=>{for(let i=0;i<100;i++){const current=await counts();if(predicate(current))return current;await page.waitForTimeout(50);}throw new Error('Synthetic image counter did not reach expected state');};
try {
  await page.goto(new URL('/__fixture/login',origin).href);
  await page.getByText('Synthetic image newsletter',{exact:true}).first().click();
  await page.getByRole('button',{name:'Load images',exact:true}).waitFor();await pause();
  assert.deepEqual(await counts(),{png:0,jpeg:0,slow:0,cancelled:0});
  assert.equal(await page.locator('.reader-body-html img').count(),0);await capture('01-before-consent');

  // Change only the stored synthetic message; a stale click must not download.
  assert.equal((await context.request.post(new URL('/__fixture/image-source',origin).href)).status(),204);
  await page.getByRole('button',{name:'Load images',exact:true}).click();
  await page.getByRole('button',{name:'Refresh message',exact:true}).waitFor();
  assert.deepEqual(await counts(),{png:0,jpeg:0,slow:0,cancelled:0});await capture('02-stale');await pause();
  await page.getByRole('button',{name:'Refresh message',exact:true}).click();
  await page.getByText('Updated synthetic newsletter.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Load images',exact:true}).waitFor();
  assert.deepEqual(await counts(),{png:0,jpeg:0,slow:0,cancelled:0});await capture('03-refreshed-blocked');await pause();

  await page.getByRole('button',{name:'Load images',exact:true}).evaluate(button=>{button.click();button.click();});
  await page.getByRole('button',{name:'Retry images',exact:true}).waitFor();
  assert.deepEqual(await counts(),{png:1,jpeg:1,slow:0,cancelled:0});
  assert.equal(await page.locator('.reader-body-html img[src^="data:image/png;base64,"]').count(),1);
  assert.equal(await page.locator('.reader-body-html img[src^="data:image/jpeg;base64,"]').count(),0);
  await capture('04-partial');await pause();
  await page.getByRole('button',{name:'Retry images',exact:true}).click();
  await page.getByText('2 images loaded.',{exact:false}).waitFor();
  assert.deepEqual(await counts(),{png:1,jpeg:2,slow:0,cancelled:0});
  assert.equal(await page.locator('.reader-body-html img[src^="data:image/png;base64,"]').count(),1);
  assert.equal(await page.locator('.reader-body-html img[src^="data:image/jpeg;base64,"]').count(),1);
  await capture('05-success');await pause();

  await page.locator('.reader-back').click();
  await page.getByText('Second synthetic conversation',{exact:true}).first().click();
  await page.getByRole('button',{name:'Load images',exact:true}).waitFor();
  assert.deepEqual(await counts(),{png:1,jpeg:2,slow:0,cancelled:0});await capture('06-other-blocked');
  await page.getByRole('button',{name:'Load images',exact:true}).click();
  await waitForCounts(value=>value.slow===1);await page.locator('.reader-back').click();
  await page.getByText('Synthetic image newsletter',{exact:true}).first().click();
  await page.getByRole('button',{name:'Load images',exact:true}).waitFor();
  await waitForCounts(value=>value.cancelled===1);
  assert.deepEqual(await counts(),{png:1,jpeg:2,slow:1,cancelled:1});
  assert.equal(await page.locator('.reader-body-html img').count(),0);await capture('07-switched-back');await pause();
  assert.deepEqual(errors,[],'Browser must not report JavaScript errors');
  const video=page.video();await page.close();const videoPath=await video.path();
  await writeFile(join(output,'manifest.json'),JSON.stringify({commit:testedSha,buildProof,syntheticOnly:true,scope:'Full built Orca web app, real local API/SQLite/auth/origin and revision handling; image download boundary injected with synthetic bytes/failure and no sender/DNS network',browser:browser.version(),videoPath,externalOriginsBlocked:blocked.length,counts:await counts(),checks:['zero pre-consent requests','stale refresh requires new consent','PNG/JPEG partial and retry','retained PNG is not fetched again','leaving and reopening a different message cancels a pending synthetic image load']},null,2));
  console.log(JSON.stringify({status:'pass',commit:testedSha,videoPath,externalOriginsBlocked:blocked.length}));
} finally { await context.close();await browser.close(); }
