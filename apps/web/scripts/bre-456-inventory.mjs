import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import {join} from 'node:path';
const [connection,out]=process.argv.slice(2),origin=JSON.parse(await readFile(connection,'utf8')).url;
await mkdir(out,{recursive:true});
const render=spawnSync('/opt/homebrew/bin/bun',['apps/web/scripts/bre-456-inventory.tsx',out],{stdio:'inherit'});assert.equal(render.status,0);
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
const result={source:JSON.parse(await readFile(join(out,'source.json'),'utf8')),viewport:{width:1440,height:1000},inventory:[],scope:'Default desktop sidebar buttons from exact baseline/candidate components with the same synthetic owner/counts/views. Not a performance benchmark.'};
try{for(const name of ['baseline','candidate']){
 const page=await browser.newPage({viewport:result.viewport});
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.setContent((await readFile(join(out,name+'.html'),'utf8')).replace('<head>','<head><base href="'+origin+'">'));await page.evaluate(()=>document.fonts.ready);
 const buttons=await page.locator('nav[aria-label="Primary navigation"] button:visible').allTextContents();
 const controls=await page.locator('nav[aria-label="Primary navigation"] :is(button,a[href],summary):visible').allTextContents();
 result.inventory.push({name,visibleButtons:buttons.map(label=>label.replace(/\s+/g,' ').trim()),count:buttons.length,visibleControls:controls.map(label=>label.replace(/\s+/g,' ').trim()),controlCount:controls.length});
 await page.screenshot({path:join(out,name+'.png')});await page.close();
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
