/** All capture sources are generated canvas streams, never the user's screen. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const png=await readFile(new URL('./fixtures/feedback-media/synthetic.png',import.meta.url));
const mp4=await readFile(new URL('./fixtures/feedback-media/synthetic.mp4',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const reviewName='I reviewed these attachments and want to share them in my Linear ticket.';

function syntheticCapture(){
 const originalNow=Date.now.bind(Date);
 const probe={streams:[],requests:[],frames:0,defer:false,rejectNext:false,offset:0,release:null};
 window.__feedbackCapture=probe;
 Date.now=()=>originalNow()+probe.offset;
 Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async options=>{
  probe.requests.push(options);
  if(probe.rejectNext){probe.rejectNext=false;throw new DOMException('Synthetic chooser cancelled','NotAllowedError');}
  const canvas=document.createElement('canvas');canvas.width=240;canvas.height=140;
  const context=canvas.getContext('2d');let frame=0;
  const draw=()=>{context.fillStyle='#416d82';context.fillRect(0,0,240,140);context.fillStyle='#d9e5de';context.fillRect(20+(frame++%30),20,80,80);probe.frames++;};
  draw();const stream=canvas.captureStream(12);const timer=setInterval(draw,60);
  const item={tracks:stream.getTracks(),stops:0};probe.streams.push(item);
  for(const track of item.tracks){const stop=track.stop.bind(track);track.stop=()=>{item.stops++;stop();if(item.tracks.every(t=>t.readyState==='ended'))clearInterval(timer);};}
  if(probe.defer){probe.defer=false;return new Promise(resolve=>{probe.release=()=>resolve(stream);});}
  return stream;
 }});
}
async function open(page){await page.getByRole('button',{name:'Feedback',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Send feedback',exact:true});await dialog.waitFor();return dialog;}
async function ended(page){await page.waitForFunction(()=>window.__feedbackCapture.streams.every(stream=>stream.tracks.every(track=>track.readyState==='ended')));}

export async function runMediaScenarios({setup,api,shot,results}){
 for(const theme of ['light','dark'])for(const width of [1440,320]){
  const {context,page}=await setup(theme,width);const dialog=await open(page);
  const input=dialog.getByLabel('Choose feedback attachments');const send=dialog.getByRole('button',{name:'Send to Linear',exact:true});
  await dialog.getByLabel('Your feedback',{exact:true}).fill(`Synthetic media ${theme}/${width}`);
  await input.setInputFiles({name:'unsupported.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic only')});
  await dialog.getByText(/Choose a PNG/).waitFor();assert.equal(await dialog.locator('figure').count(),0);
  await input.setInputFiles({name:'oversize.png',mimeType:'image/png',buffer:Buffer.alloc(10*1024*1024+1)});
  await dialog.getByText(/between 1 byte and 10 MB/).waitFor();assert.equal(await dialog.locator('figure').count(),0);
  await input.setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')});
  await dialog.getByText('This image could not be opened.').waitFor();assert.equal(await dialog.locator('figure').count(),0);
  await input.setInputFiles([{name:'synthetic.png',mimeType:'image/png',buffer:png},{name:'synthetic.mp4',mimeType:'video/mp4',buffer:mp4}]);
  await dialog.getByRole('img',{name:'Preview of synthetic.png'}).waitFor();await dialog.locator('video').waitFor();
  await page.waitForFunction(()=>document.querySelector('.feedback-media-preview video')?.readyState>=1);
  assert(await send.isDisabled(),'Media cannot send before explicit review');
  const review=dialog.getByRole('checkbox',{name:reviewName});await review.check();assert(await send.isEnabled());
  await dialog.getByRole('button',{name:'Remove synthetic.mp4',exact:true}).click();assert.equal(await dialog.locator('video').count(),0);assert(!await review.isChecked(),'Removal resets review');
  await input.setInputFiles({name:'synthetic.mp4',mimeType:'video/mp4',buffer:mp4});await dialog.locator('video').waitFor();assert(!await review.isChecked());
  await shot(page,`${theme}-${width}-media-review`);
  await dialog.getByRole('button',{name:'Close feedback',exact:true}).click();
  await page.getByRole('button',{name:'Feedback',exact:true}).click();await dialog.getByRole('img',{name:'Preview of synthetic.png'}).waitFor();
  await review.check();await api(context,'/__fixture/delivery','POST',{outcome:'success'});
  const before=(await api(context,'/__fixture/deliveries')).length;
  let snapshot;let calls=0;let release;const held=new Promise(resolve=>{release=resolve;});
  await page.route('**/v1/feedback/ticket',async route=>{
   if(route.request().method()!=='POST')return route.continue();calls++;
   const body=route.request().postDataJSON();
   if(!snapshot){snapshot=body;const response=await route.fetch();assert(response.ok());await held;return route.abort('failed');}
   assert.deepEqual(body,snapshot,'Retry must preserve exact reviewed attachment bytes, IDs and text');return route.continue();
  });
  await send.click();await dialog.getByRole('button',{name:'Sending…'}).waitFor();
  await dialog.getByText(/Uploading to Orca|Confirming ticket/).waitFor();await shot(page,`${theme}-${width}-media-uploading`);release();
  await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('figure').count(),2);assert.equal(await dialog.getByRole('link',{name:/BRE-FIXTURE/}).count(),0);
  await shot(page,`${theme}-${width}-media-retry`);
  await dialog.getByRole('button',{name:'Retry submission'}).click();await dialog.getByRole('link',{name:/BRE-FIXTURE/}).waitFor();
  assert.equal(calls,2);const ledger=await api(context,'/__fixture/deliveries');assert.equal(ledger.length,before+1);
  assert.deepEqual(ledger.at(-1).attachments,snapshot.attachments.map(file=>{const bytes=Buffer.from(file.dataUrl.split(',')[1],'base64');return {id:file.id,name:file.name,mimeType:file.mimeType,size:bytes.length,sha256:digest(bytes)};}));
  assert.equal(snapshot.attachments[1].dataUrl,`data:video/mp4;base64,${mp4.toString('base64')}`,'Selected video bytes preserved');
  await shot(page,`${theme}-${width}-media-sent`);results.scenarios.push(`${theme}/${width}: valid image/video previews, remove/review gate, invalid format/image/size, frozen media retry and one synthetic ticket`);await context.close();
 }
 // Capability loss on focus discards the previous owner's unsent context.
 {
  const {context,page}=await setup('light',390);let dialog=await open(page);
  await dialog.getByLabel('Your feedback',{exact:true}).fill('Synthetic owner-private draft');
  await dialog.getByLabel('Choose feedback attachments').setInputFiles({name:'private-synthetic.png',mimeType:'image/png',buffer:png});
  await dialog.getByRole('img',{name:'Preview of private-synthetic.png'}).waitFor();
  const checks=[];
  await page.route('**/v1/feedback/ticket',route=>{
   if(route.request().method()!=='GET')return route.continue();
   return new Promise(done=>checks.push({route,done}));
  });
  async function focusCheck(expected){
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   const deadline=Date.now()+5000;
   while(checks.length<expected && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(checks.length,expected,'Expected capability check was requested');
  }
  async function reply(index,available){
   const {route,done}=checks[index];await route.fulfill({json:{available}});done();
   const response=await route.request().response();await response?.finished();
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  }
  await focusCheck(1);await focusCheck(2);await reply(1,true);await reply(0,false);
  assert(await dialog.isVisible(),'Older unavailable response cannot erase a newer authorized draft');
  assert.equal(await dialog.getByLabel('Your feedback',{exact:true}).inputValue(),'Synthetic owner-private draft');
  assert.equal(await dialog.locator('figure').count(),1,'Older unavailable response cannot discard private draft attachment');
  await focusCheck(3);await focusCheck(4);await reply(3,false);
  await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Feedback',exact:true}).waitFor({state:'hidden'});
  await reply(2,true);assert.equal(await page.getByRole('button',{name:'Feedback',exact:true}).count(),0,'Older authorized response cannot re-enable a revoked capability');
  await page.unroute('**/v1/feedback/ticket');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('button',{name:'Feedback',exact:true}).waitFor();dialog=await open(page);
  assert.equal(await dialog.getByLabel('Your feedback',{exact:true}).inputValue(),'');
  assert.equal(await dialog.locator('figure').count(),0,'Capability recovery cannot restore prior private attachments');
  await shot(page,'capability-recovery-empty');results.scenarios.push('Out-of-order capability checks respect newest result in both orders; known loss closes/hides and clears unsent text/media; recovery is empty');await context.close();
 }
 // Real MediaRecorder, driven by generated canvas frames; no desktop or audio.
 const {context,page}=await setup('light',1440,'first',syntheticCapture);const dialog=await open(page);
 await dialog.getByLabel('Your feedback',{exact:true}).fill('Synthetic screen context');
 await dialog.getByRole('button',{name:'Take screenshot'}).click();await dialog.getByRole('img',{name:'Preview of screenshot.png'}).waitFor();await ended(page);
 assert.equal(await page.evaluate(()=>window.__feedbackCapture.requests[0].audio),false);await shot(page,'synthetic-screenshot-preview');
 const frameStart=await page.evaluate(()=>window.__feedbackCapture.frames);
 await dialog.getByRole('button',{name:'Record screen'}).click();await dialog.getByRole('button',{name:'Stop recording'}).waitFor();
 await page.waitForFunction(start=>window.__feedbackCapture.frames>=start+12,frameStart);
 await dialog.getByRole('button',{name:'Stop recording'}).scrollIntoViewIfNeeded();await shot(page,'synthetic-recording-active');
 await dialog.getByRole('button',{name:'Stop recording'}).click();await dialog.locator('video').waitFor();await ended(page);
 await page.waitForFunction(()=>document.querySelector('.feedback-media-preview video')?.readyState>=1);
 await dialog.locator('video').evaluate(async video=>{video.muted=true;await video.play();});
 await page.waitForFunction(()=>{const video=document.querySelector('.feedback-media-preview video');return video?.readyState>=2 && video.currentTime>0 && video.videoWidth>0 && video.videoHeight>0;});
 await dialog.locator('video').evaluate(video=>video.pause());await dialog.locator('video').scrollIntoViewIfNeeded();await shot(page,'synthetic-recording-preview');
 assert(await dialog.getByRole('button',{name:'Send to Linear'}).isDisabled());
 await dialog.getByRole('checkbox',{name:reviewName}).check();await api(context,'/__fixture/delivery','POST',{outcome:'success'});
 const beforeCapture=(await api(context,'/__fixture/deliveries')).length;
 await dialog.getByRole('button',{name:'Send to Linear'}).click();await dialog.getByRole('link',{name:/BRE-FIXTURE/}).waitFor();
 const captureLedger=await api(context,'/__fixture/deliveries');assert.equal(captureLedger.length,beforeCapture+1);
 assert.deepEqual(captureLedger.at(-1).attachments.map(file=>file.mimeType),['image/png','video/webm']);
 assert(captureLedger.at(-1).attachments.every(file=>file.size>0));await shot(page,'synthetic-capture-sent');
 await dialog.getByRole('button',{name:'Send another'}).click();await dialog.getByLabel('Your feedback',{exact:true}).fill('Synthetic lifecycle cleanup');
 await dialog.getByRole('button',{name:'Record screen'}).click();await dialog.getByRole('button',{name:'Cancel recording'}).waitFor();
 await dialog.getByRole('button',{name:'Cancel recording'}).click();await ended(page);assert.equal(await dialog.locator('figure').count(),0);
 // Advance only the synthetic page's wall clock, exercising the actual 60s limit branch.
 await dialog.getByRole('button',{name:'Record screen'}).click();await dialog.getByRole('button',{name:'Stop recording'}).waitFor();
 await page.evaluate(()=>{window.__feedbackCapture.offset+=61_000;});await dialog.locator('video').waitFor();await ended(page);
 await page.waitForFunction(()=>document.querySelector('.feedback-media-preview video')?.readyState>=1);
 await dialog.getByRole('button',{name:/Remove screen-recording/}).click();
 // Close while browser chooser promise is pending; late stream must be stopped.
 await page.evaluate(()=>{window.__feedbackCapture.defer=true;});await dialog.getByRole('button',{name:'Take screenshot'}).click();
 await dialog.getByRole('button',{name:'Cancel capture'}).waitFor();await dialog.getByRole('button',{name:'Close feedback'}).click();
 await page.evaluate(()=>window.__feedbackCapture.release());await ended(page);await page.getByRole('button',{name:'Feedback',exact:true}).click();assert.equal(await dialog.locator('figure').count(),0);
 // Unmount the media component during an active recording by closing the composer.
 await dialog.getByRole('button',{name:'Record screen'}).click();await dialog.getByRole('button',{name:'Stop recording'}).waitFor();await dialog.getByRole('button',{name:'Close feedback'}).click();await ended(page);
 await page.getByRole('button',{name:'Feedback',exact:true}).click();assert.equal(await dialog.locator('figure').count(),0);
 await page.evaluate(()=>{window.__feedbackCapture.rejectNext=true;});await dialog.getByRole('button',{name:'Take screenshot'}).click();await dialog.getByText(/Capture was cancelled/).waitFor();await ended(page);
 const tracks=await page.evaluate(()=>({requests:window.__feedbackCapture.requests,streams:window.__feedbackCapture.streams.map(item=>({stops:item.stops,states:item.tracks.map(track=>track.readyState)}))}));
 assert(tracks.requests.every(request=>request.audio===false));assert(tracks.streams.every(stream=>stream.states.every(state=>state==='ended')));results.capture=tracks;
 results.scenarios.push('Synthetic-only capture: screenshot and real canvas MediaRecorder validated by API/delivery, stop/cancel, simulated60s limit, pending chooser close and active-recording unmount cleanup, chooser rejection; all tracks ended, audio:false');
 await context.close();
}
