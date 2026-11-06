/** Synthetic full-app latency measurements. No sender/DNS network is permitted. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [connectionFile,directory,sha,baselineConnection]=process.argv.slice(2);
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
const phases=[{phase:'candidate',origin,sha}];
if(baselineConnection){
 const baselineRoot=process.env.ORCA_IMAGE_BASELINE_ROOT;
 assert(baselineRoot,'Baseline checkout is required');
 const baselineProof=JSON.parse(await readFile(process.env.ORCA_IMAGE_BASELINE_PROOF,'utf8'));
 assert.equal(execFileSync('git',['-C',baselineRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),baselineProof.commit);
 assert.equal(execFileSync('git',['-C',baselineRoot,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
 const baselineFiles=(await walk(join(baselineRoot,'apps/web/dist'))).map(path=>path.slice(baselineRoot.length+1));
 assert.deepEqual(Object.keys(baselineProof.files).sort(),baselineFiles.sort());
 for(const [path,hash] of Object.entries(baselineProof.files))assert.equal(createHash('sha256').update(await readFile(join(baselineRoot,path))).digest('hex'),hash);
 const baseline=JSON.parse(await readFile(baselineConnection,'utf8')),baselineOrigin=new URL(baseline.url);
 assert.equal(baselineOrigin.protocol,'http:');assert.equal(baselineOrigin.hostname,'127.0.0.1');
 phases.unshift({phase:'baseline',origin:baselineOrigin,sha:baselineProof.commit});
}
const output=resolve(directory);await mkdir(output,{recursive:false});
const mod=process.env.ORCA_PLAYWRIGHT_MODULE;
const {chromium}=await import(mod?.startsWith('/')?pathToFileURL(mod).href:mod??'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-background-networking']});
const measurements=[],errors=[];let blocked=0;
const scenarioNames=['small','many','slowFirst','slowLastFailure'];
try {
 for(const scenario of scenarioNames){for(let run=0;run<3;run++){for(const selected of (run%2?[...phases].reverse():phases)){
  const {origin,phase,sha:applicationSha}=selected;
  const context=await browser.newContext({viewport:{width:1280,height:1000},serviceWorkers:'block',...(run===0?{recordVideo:{dir:output,size:{width:1280,height:1000}}}:{})});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin.origin)return route.continue();blocked++;return route.abort();});
  await context.addInitScript(()=>{
   localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:'light',motion:'reduced'}));
   window.__imageMeasure={clicked:null,first:null,httpStart:null,headersAt:null,responseEnd:null,responseBytes:0};
   const nativeFetch=window.fetch.bind(window);
   window.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input),location.href);
    if(!url.pathname.endsWith('/images/v2'))return nativeFetch(input,init);
    window.__imageMeasure.httpStart=performance.now();
    const response=await nativeFetch(input,init);window.__imageMeasure.headersAt=performance.now();
    if(!response.body){window.__imageMeasure.responseEnd=performance.now();return response;}
    // Observe unchanged response chunks in both phases. No bytes/delays are replaced.
    const observed=response.body.pipeThrough(new TransformStream({
     transform(chunk,controller){window.__imageMeasure.responseBytes+=chunk.byteLength;controller.enqueue(chunk);},
     flush(){window.__imageMeasure.responseEnd=performance.now();},
    }));
    return new Response(observed,{status:response.status,statusText:response.statusText,headers:response.headers});
   };
   document.addEventListener('click',e=>{if(e.target instanceof HTMLButtonElement&&e.target.textContent==='Load images')window.__imageMeasure.clicked=performance.now();},true);
   const observe=()=>{const state=window.__imageMeasure;if(state.clicked!==null&&state.first===null){const img=[...document.querySelectorAll('.reader-body-html img')].find(image=>image.complete&&image.naturalWidth>0);if(img)state.first=performance.now();}requestAnimationFrame(observe);};requestAnimationFrame(observe);
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const ledger=async()=>{const response=await context.request.get(new URL('/__fixture/image-timings',origin).href);assert.equal(response.status(),200);return response.json();};

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
   await page.waitForFunction(()=>window.__imageMeasure.responseEnd!==null,{},{timeout:5000});
   const network=await page.evaluate(()=>({requestToHeadersMs:window.__imageMeasure.headersAt-window.__imageMeasure.httpStart,requestToResponseEndMs:window.__imageMeasure.responseEnd-window.__imageMeasure.httpStart,responseBytes:window.__imageMeasure.responseBytes}));
   assert(network.requestToResponseEndMs>=network.requestToHeadersMs&&network.requestToHeadersMs>=0);
   const server=await ledger();assert.equal(server.active,0);
   const starts=server.events.map(e=>e.start),ends=server.events.map(e=>e.end);
   const success=server.events.filter(e=>!e.failed);
   const expected=scenario==='many'?12:scenario==='small'?2:scenario==='slowLastFailure'?3:4;
   assert.equal(await page.locator('.reader-body-html img').count(),expected);
   measurements.push({phase,applicationSha,scenario,run,...client,...network,networkTiming:'Client fetch headers and unchanged stream chunks through an observation-only TransformStream in both phases',serverWindowMs:Math.max(...ends)-Math.min(...starts),serverFirstSuccessMs:Math.min(...success.map(e=>e.end))-Math.min(...starts),maxActive:server.maxActive,attempted:server.events.length,loaded:success.length});
   if(run===0){await page.screenshot({path:join(output,`${phase}-${scenario}.png`),fullPage:true});await page.waitForTimeout(500);}
   const video=page.video();await page.close();if(video)measurements.at(-1).videoPath=await video.path();console.log(JSON.stringify({status:'sample-pass',phase,scenario,run,...client,...network}));
  }finally{await context.close();}
 }}}
 assert.deepEqual(errors,[]);
 await writeFile(join(output,'measurements.json'),JSON.stringify({sha,syntheticOnly:true,scope:'Actual built app and loopback API/SQLite/auth; injected synthetic image bytes and delays; no remote sender/DNS network',delayMs:{small:[150,150],many:Array(12).fill(150),slowFirst:[2500,150,150,150],slowLastFailure:[150,150,150,2500]},samplesPerScenario:3,order:baselineConnection?'baseline/candidate, candidate/baseline, baseline/candidate per scenario':'single candidate',browser:browser.version(),blockedExternalRequests:blocked,measurements},null,2));
 console.log(JSON.stringify({status:'pass',sha,measurements}));
}finally{await browser.close();}
