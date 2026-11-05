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
 expect(calls).toBe(0);expect(container.textContent).toContain("Images are blocked");
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
