import { webSourceIdentity } from './verification-revision.mjs';
/** Replay the exact historical empty-body Bold/format gesture through the real API. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
const results={revision:await webSourceIdentity(),scenarios:[],failures:[],responses:[]};
try{for(const theme of ['light','dark'])for(const width of [1440,390]){
const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,serviceWorkers:'block'});
await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await context.request.get(origin+'/__fixture/login');
const page=await context.newPage();page.setDefaultTimeout(6000);
page.on('response',async r=>{if(new URL(r.url()).pathname.startsWith('/v1/drafts'))results.responses.push({theme,width,status:r.status(),method:r.request().method(),body:await r.json().catch(()=>null)});});
try{
await page.goto(origin+'/?destination=all');await page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).first().click();
const panel=page.locator('.compose-workspace-panel');await panel.getByRole('textbox',{name:'Subject',exact:true}).fill(`BRE462 ${theme} ${width}`);
await panel.getByRole('textbox',{name:'Message body',exact:true}).fill('Quiet correspondence.\n\nPreserve this writing and every attachment.');
await panel.getByRole('combobox',{name:'Message format'}).selectOption('rich');await panel.locator('.compose-save-status-saved').waitFor();
await page.getByRole('button',{name:'Open in Zen',exact:true}).click();const zen=page.locator('.compose-workspace-zen');
const files=names=>names.map(name=>({name,mimeType:'text/plain',buffer:Buffer.from('fixture '+name)}));
await zen.locator('input[type=file]').setInputFiles(files(['toolbar.txt']));
await zen.locator('input[type=file]').setInputFiles(files(['second.txt','very-long-correspondence-attachment-name-01234567890123456789.txt']));
await zen.getByRole('button',{name:'Remove toolbar.txt',exact:true}).click();
await zen.getByRole('combobox',{name:'Message format'}).selectOption('plain');await zen.locator('.compose-save-status-saved').waitFor();
const attach=zen.getByRole('button',{name:'Attach files',exact:true});await attach.hover();await attach.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
assert(await zen.getByRole('button',{name:'Discard',exact:true}).evaluate(el=>el===document.activeElement));
await zen.getByRole('combobox',{name:'Message format'}).selectOption('rich');await zen.locator('.compose-save-status-saved').waitFor();
const bold=zen.getByRole('button',{name:'Bold, Command B',exact:true});await bold.scrollIntoViewIfNeeded();await bold.hover();await page.mouse.down();await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,`${theme}-${width}-pressed.png`)});await page.mouse.up();
await zen.getByRole('combobox',{name:'Message format'}).selectOption('plain');await zen.locator('.compose-save-status-saved').waitFor();
results.scenarios.push({theme,width,status:await zen.locator('.compose-delivery-bar').innerText()});
}catch(e){results.failures.push({theme,width,message:e.message});await page.screenshot({path:join(out,`${theme}-${width}-failure.png`)});await writeFile(join(out,`${theme}-${width}-failure.txt`),await page.locator('body').innerText());}
for(const draft of await(await context.request.get(origin+'/v1/drafts?accountId=first')).json())await context.request.delete(origin+`/v1/drafts/${draft.id}?accountId=first`);
await context.close();
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({scenarios:results.scenarios.length,failures:results.failures}));}
process.exitCode=results.failures.length?1:0;
