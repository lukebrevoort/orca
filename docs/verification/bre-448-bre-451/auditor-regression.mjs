import { chromium } from '../../../node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const root = process.env.EVIDENCE;
const base = process.env.BASE;
await mkdir(root, {recursive:true});
const browser = await chromium.launch({headless:true});
const cases=[];
try {
 for (const theme of ['light','dark']) for (const action of ['compose','reload','back']) {
  const context=await browser.newContext({viewport:{width:1280,height:800},colorScheme:theme,reducedMotion:'reduce'});
  await context.addInitScript(theme=>localStorage.setItem('orca-reader-preferences', JSON.stringify({theme,motion:'reduced'})),theme);
  const page=await context.newPage();
  const writes=[];const dialogs=[];
  page.on('request',req=>{if(new URL(req.url()).pathname.startsWith('/v1/')&&!['GET','HEAD'].includes(req.method()))writes.push({url:req.url(),method:req.method()});});
  page.on('dialog',async dialog=>{dialogs.push({type:dialog.type(),message:dialog.message()});await dialog.dismiss();});
  await page.goto(`${base}/dev/inbox`);
  await page.goto(`${base}/dev/settings`);
  const signature=page.getByRole('textbox',{name:'Default signature'});
  await signature.fill(`Synthetic unsaved ${action} signature`);
  const before={url:page.url(),signature:await signature.inputValue(),saveDisabled:await page.getByRole('button',{name:'Save account choices',exact:true}).isDisabled()};
  await page.screenshot({path:`${root}/${theme}-${action}-before.png`,animations:'disabled'});
  if(action==='compose')await page.locator('.desktop-compose').click();
  if(action==='reload')await page.evaluate(() => { setTimeout(() => location.reload(), 0); }); await page.waitForTimeout(500);
  if(action==='back')await page.evaluate(() => { setTimeout(() => history.back(), 0); }); await page.waitForTimeout(500);
  const after={url:page.url(),dialogs,signature:await signature.count()?await signature.inputValue():null,applicationDialogCount:await page.getByRole('dialog').count()};
  if(action==='compose' && after.applicationDialogCount){await page.getByRole('button',{name:'Stay in Settings',exact:true}).click();after.signatureAfterReturn=await signature.inputValue();} else if(action==='compose'){await page.goto(`${base}/dev/settings`);after.signatureAfterReturn=await signature.inputValue();}
  await page.screenshot({path:`${root}/${theme}-${action}-after.png`,animations:'disabled'});
  const protectedEdit=(after.applicationDialogCount>0 && after.signatureAfterReturn===before.signature)||(after.signature===before.signature);
  cases.push({theme,action,before,after,writes,expected:'Dirty settings require a leave decision or preserve edits',pass:protectedEdit});
  await context.close();
 }
} finally {
 const result={testedCommit:process.env.SHA,baseline:'9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311',surface:'web demo settings using same SettingsHome navigation paths as production',syntheticOnly:true,node:process.version,browser:browser.version(),cases};
 await writeFile(`${root}/results.json`,JSON.stringify(result,null,2));
 await browser.close();
}
console.log(JSON.stringify(cases.map(({theme,action,pass,before,after,writes})=>({theme,action,pass,before,after,writes})),null,2));
if(cases.some(c=>!c.pass))process.exitCode=1;
