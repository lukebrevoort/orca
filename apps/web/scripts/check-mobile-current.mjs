/** BRE-449: owned Vite server, fresh browser profile, synthetic /dev data only.
 * MOBILE_CURRENT_URL=http://127.0.0.1:5189 node apps/web/scripts/check-mobile-current.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
let assertions = 0;
const check = {equal(...args) { assertions++; assert.equal(...args); }, match(...args) { assertions++; assert.match(...args); }};
const output = process.env.MOBILE_CURRENT_OUTPUT ?? '/tmp/orca-bre-449/browser';
mkdirSync(output, {recursive:true});
const browser = await chromium.launch({headless:true});
const base = process.env.MOBILE_CURRENT_URL ?? 'http://127.0.0.1:5189';
console.log(JSON.stringify({sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), browser:browser.version(), base}));
try {
 for (const theme of ['light','dark']) {
  for (const width of [390,1024,1440]) {
   const page = await browser.newPage({viewport:{width,height:900},colorScheme:theme, ...(width===390 && theme==='light' ? {recordVideo:{dir:join(output,'video'),size:{width:390,height:900}}} : {})});
   await page.goto(`${base}/dev/inbox`);
   await page.locator('.desktop-mobile-more').waitFor({state:width===390?'visible':'attached'});
   if (theme==='dark') await page.getByRole('button',{name:'Switch to Orca Black',exact:true}).click();
   await page.waitForTimeout(350);
   const nav = page.getByRole('navigation',{name:width===390?'Mobile primary':'Primary navigation',exact:true,includeHidden:true});
   const inbox = nav.getByRole('button',{name:/^Inbox/});
   await inbox.click();
   await page.screenshot({path:join(output,`${theme}-${width}-inbox.png`)});
   check.equal(await nav.locator('[aria-current="page"]').count(),1);
   if (width===390) {
    const more = nav.locator('.desktop-mobile-more');
    check.equal(await more.getAttribute('data-has-current'),null,'Inbox must not also mark More current');
    check.equal(await more.getAttribute('aria-label'),'Open all spaces');
    await more.hover();
    await page.screenshot({path:join(output,`${theme}-${width}-hover.png`)});
    await more.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await page.screenshot({path:join(output,`${theme}-${width}-focus.png`)});
    await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog',{name:'Navigation menu'});
    await dialog.waitFor();
    check.equal(await more.getAttribute('aria-expanded'),'true');
    check.equal(await more.getAttribute('data-has-current'),null);
    check.equal(await dialog.locator('[aria-current="page"]').count(),1);
    check.match(await page.locator(':focus').innerText(),/Inbox/);
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    check.equal(await more.evaluate(el=>el===document.activeElement),true);
    for (const label of ['Summary','Focus','Focus (legacy)','Orca launch','Weekly production review, saved view','All Mail']) {
     await more.click();
     await page.getByRole('menuitem',{name:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[0-9]*$')}).click();
     await dialog.waitFor({state:'hidden'});
     check.equal(await more.getAttribute('data-has-current'),'true');
     check.equal(await nav.locator('[aria-current="page"]').count(),0);
     check.equal(await more.getAttribute('aria-label'),`Open all spaces. Current space: ${label.replace(', saved view','')}`);
     await more.click();
     check.equal(await dialog.locator('[aria-current="page"]').count(),1);
     await page.keyboard.press('End');
     check.match(await page.locator(':focus').innerText(),/Account/);
     await page.keyboard.press('Home');
     check.equal(await page.locator(':focus').innerText(),'Summary');
     await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    }
    await page.goBack(); await page.waitForURL(/view_weekly_production/);
    check.match(await more.getAttribute('aria-label'),/Weekly production review/);
    await page.goForward(); await page.waitForURL(/destination=all/);
    check.match(await more.getAttribute('aria-label'),/All Mail/);
    await more.click();
    await page.screenshot({path:join(output,`${theme}-${width}-menu.png`)});
    await page.keyboard.press('Escape');
   }
   await page.close();
  }
 }
 console.log({assertions, matrix:'2 themes × 3 widths',mobileDestinations:6});
 console.log('PASS canonical Inbox, More ownership, distinct Focus entries, keyboard focus, menu dismissal, Back/Forward; light/dark 390/1024/1440');
} finally {await browser.close();}
