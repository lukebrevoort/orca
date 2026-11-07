export type ImageReasons = { ineligible:number; requestLimit:number; stopped:number; byteBudget:number; downloadFailed:number; invalidRaster:number };
export type ImageSlot = {index:number;html:string;bytes:number};
export type ImageSummary = {sourceRevision:string;loaded:number;attempted:number;reasons:ImageReasons;attemptedIndices:number[]};
export type ImageStreamEvent = {type:'start';sourceRevision:string;bodyHtml:string} | {type:'image';sourceRevision:string;slot:ImageSlot} | ({type:'complete'} & ImageSummary);
export class ImageStreamRevisionError extends Error {}
const maximumSourcePosition=2*1024*1024; // Output positions are bounded by the existing raw-source byte cap.
const integer=(value:unknown,max:number):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=max;
const reasonNames=['ineligible','requestLimit','stopped','byteBudget','downloadFailed','invalidRaster'] as const;
/** Allow source escaping (up to 6x 2MiB) plus base64 (up to 4/3 x 8MiB),
 * including one template and one copy of each slot. Bounded, ordered NDJSON; a truncated response is never a completed image load. */
export async function readImageStream(response:Response,revision:string,signal:AbortSignal,onEvent:(event:ImageStreamEvent)=>void) {
 if(!response.body)throw new Error('Missing image stream');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let buffered='',received=0,started=false,complete=false,slots=0,slotBytes=0;
 const indices=new Set<number>();
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 const consume=(line:string)=>{
  if(!line.trim())return;
  if(complete)throw new Error('Unexpected image event');
  const value=JSON.parse(line) as Record<string,unknown>;
  if(value.type==='error')throw new Error('Image stream interrupted');
  if(value.sourceRevision!==revision)throw new ImageStreamRevisionError('Image source changed');
  if(value.type==='start'){
   if(started||typeof value.bodyHtml!=='string'||value.bodyHtml.length>16*1024*1024)throw new Error('Invalid image template');
   started=true;onEvent(value as ImageStreamEvent);return;
  }
  if(!started)throw new Error('Missing image template');
  if(value.type==='image'){
   const slot=value.slot as ImageSlot|undefined;
   if(!slot||!integer(slot.index,maximumSourcePosition)||indices.has(slot.index)||!integer(slot.bytes,2*1024*1024-1)||slot.bytes===0||typeof slot.html!=='string'||slot.html.length>16*1024*1024||++slots>12)throw new Error('Invalid image slot');
   const match=/^<img alt="([^"]*)" src="data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})" style="max-width:100%;height:auto">$/.exec(slot.html);
   slotBytes+=slot.bytes;
   if(!match||/[<>]/.test(match[1])||match[1].replace(/&(?:amp|lt|gt|quot|#39);/g,'').includes('&')||match[2].length!==Math.ceil(slot.bytes/3)*4||slotBytes>8*1024*1024)throw new Error('Invalid image data');
   indices.add(slot.index);onEvent(value as ImageStreamEvent);return;
  }
  if(value.type==='complete'){
   const reasons=value.reasons as ImageReasons|undefined,attempted=value.attemptedIndices;
   if(!integer(value.loaded,12)||value.loaded!==slots||!integer(value.attempted,12)||!reasons||!reasonNames.every(key=>integer(reasons[key],2*1024*1024))||!Array.isArray(attempted)||attempted.length!==value.attempted||!attempted.every(index=>integer(index,maximumSourcePosition))||new Set(attempted).size!==attempted.length||[...indices].some(index=>!attempted.includes(index)))throw new Error('Invalid image summary');
   complete=true;onEvent(value as ImageStreamEvent);return;
  }
  throw new Error('Unknown image event');
 };
 try{
  while(true){
   if(signal.aborted)throw new Error('Image request cancelled');
   const {value,done}=await reader.read();
   if(done){buffered+=decoder.decode();if(buffered)consume(buffered);break;}
   received+=value.byteLength;if(received>40*1024*1024)throw new Error('Image stream too large');
   buffered+=decoder.decode(value,{stream:true});
   let end:number;while((end=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,end);buffered=buffered.slice(end+1);if(line.length>16*1024*1024)throw new Error('Image event too large');consume(line);}
   if(buffered.length>16*1024*1024)throw new Error('Image event too large');
  }
  if(signal.aborted||!complete)throw new Error('Incomplete image stream');
 }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
