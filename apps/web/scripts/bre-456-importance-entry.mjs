/** Direct corrections and visible Undo in both mail and utility-entry search.
 * Real account-scoped API choices; no fixture success responses. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {webSourceIdentity} from './verification-revision.mjs';
const [connection,out]=process.argv.slice(2),origin=JSON.parse(await readFile(connection,'utf8')).url;
await mkdir(out,{recursive:true});const result={revision:await webSourceIdentity(),assertions:0,failures:[],scenarios:[],pageErrors:[]};
const check=(ok,label,detail)=>{result.assertions++;if(!ok)result.failures.push({label,detail});};
const browser=await chromium.launch({headless:true,executablePath:process.env.ORCA_CHROMIUM_EXECUTABLE});
try{for(const theme of ['light','dark'])for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:width===390?844:1000}});await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await context.request.get(origin+'/__fixture/login');const page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.message));
 async function reset(){const snapshot=await context.request.get(origin+'/v1/importance/conversations/first-thread?accountId=first').then(response=>response.json());const response=await context.request.post(origin+'/v1/importance/choices',{data:{accountId:'first',target:{kind:'conversation',threadId:'first-thread'},choice:null,expectedRevision:snapshot.importance.conversation.revision,operationId:crypto.randomUUID()}});assert(response.ok());}
 async function undoGeometry(label){const undo=page.getByRole('button',{name:'Undo importance change',exact:true});await undo.waitFor();const geometry=await undo.evaluate(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollY};});check(geometry.x>=0&&geometry.y>=0&&geometry.x+geometry.width<=geometry.viewportWidth+1&&geometry.y+geometry.height<=geometry.viewportHeight+1,label+' Undo is immediately in viewport',geometry);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+width+'-'+label+'.png')});return geometry;}
 try{
  await reset();await page.goto(origin+'/?destination=all');const row=page.locator('.message-row-wrap').filter({has:page.locator('button.message-row').filter({hasText:'first account conversation'})}).first();await row.getByRole('button',{name:'Important',exact:true}).click();const mailUndo=await undoGeometry('mail');
  await page.getByRole('button',{name:'Undo importance change',exact:true}).click();await page.getByText('Previous choice restored.',{exact:false}).waitFor();
  await page.goto(origin+'/settings#writing');await page.getByRole('textbox',{name:'Search mail',exact:true}).fill('conversation');await page.getByRole('textbox',{name:'Search mail',exact:true}).press('Enter');
  const resultRow=page.locator('.global-mail-result-list > li').filter({has:page.getByText('first account conversation',{exact:true})}).first();await resultRow.waitFor();
  const actions=await resultRow.getByRole('group',{name:'Choose for this conversation only',exact:true}).getByRole('button').count();check(actions===2,'Utility-entry global search retains both direct importance choices',{theme,width,actions});
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+width+'-settings-search.png')});
  let settingsUndo=null;if(actions===2){await resultRow.getByRole('button',{name:'Important',exact:true}).click();settingsUndo=await undoGeometry('settings-search');}
  const provider=await context.request.get(origin+'/__fixture/deliveries').then(response=>response.json());check(provider.length===0,'Importance entry never writes provider mail',{theme,width,providerCalls:provider.length});
  result.scenarios.push({theme,width,mailUndo,settingsUndo,directSearchActions:actions});
 }catch(error){result.failures.push({theme,width,message:error.message});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
