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
  const utilityGeometry=await row.evaluate(node=>{
   const name=element=>element.getAttribute('aria-label')??element.textContent.trim();
   const direct=[...node.querySelectorAll('.importance-control button')],utilities=[...node.querySelectorAll('.message-evidence-button,.sender-attention-trigger,.keep-thread-button,.pin-sender-button')];
   const collisions=[];for(const action of direct)for(const utility of utilities){const a=action.getBoundingClientRect(),b=utility.getBoundingClientRect(),width=Math.min(a.right,b.right)-Math.max(a.left,b.left),height=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);if(width>1&&height>1)collisions.push({action:name(action),utility:name(utility),width,height,area:width*height});}
   const more=direct.find(button=>button.getAttribute('aria-label')?.startsWith('Review importance of')),rect=more.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
   return {collisions,moreReceivesPointer:more.contains(hit),pointerTarget:hit?.closest('button')?name(hit.closest('button')):hit?.tagName};
  });
  check(utilityGeometry.collisions.length===0,'Legacy row utilities never overlap direct importance controls',{theme,width,...utilityGeometry});
  check(utilityGeometry.moreReceivesPointer,'Importance More receives its actual center pointer',{theme,width,...utilityGeometry});
  await page.getByRole('button',{name:'Undo importance change',exact:true}).click();await page.getByText('Previous choice restored.',{exact:false}).waitFor();
  await page.goto(origin+'/settings#writing');await page.getByRole('textbox',{name:'Search mail',exact:true}).fill('conversation');await page.getByRole('textbox',{name:'Search mail',exact:true}).press('Enter');
  const resultRow=page.locator('.global-mail-result-list > li').filter({has:page.getByText('first account conversation',{exact:true})}).first();await resultRow.waitFor();
  const actions=await resultRow.getByRole('group',{name:'Choose for this conversation only',exact:true}).getByRole('button').count();check(actions===2,'Utility-entry global search retains both direct importance choices',{theme,width,actions});
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(out,theme+'-'+width+'-settings-search.png')});
  let settingsUndo=null;if(actions===2){await resultRow.getByRole('button',{name:'Important',exact:true}).click();settingsUndo=await undoGeometry('settings-search');const undo=page.getByRole('button',{name:'Undo importance change',exact:true});await undo.focus();check(await undo.evaluate(node=>node===document.activeElement&&!node.closest('[inert]')),'Search Undo participates in the active keyboard focus boundary',{theme,width});await page.keyboard.press('Enter');await page.getByText('Previous choice restored.',{exact:false}).waitFor();const restored=await context.request.get(origin+'/v1/importance/conversations/first-thread?accountId=first').then(response=>response.json());check(restored.importance.conversation.choice===null,'Keyboard Undo independently restores the owned server choice',{theme,width});}
  const provider=await context.request.get(origin+'/__fixture/deliveries').then(response=>response.json());check(provider.length===0,'Importance entry never writes provider mail',{theme,width,providerCalls:provider.length});
  result.scenarios.push({theme,width,mailUndo,settingsUndo,utilityGeometry,directSearchActions:actions});
 }catch(error){result.failures.push({theme,width,message:error.message});}finally{await context.close();}
}}finally{await browser.close();await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({scenarios:result.scenarios.length,assertions:result.assertions,failures:result.failures,pageErrors:result.pageErrors}));}process.exitCode=result.failures.length||result.pageErrors.length?1:0;
