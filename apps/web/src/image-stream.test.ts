import {expect,test} from 'bun:test';
import {readImageStream,ImageStreamRevisionError} from './image-stream';
const revision='a'.repeat(64),reasons={ineligible:0,requestLimit:0,stopped:0,byteBudget:0,downloadFailed:0,invalidRaster:0};
const start={type:'start',sourceRevision:revision,bodyHtml:'<p>Résumé</p>'};
const slot=(index=0)=>({type:'image',sourceRevision:revision,slot:{index,bytes:1,html:`<img alt="Fixture ${index}" src="data:image/png;base64,AA==" style="max-width:100%;height:auto">`}});
const complete={type:'complete',sourceRevision:revision,loaded:1,attempted:1,reasons,attemptedIndices:[0]};
function response(events:unknown[],chunk=13){const bytes=new TextEncoder().encode(events.map(event=>JSON.stringify(event)).join('\n'));let offset=0;return new Response(new ReadableStream({pull(controller){if(offset>=bytes.length)return controller.close();controller.enqueue(bytes.slice(offset,offset+=chunk));}}));}
test('NDJSON accepts split UTF-8, multiple records per chunk and a final trailing fragment',async()=>{
 for(const chunk of [1,13,10000]){const events:unknown[]=[];await readImageStream(response([start,slot(),complete],chunk),revision,new AbortController().signal,event=>events.push(event));expect(events).toEqual([start,slot(),complete]);}
});
test('NDJSON rejects truncation, duplicate slots, invalid order, trailing records and stale revisions',async()=>{
 for(const events of [[start,slot()],[slot(),complete],[start,start],[start,slot(),slot(),complete],[start,slot(),complete,slot()],[start,{...slot(),sourceRevision:'b'.repeat(64)}]])await expect(readImageStream(response(events),revision,new AbortController().signal,()=>{})).rejects.toThrow();
 await expect(readImageStream(response([{...start,sourceRevision:'b'.repeat(64)}]),revision,new AbortController().signal,()=>{})).rejects.toBeInstanceOf(ImageStreamRevisionError);
});
test('NDJSON rejects external image markup and false terminal accounting',async()=>{
 for(const events of [[start,{...slot(),slot:{...slot().slot,html:'<img src="https://sender.invalid/x">'}},complete],[start,slot(),{...complete,loaded:0}],[start,slot(),{...complete,attemptedIndices:[1]}]])await expect(readImageStream(response(events),revision,new AbortController().signal,()=>{})).rejects.toThrow();
});
test('NDJSON caps incomplete record buffers and cancels their source',async()=>{
 let cancelled=false;const text=new TextEncoder().encode('x'.repeat(16*1024*1024+1));
 const stream=new ReadableStream({start(controller){controller.enqueue(text);},cancel(){cancelled=true;}});
 await expect(readImageStream(new Response(stream),revision,new AbortController().signal,()=>{})).rejects.toThrow('Image event too large');expect(cancelled).toBe(true);
});
test('aborting an idle NDJSON reader cancels it without awaiting another network chunk',async()=>{
 let cancelled=false;const controller=new AbortController();
 const pending=readImageStream(new Response(new ReadableStream({cancel(){cancelled=true;}})),revision,controller.signal,()=>{});
 controller.abort();await expect(pending).rejects.toThrow();expect(cancelled).toBe(true);
});

test('NDJSON accepts bounded server-escaped long alt text without lowering image limits',async()=>{
 const long=slot();long.slot.html=long.slot.html.replace('Fixture 0','&quot;'.repeat(600000));
 const events:unknown[]=[];await readImageStream(response([start,long,complete],1024*1024),revision,new AbortController().signal,event=>events.push(event));expect(events).toHaveLength(3);
});
