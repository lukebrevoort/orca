import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const [connection,out,revision]=process.argv.slice(2);
const origin=new URL(JSON.parse(await readFile(connection,'utf8')).url);
assert.equal(origin.hostname,'127.0.0.1');
await mkdir(out,{recursive:true});
function presentation(count) {
  const paragraphs = Array.from({ length: 18 }, (_, index) => `<p>Project note ${index + 1}: Our synthetic review keeps the complete conversation readable, with <strong>decisions</strong>, <em>context</em>, and <a href="https://example.com/review">reference links</a>. All content is synthetic and safe for test evidence.</p>`).join('');
  return Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'first-message' : `profile-message-${index}`,
    providerMessageId: `profile-provider-${index}`,
    receivedAt: new Date(Date.UTC(2026, 9, 1, 8, index)).toISOString(),
    bodyHtml: `<h2>Review note ${index + 1}</h2>${paragraphs}<table><caption>Review ${index + 1} checklist</caption><thead><tr><th>Item</th><th>Status</th></tr></thead><tbody>${Array.from({ length: 6 }, (_, row) => `<tr><td>Check ${row + 1}</td><td>Ready for review</td></tr>`).join('')}</tbody></table><p>End of review ${index + 1}</p>`,
    bodyText: `Review note ${index + 1}\n\n${Array.from({ length: 18 }, (_, row) => `Project note ${row + 1}: Our synthetic review keeps the complete conversation readable, with decisions, context, and reference links.`).join('\n\n')}\n\nOn Monday, Reviewer wrote:\n> The complete previous context remains available.\nEnd of review ${index + 1}`,
    unread: false,
  }));
}

const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
const report={revision,browser:browser.version(),syntheticOnly:true,scenarios:[],errors:[]};
try {
for(const theme of (process.env.FOCUS_PROBE_FAST?['light']:['light','dark'])) for(const rendering of (process.env.FOCUS_PROBE_FAST?['browser-managed']:['browser-managed','force-visible-control'])) {
 const context=await browser.newContext({viewport:{width:process.env.FOCUS_PROBE_MOBILE?390:1440,height:1000},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'});
 await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);
 await context.route('**/*',route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin.origin)return route.abort();if(req.method()!=='GET'&&!(req.method()==='POST'&&u.pathname==='/v1/sync/gmail')&&!(req.method()==='PATCH'&&u.pathname==='/v1/threads/first-thread/read'))return route.abort();return route.continue();});
 assert.equal((await context.request.get(origin.origin+'/__fixture/login',{maxRedirects:0})).status(),302);
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.route(u=>u.origin===origin.origin&&u.pathname==='/v1/threads/first-thread',async route=>{const response=await route.fetch();const d=await response.json();d.messages=presentation(60).map(fields=>({...d.messages[0],...fields}));d.thread.messageCount=60;d.thread.subject='Synthetic 60-message conversation';await route.fulfill({response,json:d});});
 await page.goto(origin.origin,{waitUntil:'networkidle'});
 if(rendering==='force-visible-control')await page.addStyleTag({content:'.reader-content {content-visibility:visible!important;contain-intrinsic-block-size:none!important;}'});
 await page.evaluate(()=>document.fonts.ready);
 await page.locator('button.message-row').filter({hasText:'first account conversation'}).click();
 await page.locator('.reader-body-html').nth(59).waitFor({state:'attached'});
 await page.getByRole('button',{name:'Conversation actions',exact:true}).click();await page.getByRole('button',{name:'Expand all',exact:true}).click();
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await settle();await page.evaluate(()=>{document.querySelector('.desktop-workspace').scrollTop=0;window.scrollTo(0,0);});await settle();
 const scenario={theme,rendering};report.scenarios.push(scenario);
 scenario.before=await page.locator('.reader-message').nth(48).evaluate(el=>({top:el.getBoundingClientRect().top,fullLayout:document.querySelector('.reader-message-list').getAttribute('data-full-body-layout'),contentVisibility:getComputedStyle(el.querySelector('.reader-content')).contentVisibility}));
 const link=page.locator('.reader-message').nth(48).locator('.reader-body-html a').first();
 if(process.env.FOCUS_PROBE_FORCE_LAYOUT==='1') await page.evaluate(()=>window.addEventListener('focusin',event=>{if(event.target.closest('.reader-body-html'))event.target.getBoundingClientRect();},{once:true}));
 if(process.env.FOCUS_PROBE_EVENTS==='1') await page.evaluate(()=>{
  window.__focusEvents=[];
  for(const type of ['focus','focusin']) window.addEventListener(type,event=>{const t=event.target;if(!t.closest?.('.reader-body-html'))return;const b=t.getBoundingClientRect();window.__focusEvents.push({type,top:b.top,bottom:b.bottom,scrollTop:innerWidth<761?scrollY:document.querySelector('.desktop-workspace').scrollTop,fullLayout:document.querySelector('.reader-message-list').getAttribute('data-full-body-layout')});},type==='focus');
 });
 await link.evaluate((el,preventScroll)=>el.focus({preventScroll}),process.env.FOCUS_PROBE_PREVENT==='1');await settle();
 scenario.events=await page.evaluate(()=>window.__focusEvents);

 const snapshot=()=>link.evaluate(el=>({active:document.activeElement===el,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,viewportTop:Math.max(0,document.querySelector('.desktop-workspace').getBoundingClientRect().top),viewportBottom:innerHeight,scrollTop:innerWidth<761?scrollY:document.querySelector('.desktop-workspace').scrollTop,fullLayout:document.querySelector('.reader-message-list').getAttribute('data-full-body-layout')}));
 scenario.after=await snapshot();await page.screenshot({path:out+'/'+revision+'-'+theme+'-'+rendering+'.png'});
 await page.waitForTimeout(250);scenario.afterQuiet=await snapshot();
 await link.evaluate(el=>el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'}));await settle();scenario.afterExplicitReveal=await snapshot();
 await context.close();
}
}finally{await writeFile(out+'/'+revision+'.json',JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify(report));
