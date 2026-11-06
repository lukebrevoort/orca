import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { MessageImageBody } from "./message-image-body";

const globals=["window","document","navigator","HTMLElement","Element","Node","Event","MouseEvent","fetch"] as const;
const originals=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
let browser:InstanceType<typeof Window>, root:Root, container:HTMLDivElement;
beforeEach(()=>{
  browser=new Window({url:"http://localhost"});
  for(const name of globals.filter(name=>name!=="fetch"))Object.defineProperty(globalThis,name,{configurable:true,writable:true,value:name==="window"?browser:browser[name]});
  Object.defineProperty(globalThis,"IS_REACT_ACT_ENVIRONMENT",{configurable:true,value:true});
  container=document.createElement("div");document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{
  await act(async()=>root.unmount());
  for(const name of globals){const original=originals.get(name);if(original)Object.defineProperty(globalThis,name,original);else delete (globalThis as Record<string,unknown>)[name];}
  delete (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT;browser.close();
});
const revision="a".repeat(64);
const reasons={ineligible:0,requestLimit:0,stopped:0,byteBudget:0,downloadFailed:0,invalidRaster:0};
const props={accountId:"account",messageId:"message",revision,available:true,html:'<p>Original</p><span class="orca-mail-image-note">[Image blocked: Banner]</span>',text:null};
const response=(loaded:number,failed:number,index=0)=>{const tag=`<img alt="Fixture ${index}" src="data:image/png;base64,AA==">`;return new Response(JSON.stringify({sourceRevision:revision,bodyHtml:`<p>Loaded fixture</p>${index?'<span data-orca-retained-slot="0"></span>':''}${loaded?tag:''}`,loaded,reasons:{...reasons,downloadFailed:failed},slots:loaded?[{index,html:tag,bytes:1}]:[],attemptedIndices:[index]}),{status:200,headers:{"content-type":"application/json"}});};
test("explicit consent, duplicate click, partial result and retry",async()=>{
 let calls=0,resolve!: (response:Response)=>void;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:()=>{calls++;return new Promise<Response>(done=>{resolve=done;});}});
 await act(async()=>root.render(<MessageImageBody {...props}/>));
 expect(calls).toBe(0);expect(container.querySelector("button")?.textContent).toBe("Load images");expect(container.textContent).not.toContain("Loading may tell the sender");
 await act(async()=>{const button=container.querySelector("button")!;button.click();button.click();});
 expect(calls).toBe(1);expect(container.textContent).toContain("Loading images");
 await act(async()=>resolve(response(1,1)));
 expect(container.textContent).toContain("1 image loaded. 1 remain unloaded");
 await act(async()=>container.querySelector("button")!.click());expect(calls).toBe(2);
 await act(async()=>resolve(response(1,0,1)));expect(container.textContent).toContain("2 images loaded");expect(container.querySelector(".reader-images-consent")).toBeNull();expect(container.querySelectorAll("img").length).toBe(2);expect(container.querySelector('img[alt="Fixture 0"]')).not.toBeNull();
});
test("unmount aborts pending work and stale results cannot replace a different message",async()=>{
 let resolve!: (response:Response)=>void;let signal:AbortSignal|undefined;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:(_url:string,init:RequestInit)=>{signal=init.signal??undefined;return new Promise<Response>(done=>{resolve=done;});}});
 await act(async()=>root.render(<MessageImageBody key="one" {...props}/>));
 await act(async()=>container.querySelector("button")!.click());
 await act(async()=>root.render(<MessageImageBody key="two" {...props} messageId="other" html="<p>Other message</p>"/>));
 expect(signal?.aborted).toBe(true);await act(async()=>resolve(response(1,0)));
 expect(container.textContent).toContain("Other message");expect(container.textContent).not.toContain("Loaded fixture");
});
test("a rejected v2 load does not fall back to the legacy route",async()=>{
 const paths:string[]=[];
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:async(path:string)=>{paths.push(path);return new Response('{}',{status:409});}});
 await act(async()=>root.render(<MessageImageBody {...props}/>));
 await act(async()=>container.querySelector('button')!.click());
 expect(paths).toEqual(['/v1/messages/message/images/v2?accountId=account']);
 expect(container.textContent).toContain('Images could not be loaded');
});
test("stale source requires a snapshot refresh and a new consent click",async()=>{
 const paths:string[]=[];let refreshes=0;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:async(path:string)=>{paths.push(path);return Response.json({error:{code:'stale_message',message:'changed'}},{status:409});}});
 await act(async()=>root.render(<MessageImageBody key="old" {...props} onRefresh={()=>{refreshes++;}}/>));
 await act(async()=>container.querySelector('button')!.click());
 expect(paths).toHaveLength(1);expect(container.textContent).toContain('This message changed');expect(container.querySelector('button')?.textContent).toBe('Refresh message');
 await act(async()=>container.querySelector('button')!.click());expect(refreshes).toBe(1);expect(paths).toHaveLength(1);
 await act(async()=>root.render(<MessageImageBody key="new" {...props} revision={'b'.repeat(64)} onRefresh={()=>{refreshes++;}}/>));
 expect(container.querySelector('button')?.textContent).toBe('Load images');expect(paths).toHaveLength(1);
 await act(async()=>container.querySelector('button')!.click());expect(paths).toHaveLength(2);
});
test("missing capability does not start a remote request or silently fall back",async()=>{
 let calls=0,refreshes=0;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:async()=>{calls++;return new Response('{}');}});
 await act(async()=>root.render(<MessageImageBody {...props} revision={undefined} available={undefined} onRefresh={()=>{refreshes++;}}/>));
 expect(container.textContent).toContain('Image loading is unavailable');expect(container.querySelector('button')?.textContent).toBe('Refresh message');expect(calls).toBe(0);
 await act(async()=>container.querySelector('button')!.click());expect(refreshes).toBe(1);expect(calls).toBe(0);
});
test("oversized source requires refresh but an unrelated 413 remains retryable",async()=>{
 let code="image_source_too_large",calls=0,refreshes=0;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:async()=>{calls++;return Response.json({error:{code}},{status:413});}});
 await act(async()=>root.render(<MessageImageBody key="large" {...props} onRefresh={()=>{refreshes++;}}/>));
 await act(async()=>container.querySelector('button')!.click());
 expect(container.textContent).toContain('Image loading is unavailable');expect(container.querySelector('button')?.textContent).toBe('Refresh message');
 await act(async()=>container.querySelector('button')!.click());expect(refreshes).toBe(1);expect(calls).toBe(1);
 code="request_too_large";
 await act(async()=>root.render(<MessageImageBody key="other" {...props} onRefresh={()=>{refreshes++;}}/>));
 await act(async()=>container.querySelector('button')!.click());
 expect(container.textContent).toContain('Images could not be loaded');expect(container.querySelector('button')?.textContent).toBe('Retry images');expect(calls).toBe(2);
});

