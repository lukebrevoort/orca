import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { sanitizeInboundHtml, sanitizeImageSourceHtml } from "../provider-html.ts";
import { downloadRemoteImage, ImageFetchError, rasterType, validatedRasterType, remoteImageURL } from "./remote.ts";
import { withImagePermit } from "./permits.ts";
const {parseDocument,DomUtils}=createRequire(import.meta.url)("htmlparser2") as typeof import("htmlparser2");
// Bound input before either sanitizer or DOM parser allocates from sender HTML.
export const imageSourceByteLimit = 2 * 1024 * 1024;
export function imageSourceWithinLimit(html: string | null) {
  return !html || (html.length <= imageSourceByteLimit && Buffer.byteLength(html, "utf8") <= imageSourceByteLimit);
}
export class ImageSourceTooLargeError extends Error {
  constructor() { super("Image source exceeds the size limit"); }
}
function assertImageSourceLimit(html: string | null) {
  if (!imageSourceWithinLimit(html)) throw new ImageSourceTooLargeError();
}
const escapeText=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function documentImages(html:string|null){assertImageSourceLimit(html);const document=parseDocument(sanitizeImageSourceHtml(html)??"");return {document,images:DomUtils.findAll(n=>n.type==="tag"&&n.name==="img",document.children)};}
function blockedNote(image:ReturnType<typeof documentImages>["images"][number]) {
  let linked=false;
  for(let parent=image.parent;parent;parent=parent.parent){if(parent.type==="tag"&&parent.name==="a"&&parent.attribs.href){linked=true;break;}}
  const alt=image.attribs.alt?.trim() || (linked ? "Open linked image" : "");
  return alt ? DomUtils.getOuterHTML(parseDocument(`<span class="orca-mail-image-note">[Image blocked: ${escapeText(alt)}]</span>`)) : "";
}
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
  if (!html || !imageSourceWithinLimit(html) || !/<im/i.test(html)) return false;
  return documentImages(html).images.some(candidate);
}
export function imageSourceHash(html:string|null){assertImageSourceLimit(html);return createHash("sha256").update(sanitizeInboundHtml(html)??"").digest("hex");}
/** Includes image URLs that are deliberately absent from the sanitized body. */
export function imageSourceRevision(html:string|null){assertImageSourceLimit(html);return createHash("sha256").update(html??"").digest("hex");}
export type ImageDownload = typeof downloadRemoteImage;
export type ImageSlot = { index: number; html: string; bytes: number };
export type ImageProgress =
  | { type: "start"; sourceRevision: string; bodyHtml: string }
  | { type: "image"; sourceRevision: string; slot: ImageSlot };
