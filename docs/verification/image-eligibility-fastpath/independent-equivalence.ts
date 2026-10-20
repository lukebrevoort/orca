// Independent reviewer corpus, preserved after execution; do not run concurrently with timing.
// Run: /workspace/.orca-tools/node_modules/.bin/bun independent-equivalence.ts /workspace/orca-oct18-perf
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? '/workspace/orca-oct18-perf');
const {sanitizeProviderHtml} = await import(`${root}/apps/api/src/mail/provider-html.ts`);
const {hasLoadableImages} = await import(`${root}/apps/api/src/mail/images/render.ts`);
const {remoteImageURL} = await import(`${root}/apps/api/src/mail/images/remote.ts`);
const req=createRequire(`${root}/apps/api/src/mail/images/render.ts`);
const {parseDocument,DomUtils}=req('htmlparser2');
function old(h:string|null){
  return DomUtils.findAll((n:any)=>n.type==='tag'&&n.name==='img',parseDocument(sanitizeProviderHtml(h)??'').children)
    .some((n:any)=>{for(const k of ['width','height']){const v=n.attribs[k];if(v&&/^\d+(?:px)?$/.test(v)&&parseInt(v)<=2)return false;}return !!remoteImageURL(n.attribs.src??'');});
}
const src=' src="https://images.example.org/banner.png"';
let count=0,positive=0,mismatch=0,unsafePrefixMismatches=0;
for(const name of ['img','IMG','image','IMAGE','iMaGe','ımg','İMG','i\0mg','im\0g','i mg','im\ng','i&#109;g','&#105;mg','im&#103;','imｇ'])
for(const start of ['<','<<','< ','<\n','<\0','</','<?','<!'])
for(const [pre,post]of [['',''],['<!--','-->'],['<script>','</script>'],['<style>','</style>'],['<textarea>','</textarea>'],['<xmp>','</xmp>'],['<svg>','</svg>'],['<math>','</math>'],['<template>','</template>'],['<svg><foreignObject>','</foreignObject></svg>'],['<div style="display:none;height:0">','</div>']])
for(const end of ['>','/>',' >','']){
  const h=pre+start+name+src+end+post;
  const a=old(h),b=hasLoadableImages(h);
  count++;positive+=Number(a);
  if(a!==b){mismatch++;console.log(JSON.stringify({h,a,b}));}
  // Reproduce discovery mechanism: the initially proposed <img-only check is unsafe.
  if(a !== (/<img/i.test(h) && a)) unsafePrefixMismatches++;
}
console.log(JSON.stringify({parser:req('htmlparser2/package.json').version,count,positive,mismatch,unsafePrefixMismatches}));
if(mismatch) process.exitCode=1;