test("progressive slots preserve loaded DOM, expanded history and link focus",async()=>{
 let wire!:ReadableStreamDefaultController<Uint8Array>;
 Object.defineProperty(globalThis,"fetch",{configurable:true,writable:true,value:async()=>new Response(new ReadableStream<Uint8Array>({start(controller){wire=controller;}}),{headers:{'content-type':'application/x-ndjson'}})});
 const send=async(event:unknown)=>act(async()=>{wire.enqueue(new TextEncoder().encode(JSON.stringify(event)+'\n'));});
 await act(async()=>root.render(<MessageImageBody {...props}/>));await act(async()=>container.querySelector('button')!.click());
 await send({type:'start',sourceRevision:revision,bodyHtml:'<p>Original</p><a href="https://example.com">Focus link</a><span class="orca-mail-image-note" data-orca-image-slot="0">[Image blocked: one]</span><span class="orca-mail-image-note" data-orca-image-slot="1">[Image blocked: two]</span><blockquote>Quoted history</blockquote>'});
 const history=container.querySelector('details')!;history.open=true;const link=container.querySelector('a')!;link.focus();
 const image=(index:number)=>({type:'image',sourceRevision:revision,slot:{index,bytes:1,html:`<img alt="Fixture ${index}" src="data:image/png;base64,AA==" style="max-width:100%;height:auto">`}});
 await send(image(0));const first=container.querySelector('img');expect(first).not.toBeNull();expect(container.textContent).toContain('Loading remaining images');
 await send(image(1));expect(container.querySelector('img')).toBe(first);expect(container.querySelector('details')).toBe(history);expect(history.open).toBe(true);expect(document.activeElement).toBe(link);
 await send({type:'complete',sourceRevision:revision,loaded:2,attempted:2,attemptedIndices:[0,1],reasons});
 await act(async()=>wire.close());expect(container.textContent).toContain('2 images loaded.');expect(container.textContent).not.toContain('Loading remaining images');
});
test("truncated progressive response retains successful slots for an explicit retry",async()=>{
 let wire!:ReadableStreamDefaultController<Uint8Array>;const requests:RequestInit[]=[];
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async(_path:string,init:RequestInit)=>{requests.push(init);if(requests.length>1)return response(1,0,1);return new Response(new ReadableStream<Uint8Array>({start(controller){wire=controller;}}),{headers:{'content-type':'application/x-ndjson'}});}});
 await act(async()=>root.render(<MessageImageBody {...props}/>));await act(async()=>container.querySelector('button')!.click());
 await act(async()=>{wire.enqueue(new TextEncoder().encode(JSON.stringify({type:'start',sourceRevision:revision,bodyHtml:'<span data-orca-image-slot="0">one</span>'})+'\n'+JSON.stringify({type:'image',sourceRevision:revision,slot:{index:0,bytes:1,html:'<img alt="Fixture 0" src="data:image/png;base64,AA==" style="max-width:100%;height:auto">'}})+'\n'));});
 await act(async()=>wire.close());expect(container.querySelectorAll('img')).toHaveLength(1);expect(container.textContent).toContain('Image loading was interrupted');
 await act(async()=>container.querySelector('button')!.click());expect(JSON.parse(requests[1]!.body as string).retained).toEqual([0]);expect(container.querySelectorAll('img')).toHaveLength(2);
});