export type ImageRenderOptions = { progressive?: (event: ImageProgress) => Promise<void>; concurrency?: 1 | 2 };
/** The default read path never calls this. Only an authorized explicit POST may resolve images. */
export async function renderRequestedImages(html:string|null,download:ImageDownload=downloadRemoteImage, requestSignal?:AbortSignal, retained:number[]=[], seen:number[]=[], remainingBytes=8*1024*1024, mode:"v2"|"legacy"="v2", options:ImageRenderOptions={}) {
  const {document,images}=documentImages(html);
  const cancel = new AbortController();
  const signal=AbortSignal.any([AbortSignal.timeout(20_000),cancel.signal,...(requestSignal ? [requestSignal] : [])]);
  const revision=imageSourceRevision(html), replacements=new Map<string,string>();
  let loaded=0,spentBytes=0,reservedBytes=0,attempted=0,retainedCount=0;
  const retainedSet=new Set(retained),seenSet=new Set(seen),slots:ImageSlot[]=[],attemptedIndices:number[]=[];
  // Fixed categories only: never include sender-controlled URLs or error text.
  const reasons={ineligible:0,requestLimit:0,stopped:0,byteBudget:0,downloadFailed:0,invalidRaster:0};
  const failures={dns:0,destination:0,network:0,response:0,size:0,raster:0,cancelled:0,unknown:0};
  const maximumImageBytes=2*1024*1024,transferBudget=Math.min(8*1024*1024,remainingBytes);
  const entries=images.map((image,index)=>({image,index,url:candidate(image),alt:image.attribs.alt??"",note:"",marker:""}))
    .sort((a,b)=>Number(seenSet.has(a.index))-Number(seenSet.has(b.index)));
  let selected=0;
  for(const entry of entries){
    if(!entry.url)continue;
    if(!retainedSet.has(entry.index)&&selected++>=12)continue;
    entry.note=blockedNote(entry.image);entry.marker=`orca-image-${randomUUID()}`;entry.image.attribs={alt:entry.marker};
    replacements.set(entry.marker,retainedSet.has(entry.index)
      ? `<span data-orca-retained-slot="${entry.index}"></span>`
      : entry.note);
  }
  const baseBody=sanitizeInboundHtml(DomUtils.getOuterHTML(document))??"";
  function body(progressive=false){
    let result=baseBody;
    for(const entry of entries){if(!entry.marker)continue;
      const value=progressive ? `<span data-orca-image-slot="${entry.index}">${entry.note || "Image not loaded"}</span>` : replacements.get(entry.marker)!;
      result=result.replace(`<span class="orca-mail-image-note">[Image blocked: ${entry.marker}]</span>`,value);
    }
    return result;
  }
  type Entry=typeof entries[number];
  type Completed={entry:Entry;bytes?:Buffer;mime?:string|null;error?:unknown;failed:boolean};
  const inFlight=new Map<number,Promise<Completed>>();
  async function fetchImage(entry:Entry):Promise<Completed>{
    try{return await withImagePermit(signal,async()=>{
      const bytes=await download(entry.url!,signal);
      const mime=download===downloadRemoteImage ? rasterType(bytes) : await validatedRasterType(bytes,signal);
      return {entry,bytes,mime,failed:false};
    });}catch(error){return {entry,error,failed:true};}
  }
  let cursor=0;
  try {
    if(options.progressive)await options.progressive({type:"start",sourceRevision:revision,bodyHtml:body(true)});
    while(cursor<entries.length || inFlight.size){
      while(cursor<entries.length && inFlight.size<(options.concurrency??1)){
        const entry=entries[cursor]!;
        if(!entry.url){reasons.ineligible++;cursor++;continue;}
        if(retainedSet.has(entry.index)){retainedCount++;cursor++;continue;}
        if(attempted>=12){reasons.requestLimit++;cursor++;continue;}
        if(signal.aborted){reasons.stopped++;cursor++;continue;}
        if(spentBytes+reservedBytes+maximumImageBytes>transferBudget){
          if(inFlight.size)break;
          reasons.byteBudget++;cursor++;continue;
        }
        cursor++;attempted++;attemptedIndices.push(entry.index);reservedBytes+=maximumImageBytes;
        inFlight.set(entry.index,fetchImage(entry));
      }
      if(!inFlight.size)continue;
      const result=await Promise.race(inFlight.values());
      const {entry}=result;inFlight.delete(entry.index);reservedBytes-=maximumImageBytes;
      if(result.failed){
        const error=result.error;
        if(error instanceof ImageFetchError){
          failures[error.reason]++;
          spentBytes+=(mode==="legacy" ? Math.max(error.bytes,maximumImageBytes) : ["dns","destination","network"].includes(error.reason) ? error.bytes : Math.max(error.bytes,maximumImageBytes));
        }else{failures.unknown++;spentBytes+=maximumImageBytes;}
        reasons.downloadFailed++;continue;
      }
      const bytes=result.bytes!;spentBytes+=bytes.length;
      if(signal.aborted){reasons.stopped++;continue;}
      if(!result.mime||bytes.length>maximumImageBytes){reasons.invalidRaster++;continue;}
      const tag=`<img alt="${escape(entry.alt)}" src="data:${result.mime};base64,${bytes.toString("base64")}" style="max-width:100%;height:auto">`;
      const slot={index:entry.index,html:tag,bytes:bytes.length};
      replacements.set(entry.marker,tag);slots.push(slot);loaded++;
      if(options.progressive)await options.progressive({type:"image",sourceRevision:revision,slot});
    }
    return {bodyHtml:body(),sourceHash:imageSourceHash(html),sourceRevision:revision,loaded,blocked:images.length-loaded-retainedCount,attempted,reasons,failures,slots,attemptedIndices};
  } finally {
    cancel.abort();
    // Keep the route's message lock and global permits until every started task settles.
    await Promise.allSettled(inFlight.values());
  }
}
