/** Synthetic full-app latency measurements. No sender/DNS network is permitted. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [connectionFile,directory,sha]=process.argv.slice(2);
assert(/^[a-f0-9]{40}$/.test(sha??''));
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sha);
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'');
const proof=JSON.parse(await readFile(process.env.ORCA_IMAGE_BUILD_PROOF,'utf8'));
assert.equal(proof.commit,sha);
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){assert(!e.isSymbolicLink());const p=`${dir}/${e.name}`;if(e.isDirectory())out.push(...await walk(p));else {assert(e.isFile());out.push(p);}}return out;}
assert.deepEqual(Object.keys(proof.files).sort(),(await walk('apps/web/dist')).sort());
for(const [path,hash] of Object.entries(proof.files))assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),hash);
const fixture=JSON.parse(await readFile(connectionFile,'utf8')), origin=new URL(fixture.url);
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');
const output=resolve(directory);await mkdir(output,{recursive:false});
const mod=process.env.ORCA_PLAYWRIGHT_MODULE;
const {chromium}=await import(mod?.startsWith('/')?pathToFileURL(mod).href:mod??'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-background-networking']});
const measurements=[],errors=[];let blocked=0;
const scenarioNames=['small','many','slowFirst','slowLastFailure'];
try {
 for(const scenario of scenarioNames){for(let run=0;run<3;run++){
  const context=await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block',...(run===0?{recordVideo:{dir:output,size:{width:1280,height:1000}}}:{})});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin.origin)return route.continue();blocked++;return route.abort();});
  await context.addInitScript(()=>{
   localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:'light',motion:'reduced'}));
   window.__imageMeasure={clicked:null,first:null};
   document.addEventListener('click',e=>{if(e.target instanceof HTMLButtonElement&&e.target.textContent==='Load images')window.__imageMeasure.clicked=performance.now();},true);
   const observe=()=>{const state=window.__imageMeasure;if(state.clicked!==null&&state.first===null){const img=[...document.querySelectorAll('.reader-body-html img')].find(image=>image.complete&&image.naturalWidth>0);if(img)state.first=performance.now();}requestAnimationFrame(observe);};requestAnimationFrame(observe);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const ledger=async()=>{const response=await context.request.get(new URL('/__fixture/image-timings',origin).href);assert.equal(response.status(),200);return response.json();};
  let requestStart=null,headersAt=null,responseFinished=null;
  page.on('request',request=>{if(request.url().includes('/images/v2?'))requestStart=performance.now();});
  page.on('response',response=>{if(response.url().includes('/images/v2?'))headersAt=performance.now();});
  page.on('requestfinished',request=>{if(request.url().includes('/images/v2?'))responseFinished=performance.now();});
  try {
   await page.goto(new URL('/__fixture/login',origin).href);
   assert.equal((await context.request.post(new URL('/__fixture/image-latency',origin).href,{data:{scenario}})).status(),204);
   await page.goto(origin.href);
   await page.getByText('Synthetic image newsletter',{exact:true}).first().click();
   await page.getByRole('button',{name:'Load images',exact:true}).waitFor();
   assert.equal((await ledger()).events.length,0);assert.equal(await page.locator('.reader-body-html img').count(),0);
   if(run===0)await page.waitForTimeout(400);
   await page.getByRole('button',{name:'Load images',exact:true}).click();
   await page.waitForFunction(()=>{const statuses=[...document.querySelectorAll('[role="status"]')];return statuses.some(n=>/images? loaded\./.test(n.textContent??'')&&!/Loading remaining/.test(n.textContent??''));});
   await page.waitForFunction(()=>window.__imageMeasure.first!==null);
   const client=await page.evaluate(()=>({firstVisibleMs:window.__imageMeasure.first-window.__imageMeasure.clicked,settledMs:performance.now()-window.__imageMeasure.clicked}));
   const server=await ledger();assert.equal(server.active,0);
   const starts=server.events.map(e=>e.start),ends=server.events.map(e=>e.end);
   const success=server.events.filter(e=>!e.failed);
   const expected=scenario==='many'?12:scenario==='small'?2:scenario==='slowLastFailure'?3:4;
   assert.equal(await page.locator('.reader-body-html img').count(),expected);
   measurements.push({scenario,run,...client,requestToHeadersMs:headersAt-requestStart,requestToResponseEndMs:responseFinished-requestStart,serverWindowMs:Math.max(...ends)-Math.min(...starts),serverFirstSuccessMs:Math.min(...success.map(e=>e.end))-Math.min(...starts),maxActive:server.maxActive,attempted:server.events.length,loaded:success.length});
   if(run===0){await page.screenshot({path:join(output,`${scenario}.png`),fullPage:true});await page.waitForTimeout(500);}
   const video=page.video();await page.close();if(video)measurements.at(-1).videoPath=await video.path();
  }finally{await context.close();}
 }}
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'measurements.json'),JSON.stringify({sha,syntheticOnly:true,scope:'Actual built app and loopback API/SQLite/auth; injected synthetic image bytes and delays; no remote sender/DNS network',delayMs:{small:[150,150],many:Array(12).fill(150),slowFirst:[2500,150,150,150],slowLastFailure:[150,150,150,2500]},samplesPerScenario:3,browser:browser.version(),blockedExternalRequests:blocked,measurements},null,2));
 console.log(JSON.stringify({status:'pass',sha,measurements}));
}finally{await browser.close();}
