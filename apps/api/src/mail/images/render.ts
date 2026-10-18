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
export function hasLoadableImages(html: string | null) {
  // htmlparser2 recognizes img and the legacy image alias; tag names are not
  // entity-decoded and the provider policy does not synthesize image tags.
  // Use their common prefix only to prove absence. A match is just a hint:
  // retain all sanitizer/URL/dimension checks, including malformed markup.
  if (!html || !/<im/i.test(html)) return false;
  return documentImages(html).images.some(candidate);
}
export function imageSourceHash(html:string|null){return createHash("sha256").update(sanitizeInboundHtml(html)??"").digest("hex");}
export type ImageDownload = typeof downloadRemoteImage;
/** The default read path never calls this. Only an authorized explicit POST may resolve images. */
export async function renderRequestedImages(html:string|null,download:ImageDownload=downloadRemoteImage) {
  const {document,images}=documentImages(html);const signal=AbortSignal.timeout(20_000);
  const replacements=new Map<string,string>();let loaded=0,spentBytes=0,attempted=0;
  const maximumImageBytes=2*1024*1024, transferBudget=8*1024*1024;
  for(const image of images){
    const url=candidate(image);if(!url||attempted>=12||signal.aborted||spentBytes+maximumImageBytes>transferBudget)continue;attempted++;
    try {
      const bytes=await download(url,signal);
      spentBytes+=bytes.length;
      const mime=rasterType(bytes);
      if(!mime||bytes.length>maximumImageBytes)continue;
      const marker=`orca-image-${randomUUID()}`;const alt=image.attribs.alt??"";
      image.attribs={alt:marker};
      replacements.set(marker,`<img alt="${escape(alt)}" src="data:${mime};base64,${bytes.toString("base64")}" style="max-width:100%;height:auto">`);loaded++;
    }catch{
      // A failure may have consumed its entire streaming allowance. Charge it conservatively.
      spentBytes+=maximumImageBytes;
    }
  }
  let bodyHtml=sanitizeInboundHtml(DomUtils.getOuterHTML(document))??"";
  for(const [marker,image] of replacements){bodyHtml=bodyHtml.replace(`<span class="orca-mail-image-note">[Image blocked: ${marker}]</span>`,image);}
  return {bodyHtml,sourceHash:imageSourceHash(html),loaded,blocked:images.length-loaded};
}
