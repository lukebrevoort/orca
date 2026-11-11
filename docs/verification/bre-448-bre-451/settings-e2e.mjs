import { chromium } from '../../../node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.BASE ?? 'http://localhost:5188';
const out = process.env.EVIDENCE;
assert(out, 'EVIDENCE required'); await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true}); const results=[];
try {
 for (const theme of ['light','dark']) {
  const context = await browser.newContext({viewport:{width:1440,height:900},colorScheme:theme,reducedMotion:'reduce'});
  await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences',JSON.stringify({theme,motion:'reduced'})),theme);
  const page=await context.newPage(); const writes=[];
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/v1/')&&!['GET','HEAD'].includes(r.method())) writes.push(r.url());});
  await page.goto(`${base}/dev/settings`);
  const signature=page.getByRole('textbox',{name:'Default signature'});
  const dialog=page.getByRole('dialog',{name:'Leave without saving account choices?'});
  await signature.fill('Synthetic protected signature');
  await page.locator('.desktop-compose').click(); await dialog.waitFor();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await page.screenshot({path:`${out}/${theme}-1440-stay-focus.png`});
  await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  assert.equal(await signature.inputValue(),'Synthetic protected signature');
  for (const name of ['Plain text','Reply all']) { await page.getByText(name,{exact:true}).click(); }
  await page.getByText('Notify me for new reminders',{exact:true}).click();
  await page.locator('.desktop-compose').click(); await dialog.waitFor();
  await page.getByRole('button',{name:'Stay in Settings',exact:true}).click();
  assert.equal(await page.getByRole('radio',{name:'Plain text',exact:true}).isChecked(),true);
  assert.equal(await page.getByRole('radio',{name:'Reply all',exact:true}).isChecked(),true);
  await page.locator('.settings-home-nav a[href="#privacy"]').click();
  assert.equal(await dialog.count(),0);
  await page.locator('.settings-row-link[href="https://myaccount.google.com/permissions"]').click();
  await dialog.waitFor(); await page.getByRole('button',{name:'Stay in Settings',exact:true}).click();
  assert.equal(await signature.inputValue(),'Synthetic protected signature');
  for (const width of [320,390,1024,1440]) {
   await page.setViewportSize({width,height:900});
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   if(width<860) {
    const jump=page.getByRole('combobox',{name:'Jump to section'});
    assert.equal(await jump.locator('option:not([disabled])').count(),8);
    for(const id of ['account','appearance','attention','writing','notifications','connected','agents','privacy']) {
     await jump.selectOption(id);
     await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
     const heading=page.locator(`#${id} h2`); const bounds=await heading.boundingBox();
     if (bounds.y < 140 || bounds.y >= 850) await page.screenshot({path:`${out}/${theme}-${width}-${id}-failed-landing.png`});
     assert(bounds.y>=140 && bounds.y<850,`${theme} ${width} ${id}: ${JSON.stringify(bounds)}`);
     assert.equal(await dialog.count(),0);
     assert.equal(await heading.evaluate(el=>el===document.activeElement),true);
    }
    await jump.selectOption('writing'); await jump.focus();
   } else {await signature.scrollIntoViewIfNeeded();}
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} overflow`);
   await page.screenshot({path:`${out}/${theme}-${width}-sections.png`});
  }
  await page.setViewportSize({width:390,height:900});
  await page.getByRole('combobox',{name:'Jump to section'}).selectOption('writing');
  await signature.fill('Latest synthetic signature');
  await page.getByRole('button',{name:'Save account choices',exact:true}).click();
  assert(await page.getByRole('button',{name:'Saved',exact:true}).isDisabled());
  await page.screenshot({path:`${out}/${theme}-390-saved-disabled.png`});
  await signature.fill('Another unsaved edit');
  await page.locator('.settings-row-link[href="/settings/integrations/gmail"]').click(); await dialog.waitFor();
  const leave=page.getByRole('button',{name:'Leave without saving',exact:true});
  await leave.hover(); await page.screenshot({path:`${out}/${theme}-390-leave-hover.png`});
  await leave.click(); await page.waitForURL('**/settings/integrations/gmail');
  assert.equal(writes.length,0);
  results.push({theme,pass:true,widths:[320,390,1024,1440],sections:8,writes,flows:['Escape','Stay','account controls preserved','external link cancel','hash navigation','explicit save','explicit discard']});
  await context.close();
 }
} finally {await writeFile(`${out}/results.json`,JSON.stringify({commit:process.env.SHA,node:process.version,browser:browser.version(),results},null,2));await browser.close();}
