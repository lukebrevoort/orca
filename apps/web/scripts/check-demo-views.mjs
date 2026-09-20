// BRE-418 component integration journey. Start Vite on 5191, then run with node.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
import {mkdirSync} from 'node:fs';import assert from 'node:assert/strict';
const out=process.env.DEMO_VIEWS_OUTPUT ?? '/tmp/bre418-evidence';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:"reduce"});page.setDefaultTimeout(10000);
const click=name=>page.getByRole('button',{name,exact:true}).click();
const capture=async name=>{const path=`${out}/bre418-${name}.png`;await page.screenshot({path,animations:'disabled'});console.log(path)};
try {
await page.goto(`${process.env.DEMO_VIEWS_URL ?? 'http://localhost:5191/dev/inbox'}?destination=organization-studio`);await click('Views');await click('+ New View');
await page.getByRole('textbox',{name:/View name/}).fill('Family sample');await page.getByRole('button',{name:/^Add filter/}).click();await page.getByRole('menuitem',{name:/^Sender/}).click();
await page.getByRole('textbox',{name:'Email addresses',exact:true}).fill('family@example.com');
await page.getByRole('textbox',{name:'Email addresses',exact:true}).focus();
assert.equal(await page.getByRole('textbox',{name:'Email addresses',exact:true}).inputValue(),'family@example.com');
assert.equal(await page.locator('[aria-label="Matching sample mail"] .view-thread-row').count(),1);
assert.match(await page.locator('[aria-label="Matching sample mail"]').innerText(),/Mom/);
await page.locator('.view-save').scrollIntoViewIfNeeded();await capture('preview-light');await click('Save View');
assert.match(await page.locator('.view-results').innerText(),/Dinner on Sunday/);
await click('Edit definition');await page.getByRole('textbox',{name:/View name/}).fill('Family renamed');await click('Save changes');
await page.locator('.view-chip').filter({hasText:'Weekly production review'}).click();
assert.match(await page.locator('.view-results').innerText(),/no Lane, Facet, Context, or Workflow evidence/);
await page.locator('.view-chip').filter({hasText:'Family renamed'}).click();assert.match(await page.locator('.view-results').innerText(),/Dinner on Sunday/);
await capture('saved-light');await click('Switch to Orca Black');await capture('saved-dark');
await click('Edit definition');await page.getByRole('textbox',{name:'Email addresses',exact:true}).fill('absent@example.net');await click('Review zero matches');await click('Confirm zero-match save');
assert.match(await page.locator('.view-results').innerText(),/No Threads match/);await capture('empty-dark');
await page.setViewportSize({width:1024,height:1000});await click('Edit definition');await page.getByRole('textbox',{name:'Email addresses',exact:true}).fill('family@example.com');await page.getByRole('textbox',{name:'Email addresses',exact:true}).focus();await page.locator('.view-save').scrollIntoViewIfNeeded();await capture('edit-dark-narrow');
await click('Save changes');await click('Switch to Light');await capture('saved-light-narrow');
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
console.log('PASS create/edit/switch/zero-confirmation/light-dark/narrow');
}finally{await browser.close()}
