/** Focused synthetic/demo toolbar regression. Own loopback server + fresh contexts only.
 * node apps/web/scripts/compose-toolbar-e2e.mjs http://localhost:5190 /tmp/bre450-before
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
const [url, out] = process.argv.slice(2);
assert(['localhost','127.0.0.1'].includes(new URL(url).hostname));
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const result={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),browser:browser.version(),failures:[],cases:[]};
const check=(ok,message)=>{if(!ok)result.failures.push(message);};
try {
for(const theme of ['light','dark']) for(const width of [390,1024,1440]) {
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,serviceWorkers:'block'});
 await context.addInitScript(t=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme:t,motion:'reduced'})),theme);
 await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(url).origin && !new URL(r.request().url()).pathname.startsWith('/v1/')?r.continue():r.abort());
 const page=await context.newPage();await page.goto(url+'/dev/inbox');
 await page.getByRole('button',{name:/^Compose(?:\s+C)?$/}).first().click();
 const scope=page.locator('.compose-workspace-panel');await scope.waitFor();
 const toolbar=scope.getByRole('toolbar',{name:'Formatting'});
 await scope.getByRole('combobox',{name:'Message format'}).selectOption('plain');
 await scope.getByRole('textbox',{name:'Subject',exact:true}).fill('Toolbar regression');
 const editor=scope.getByRole('textbox',{name:'Message body',exact:true});await editor.fill('Preserved writing');
 await toolbar.scrollIntoViewIfNeeded();
 await page.screenshot({path:`${out}/${theme}-${width}-plain.png`});
 for(const name of ['Bulleted list','Quote','Attach files']) {
  const button=toolbar.getByRole('button',{name,exact:true});
  const visual=await button.evaluate(el=>({font:parseFloat(getComputedStyle(el).fontSize),after:getComputedStyle(el,'::after').content}));
  check(visual.font>=11 && !['"◷"','"↢"','"◇"'].includes(visual.after),`${theme}/${width}: ${name} readable without misleading glyph`);
 }
 check(!await scope.locator('.compose-delivery-actions').evaluate(el=>getComputedStyle(el,'::before').content.includes('Later')),`${theme}/${width}: no phantom Later`);
 check((await toolbar.innerText()).includes('Rich text') || await toolbar.getByRole('button',{name:'Quote',exact:true}).count()===0,`${theme}/${width}: plain-format reason visible`);
 assert(await toolbar.getByRole('button',{name:'Quote',exact:true}).isDisabled());
 const attach=toolbar.getByRole('button',{name:'Attach files',exact:true});assert(await attach.isEnabled());
 const chooser=page.waitForEvent('filechooser');await attach.click();await (await chooser).setFiles({name:'toolbar.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment')});
 await scope.getByText('toolbar.txt',{exact:true}).first().waitFor();
 await scope.getByRole('combobox',{name:'Message format'}).selectOption('rich');
 await editor.click();await page.keyboard.press('ControlOrMeta+End');await toolbar.getByRole('button',{name:'Bulleted list',exact:true}).click();
 assert(await editor.locator('ul').count()>0,'List action inserts a real list');
 await editor.fill('Preserved writing');await editor.click();await toolbar.getByRole('button',{name:'Quote',exact:true}).click();
 assert(await editor.locator('blockquote').count()>0,'Quote action inserts a real blockquote');
 await toolbar.scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/${theme}-${width}-rich.png`});
 if(width===390) {
  for(const [state,action] of [['hover',()=>attach.hover()],['focus',async()=>{await attach.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');}],['pressed',async()=>{await attach.hover();await page.mouse.down();}]]) {
   await action();await toolbar.screenshot({path:`${out}/${theme}-${state}.png`});if(state==='pressed')await page.mouse.move(0,0),await page.mouse.up();
  }
 }
 check(await editor.innerText()==='Preserved writing',`${theme}/${width}: content preserved`);
 await page.getByRole('button',{name:'Open in Zen',exact:true}).click();
 const zen=page.locator('.compose-workspace-zen');await zen.waitFor();assert((await zen.getByRole('textbox',{name:'Message body',exact:true}).innerText()).includes('Preserved writing'));
 assert(await zen.getByRole('button',{name:'Attach files',exact:true}).isEnabled());
 check(!await zen.locator('.compose-delivery-actions').evaluate(el=>getComputedStyle(el,'::before').content.includes('Later')),`${theme}/${width}: no phantom Later in Zen`);
 await page.screenshot({path:`${out}/${theme}-${width}-zen.png`});
 result.cases.push({theme,width,actions:'plain disabled, attachment chooser, rich list + quote DOM, content preserved into Zen'});
 await context.close();
}
} finally {await browser.close();await writeFile(out+'/results.json',JSON.stringify(result,null,2));}
console.log(JSON.stringify(result,null,2));assert.equal(result.failures.length,0,'Toolbar visual/behavior regression');