test('switching accounts cancels progressive consumption and clears every prior image',async()=>{
 let wire!:ReadableStreamDefaultController<Uint8Array>,signal:AbortSignal|undefined,cancelled=0,calls=0;
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async(_path:string,init:RequestInit)=>{calls++;signal=init.signal??undefined;return new Response(new ReadableStream<Uint8Array>({start(controller){wire=controller;},cancel(){cancelled++;}}),{headers:{'content-type':'application/x-ndjson'}});}});
 await act(async()=>root.render(<MessageImageBody key="first" {...props}/>));
 await act(async()=>{const button=container.querySelector('button')!;button.click();button.click();});expect(calls).toBe(1);
 await act(async()=>wire.enqueue(new TextEncoder().encode(JSON.stringify({type:'start',sourceRevision:revision,bodyHtml:'<span data-orca-image-slot="0">not loaded</span>'})+'\n'+JSON.stringify({type:'image',sourceRevision:revision,slot:{index:0,bytes:1,html:'<img alt="Fixture 0" src="data:image/png;base64,AA==" style="max-width:100%;height:auto">'}})+'\n')));
 expect(container.querySelectorAll('img')).toHaveLength(1);
 await act(async()=>root.render(<MessageImageBody key="second" {...props} accountId="other" html="<p>Other account</p>"/>));
 expect(signal?.aborted).toBe(true);expect(cancelled).toBe(1);expect(calls).toBe(1);expect(container.querySelectorAll('img')).toHaveLength(0);expect(container.textContent).toContain('Other account');expect(container.querySelector('button')?.textContent).toBe('Load images');
});

test('large source positions display an image and truthfully stop unsupported selective retry',async()=>{
 const events=[{type:'start',sourceRevision:revision,bodyHtml:'<span data-orca-image-slot="10000">not loaded</span>'},{type:'image',sourceRevision:revision,slot:{index:10000,bytes:1,html:'<img alt="Far image" src="data:image/png;base64,AA==" style="max-width:100%;height:auto">'}},{type:'complete',sourceRevision:revision,loaded:1,attempted:1,attemptedIndices:[10000],reasons:{...reasons,requestLimit:1}}];
 Object.defineProperty(globalThis,'fetch',{configurable:true,writable:true,value:async()=>new Response(events.map(event=>JSON.stringify(event)).join('\n'),{headers:{'content-type':'application/x-ndjson'}})});
 await act(async()=>root.render(<MessageImageBody {...props}/>));await act(async()=>container.querySelector('button')!.click());
 expect(container.querySelectorAll('img')).toHaveLength(1);expect(container.textContent).toContain('Image limit reached');expect(container.querySelector('.reader-images-consent button')).toBeNull();
});
