/** Real session-cookie owner switch and preferences write, independent SQLite.
 * Keeps the old draft in the UI; no OAuth or live credentials. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),fixture=JSON.parse(await readFile(connection,'utf8')),origin=fixture.url;
await mkdir(out,{recursive:true});const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
const result={revision:await webSourceIdentity(),scenarios:[],assertions:0,failures:[],requests:[],pageErrors:[]};
const check=(ok,label)=>{result.assertions++;assert(ok,label);};
function rows(){return JSON.parse(execFileSync('python3',['-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;print(json.dumps([dict(r) for r in c.execute("select user_id,signature from user_preferences order by user_id")]))',fixture.databasePath],{encoding:'utf8'}));}
try{for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:1024,height:900}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
 await context.request.get(origin+'/__fixture/login');const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>result.pageErrors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname==='/v1/preferences')result.requests.push({theme,method:r.method(),body:r.postDataJSON()});});
 try{
  await page.goto(origin+'/settings#writing');const signature=page.getByRole('textbox',{name:'Default signature',exact:true});await signature.fill('Unsaved original owner '+theme);
  await context.request.get(origin+'/__fixture/login-other');const before=await context.request.get(origin+'/v1/preferences').then(r=>r.json());
  await page.getByRole('button',{name:'Save account choices',exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent.includes('Account preferences saved.')||document.body.textContent.includes('Settings ownership changed.'));
  const after=await context.request.get(origin+'/v1/preferences').then(r=>r.json());
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-owner.png')});
  const database=rows();result.scenarios.push({theme,before,after,database});
  check(after.signature===before.signature,'Old owner edits must never be saved into the new session owner');
  check(await page.getByRole('button',{name:'Check original session',exact:true}).isVisible(),'Owner change offers explicit recovery without exposing old account data');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,theme+'-owner-mobile.png')});
  check(await page.locator('.settings-owner-recovery').evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Owner recovery reflows on mobile');
  check(await page.getByRole('button',{name:'Check original session',exact:true}).evaluate(node=>node.getBoundingClientRect().height>=44),'Owner recovery action retains touch target');
  await context.request.get(origin+'/__fixture/login');await page.getByRole('button',{name:'Check original session',exact:true}).click();await signature.waitFor();
  check(await signature.inputValue()==='Unsaved original owner '+theme,'Original owner recovery retains unsaved choices');
 }catch(error){result.failures.push({theme,message:error.message});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
