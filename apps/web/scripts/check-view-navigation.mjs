/** BRE-415 real-browser regression. Requires Vite and Playwright/Chromium.
 * VIEW_GUARD_URL=http://localhost:5187/dev/inbox node apps/web/scripts/check-view-navigation.mjs
 * Optional: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
 * Screenshots: VIEW_GUARD_OUTPUT (defaults to /tmp).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const output = process.env.VIEW_GUARD_OUTPUT ?? '/tmp';
mkdirSync(output, { recursive: true });
import assert from 'node:assert/strict';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const nav = name => page.locator('.desktop-sidebar-item').filter({hasText:new RegExp('^'+name+'(?:[0-9]+)?$')}).click();
const press = name => page.getByRole('button',{name,exact:true}).click();
const name = page.getByRole('textbox',{name:/View name/});
page.setDefaultTimeout(8000);
const prompt = page.getByRole('dialog',{name:'Discard changes to this draft?'});
const wait = ()=>page.waitForTimeout(180);
try {
 await page.goto(process.env.VIEW_GUARD_URL ?? 'http://localhost:5187/dev/inbox');
 await nav('Weekly production review'); await press('Edit'); await name.fill('My unsaved production review');
 const url=page.url();
 await name.focus(); await nav('Inbox'); await prompt.waitFor(); assert.equal(page.url(),url);
 await page.keyboard.press('Tab'); assert.equal(await page.getByRole('button',{name:'Discard draft',exact:true}).evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Shift+Tab'); await page.getByRole('button',{name:'Discard draft',exact:true}).hover();
 await page.screenshot({path:join(output, 'bre-415-prompt-light.png')});
 await press('Keep editing'); await wait(); assert.equal(await name.inputValue(),'My unsaved production review'); assert.equal(await name.evaluate(el=>el===document.activeElement),true);
 await page.screenshot({path:join(output, 'bre-415-focus-light.png')});
 const reloadWarning = new Promise(resolve => page.once('dialog', async dialog => { assert.equal(dialog.type(),'beforeunload'); await dialog.dismiss(); resolve(); }));
 await page.evaluate(()=>location.reload()); await reloadWarning; assert.equal(await name.inputValue(),'My unsaved production review');
 await page.evaluate(()=>history.back()); await prompt.waitFor(); assert.equal(page.url(),url);
 await press('Keep editing'); await wait(); assert.equal(page.url(),url); assert.equal(await name.inputValue(),'My unsaved production review');
 await page.evaluate(()=>history.back()); await prompt.waitFor(); await press('Discard draft'); await wait(); assert.equal(new URL(page.url()).searchParams.get('destination'),null);
 await page.evaluate(()=>history.forward()); await page.getByRole('heading',{name:'Weekly production review',exact:true}).waitFor();
 await nav('Urgent humans'); await page.getByRole('heading',{name:'Urgent humans',exact:true}).waitFor();
 await page.evaluate(()=>history.back()); await page.getByRole('heading',{name:'Weekly production review',exact:true}).waitFor();
 await press('Edit'); await name.fill('Forward history draft');
 await page.evaluate(()=>history.forward()); await prompt.waitFor(); assert.match(page.url(),/view_weekly_production/);
 await press('Keep editing'); await wait(); assert.equal(await name.inputValue(),'Forward history draft');
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 await nav('Settings'); await prompt.waitFor(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await page.getByRole('button',{name:'Discard draft',exact:true}).hover(); await page.screenshot({path:join(output, 'bre-415-prompt-dark.png')});
 await press('Keep editing'); await wait(); assert.equal(await name.evaluate(el=>el===document.activeElement),true);
 await page.screenshot({path:join(output, 'bre-415-focus-dark.png')});
 await page.evaluate(()=>history.forward()); await prompt.waitFor(); await press('Discard draft'); await page.getByRole('heading',{name:'Urgent humans',exact:true}).waitFor();
 await press('Edit'); await name.fill('Leave for Settings'); await nav('Settings'); await prompt.waitFor();
 let extraPrompt = false; page.on('dialog', async dialog => { extraPrompt = true; await dialog.dismiss(); });
 await press('Discard draft'); await page.waitForURL('**/settings'); assert.equal(extraPrompt,false);
 const organizationUrl = new URL(process.env.VIEW_GUARD_URL ?? 'http://localhost:5187/dev/inbox');
 organizationUrl.searchParams.set('destination','organization-studio');
 await page.goto(organizationUrl.href); await press('Views'); await press('Edit definition');
 await name.fill('First dirty Organization draft'); await press('Rules'); await prompt.waitFor(); await press('Discard draft');
 await press('Views'); assert.equal(await page.locator('#organization-views .view-composer').count(),0);
 await press('Edit definition'); assert.equal(await name.inputValue(),'Weekly production review');
 await name.fill('Second dirty Organization draft'); await name.focus(); await press('Rules'); await prompt.waitFor();
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.screenshot({path:join(output,'bre-415-return-prompt-light.png')});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 await page.screenshot({path:join(output,'bre-415-return-prompt-dark.png')});
 await press('Keep editing'); await wait(); assert.equal(await name.inputValue(),'Second dirty Organization draft');
 assert.equal(await name.evaluate(el=>el===document.activeElement),true);
 await press('Rules'); await prompt.waitFor(); await press('Discard draft'); await press('Views');
 assert.equal(await page.locator('#organization-views .view-composer').count(),0);
 console.log('PASS shell, Back/Forward Keep/Discard, exact URL/focus, requested view identity, light/dark screenshots');
} catch (error) { await page.screenshot({path:join(output, "bre-415-failure.png")}); throw error; } finally { await browser.close(); }
