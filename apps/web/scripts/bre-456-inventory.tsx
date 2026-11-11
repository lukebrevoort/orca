/** Immutable source-pinned sidebar inventory, rendered with the same fixture.
 * Not a timing benchmark or production application substitute. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppSidebar } from '../src/desktop-switch';
import { TopLayerProvider } from '../src/top-layer';
const [output] = process.argv.slice(2);
if(!output)throw new Error('Output directory required');
const baseline='bdec28426de57b8833ae29743eef330f391f63cb';
const source=execFileSync('git',['show',`${baseline}:apps/web/src/desktop-switch.tsx`],{encoding:'utf8'});
const temporary=await mkdtemp(resolve('apps/web/scripts/.bre456-inventory-'));
try{
 // Only import locations adapt to the temporary fixture path; component bytes
 // are pinned and their original digest retained. No checkout is created.
 await writeFile(join(temporary,'baseline.tsx'),source.replaceAll('from "./','from "../../src/'));
 const {AppSidebar:BaselineSidebar}=await import(join(temporary,'baseline.tsx'));
 const projection={account:{displayName:'Fixture owner',email:'owner@example.com',accountCount:2,health:'synced' as const},active:'inbox' as const,draftCount:2,inboxCount:3,online:true,spaces:[{id:'later',label:'Later',kind:'built_in' as const,description:'Manual reminders'},{id:'weekly',label:'Weekly review',kind:'view' as const,description:'Saved view'}]};
 const props={projection,theme:'light' as const,onCompose(){},onManageSpaces(){},onManageTools(){},onManageViews(){},onNavigate(){}};
 const cases=[];
 for(const [name,Component,active] of [['baseline',BaselineSidebar,'inbox'],['candidate',AppSidebar,'important']] as const){
  const files=['styles.css','desktop-switch.css','mobile-mail.css'];if(name==='candidate')files.push('importance.css','foundation.css');
  const styles=[];for(const file of files)styles.push(name==='baseline'?execFileSync('git',['show',`${baseline}:apps/web/src/${file}`],{encoding:'utf8'}):await readFile('apps/web/src/'+file,'utf8'));
  const markup=renderToStaticMarkup(<TopLayerProvider><Component {...props} projection={{...projection,active}}/></TopLayerProvider>);
  await writeFile(join(output,name+'.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${styles.join('\n')}</style></head><body><main class="desktop-shell">${markup}<section class="desktop-workspace"><h1>Same synthetic workspace</h1></section></main></body></html>`);
  cases.push({name,active,baseline:name==='baseline'?baseline:null,componentSourceSha256:name==='baseline'?createHash('sha256').update(source).digest('hex'):null});
 }
 await writeFile(join(output,'source.json'),JSON.stringify({baseline,cases},null,2));
}finally{await rm(temporary,{recursive:true,force:true});}
