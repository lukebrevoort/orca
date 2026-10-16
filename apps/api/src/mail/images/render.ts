import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeInboundHtml, sanitizeProviderHtml } from "../provider-html.ts";
import { downloadRemoteImage, rasterType, remoteImageURL } from "./remote.ts";
const {parseDocument,DomUtils}=createRequire(import.meta.url)("htmlparser2") as typeof import("htmlparser2");
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function documentImages(html:string|null){const document=parseDocument(sanitizeProviderHtml(html)??"");return {document,images:DomUtils.findAll(n=>n.type==="tag"&&n.name==="img",document.children)};}
function candidate(image:ReturnType<typeof documentImages>["images"][number]) {
  if(image.type!=="tag") return null;
  for(const key of ["width","height"]) {const v=image.attribs[key];if(v && /^\d+(?:px)?$/.test(v) && parseInt(v)<=2)return null;}
  return remoteImageURL(image.attribs.src??"");
}
export function hasLoadableImages(html:string|null){return documentImages(html).images.some(candidate);}
export function imageSourceHash(html:string|null){return createHash("sha256").update(sanitizeInboundHtml(html)??"").digest("hex");}
export type ImageDownload = typeof downloadRemoteImage;
/** The default read path never calls this. Only an authorized explicit POST may resolve images. */
export async function renderRequestedImages(html:string|null,download:ImageDownload=downloadRemoteImage) {
  const {document,images}=documentImages(html);const signal=AbortSignal.timeout(20_000);
  const replacements=new Map<string,string>();let loaded=0,totalBytes=0,attempted=0;
  for(const image of images){
    const url=candidate(image);if(!url||attempted>=12||signal.aborted||totalBytes>=8*1024*1024)continue;attempted++;
    try {
      const bytes=await download(url,signal);const mime=rasterType(bytes);
      if(!mime||bytes.length>2*1024*1024||totalBytes+bytes.length>8*1024*1024)continue;
      totalBytes+=bytes.length;
      const marker=`orca-image-${randomUUID()}`;const alt=image.attribs.alt??"";
      image.attribs={alt:marker};
      replacements.set(marker,`<img alt="${escape(alt)}" src="data:${mime};base64,${bytes.toString("base64")}" style="max-width:100%;height:auto">`);loaded++;
    }catch{/* A failed image remains a blocked placeholder; do not expose remote diagnostics. */}
  }
  let bodyHtml=sanitizeInboundHtml(DomUtils.getOuterHTML(document))??"";
  for(const [marker,image] of replacements){bodyHtml=bodyHtml.replace(`<span class="orca-mail-image-note">[Image blocked: ${marker}]</span>`,image);}
  return {bodyHtml,sourceHash:imageSourceHash(html),loaded,blocked:images.length-loaded};
}
