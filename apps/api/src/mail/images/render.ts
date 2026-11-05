import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeInboundHtml, sanitizeProviderHtml } from "../provider-html.ts";
import { downloadRemoteImage, ImageFetchError, rasterType, validatedRasterType, remoteImageURL } from "./remote.ts";
const {parseDocument,DomUtils}=createRequire(import.meta.url)("htmlparser2") as typeof import("htmlparser2");
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function documentImages(html:string|null){const document=parseDocument(sanitizeProviderHtml(html)??"");return {document,images:DomUtils.findAll(n=>n.type==="tag"&&n.name==="img",document.children)};}
function candidate(image:ReturnType<typeof documentImages>["images"][number]) {
  if(image.type!=="tag") return null;
  for(const key of ["width","height"]) {const v=image.attribs[key];if(v && /^\d+(?:px)?$/.test(v) && parseInt(v)<=2)return null;}
  return remoteImageURL(image.attribs.src??"");
}
export function hasLoadableImages(html: string | null) {
  // htmlparser2 recognizes img and the legacy image alias; tag names are not
  // entity-decoded and the provider policy does not synthesize image tags.
  // Use their common prefix only to prove absence. A match is just a hint:
  // retain all sanitizer/URL/dimension checks, including malformed markup.
  if (!html || !/<im/i.test(html)) return false;
  return documentImages(html).images.some(candidate);
}
export function imageSourceHash(html:string|null){return createHash("sha256").update(sanitizeInboundHtml(html)??"").digest("hex");}
/** Includes image URLs that are deliberately absent from the sanitized body. */
export function imageSourceRevision(html:string|null){return createHash("sha256").update(html??"").digest("hex");}
export type ImageDownload = typeof downloadRemoteImage;
/** The default read path never calls this. Only an authorized explicit POST may resolve images. */
export async function renderRequestedImages(html:string|null,download:ImageDownload=downloadRemoteImage, requestSignal?:AbortSignal, retained:number[]=[], seen:number[]=[], remainingBytes=8*1024*1024, mode:"v2"|"legacy"="v2") {
  const {document,images}=documentImages(html);const timeout=AbortSignal.timeout(20_000);
  const signal=requestSignal ? AbortSignal.any([timeout,requestSignal]) : timeout;
  const replacements=new Map<string,string>();let loaded=0,spentBytes=0,attempted=0,retainedCount=0;
  const retainedSet=new Set(retained),seenSet=new Set(seen), slots:Array<{index:number;html:string;bytes:number}>=[],attemptedIndices:number[]=[];
  // Fixed categories only: never include sender-controlled URLs or error text.
  const reasons={ineligible:0,requestLimit:0,stopped:0,byteBudget:0,downloadFailed:0,invalidRaster:0};
  const failures={dns:0,destination:0,network:0,response:0,size:0,raster:0,cancelled:0,unknown:0};
  const maximumImageBytes=2*1024*1024, transferBudget=Math.min(8*1024*1024,remainingBytes);
  const ordered=images.map((image,index)=>({image,index})).sort((a,b)=>Number(seenSet.has(a.index))-Number(seenSet.has(b.index)));
  for(const {image,index} of ordered){
    const url=candidate(image);
    if(!url){reasons.ineligible++;continue;}
    if(retainedSet.has(index)){
      retainedCount++;
      const marker=`orca-image-${randomUUID()}`;image.attribs={alt:marker};
      replacements.set(marker,`<span data-orca-retained-slot="${index}"></span>`);continue;
    }
    if(attempted>=12){reasons.requestLimit++;continue;}
    if(signal.aborted){reasons.stopped++;continue;}
    if(spentBytes+maximumImageBytes>transferBudget){reasons.byteBudget++;continue;}
    attempted++;attemptedIndices.push(index);
    try {
      const bytes=await download(url,signal);
      spentBytes+=bytes.length;
      const mime=download===downloadRemoteImage ? rasterType(bytes) : await validatedRasterType(bytes,signal);
      if(signal.aborted){reasons.stopped++;continue;}
      if(!mime||bytes.length>maximumImageBytes){reasons.invalidRaster++;continue;}
      const marker=`orca-image-${randomUUID()}`;const alt=image.attribs.alt??"";
      image.attribs={alt:marker};
      const tag=`<img alt="${escape(alt)}" src="data:${mime};base64,${bytes.toString("base64")}" style="max-width:100%;height:auto">`;
      replacements.set(marker,tag);slots.push({index,html:tag,bytes:bytes.length});loaded++;
    }catch(error){
      // Unclassified errors and incomplete responses are charged conservatively;
      // DNS and pre-response connection errors consume no response body.
      if(error instanceof ImageFetchError){
        failures[error.reason]++;
        spentBytes+=(mode==="legacy" ? Math.max(error.bytes,maximumImageBytes) : ["dns","destination","network"].includes(error.reason) ? error.bytes : Math.max(error.bytes,maximumImageBytes));
      }else{failures.unknown++;spentBytes+=maximumImageBytes;}
      reasons.downloadFailed++;
    }
  }
  let bodyHtml=sanitizeInboundHtml(DomUtils.getOuterHTML(document))??"";
  for(const [marker,image] of replacements){bodyHtml=bodyHtml.replace(`<span class="orca-mail-image-note">[Image blocked: ${marker}]</span>`,image);}
  return {bodyHtml,sourceHash:imageSourceHash(html),sourceRevision:imageSourceRevision(html),loaded,blocked:images.length-loaded-retainedCount,attempted,reasons,failures,slots,attemptedIndices};
}
