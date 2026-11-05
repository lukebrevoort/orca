import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { createMobileSession } from "../../auth/mobile/store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../../db/schema.ts";
import type { AuthVariables } from "../../auth/middleware.ts";
import { registerMessageImageRoutes } from "./routes.ts";
import { downloadRemoteImage, ImageFetchError, isPublicImageAddress, remoteImageURL, rasterType, validatedRasterType, imageByteLimit } from "./remote.ts";
import { hasLoadableImages, imageSourceHash, imageSourceRevision, renderRequestedImages } from "./render.ts";
import { createSession } from "../../auth/session-store.ts";
import sharp from "sharp";
import { sanitizeInboundHtml } from "../provider-html.ts";
// Small, synthetic 16 x 16 PNG (no real mail or remote resource).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=", "base64");
function paddedPng(size:number) {
 const chunk=Buffer.alloc(size-png.length);chunk.writeUInt32BE(chunk.length-12,0);chunk.write('orCa',4);
 let crc=0xffffffff;for(const byte of chunk.subarray(4,-4)){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
 return Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
}
const url=new URL("https://images.example.org/banner.png");

test("public-only image URLs reject local, alternate, credential and redirect-style inputs",()=>{
 for(const value of ["http://public.example/x","https://127.0.0.1/x","https://2130706433/x","https://[::1]/x","https://user:pass@public.example/x","https://public.example:8443/x","https://public.example/x#y","file:///x","data:image/png,x","https://localhost/x","https://public.example./x"])expect(remoteImageURL(value)).toBeNull();
 expect(remoteImageURL(url.href)?.href).toBe(url.href);
 for(const value of ["127.0.0.1","10.0.0.1","169.254.169.254","100.64.0.1","198.18.0.1","192.0.2.1","224.0.0.1","::1","::ffff:127.0.0.1","fe80::1","fc00::1","2001:db8::1","2002:7f00:1::","3fff::1"])expect(isPublicImageAddress(value)).toBe(false);
 expect(isPublicImageAddress("93.184.216.34")).toBe(true);expect(isPublicImageAddress("2606:4700:4700::1111")).toBe(true);
});

test("raster validation rejects pixels, huge decoded dimensions and non-raster data",()=>{
 expect(rasterType(png)).toBe("image/png");
 for(const size of [1,2,9000]){const changed=Buffer.from(png);changed.writeUInt32BE(size,16);expect(rasterType(changed)).toBeNull();}
 const bomb=Buffer.from(png);bomb.writeUInt32BE(8192,16);bomb.writeUInt32BE(8192,20);expect(rasterType(bomb)).toBeNull();
 expect(rasterType(Buffer.from('<svg onload="evil()"/>'))).toBeNull();
 expect(rasterType(png.subarray(0,33))).toBeNull();
 const corrupt=Buffer.from(png);corrupt[corrupt.length-17]^=1;expect(rasterType(corrupt)).toBeNull();
});
test("full bounded decoding rejects malformed JPEG and accepts real synthetic PNG",async()=>{
 expect(await validatedRasterType(png)).toBe('image/png');
 expect(await validatedRasterType(Buffer.from('ffd8ffc00008080010001000ffda0002ffd9','hex'))).toBeNull();
});

function transport(status=200,mime="image/png",body=png,extra:Record<string,string>={}) {
 let calls=0;let options:any;
 const request=((actual:URL,opts:any,callback:any)=>{
  calls++;options=opts;expect(actual.href).toBe(url.href);
  const req=new EventEmitter() as any;req.setTimeout=()=>req;req.destroy=()=>req;req.end=()=>queueMicrotask(()=>{const response=new PassThrough() as any;response.statusCode=status;response.headers={"content-type":mime,...extra};callback(response);response.end(body);});return req;
 }) as any;
 return {request,get calls(){return calls},get options(){return options}};
}
test("mixed private/public DNS answers are rejected before a socket opens",async()=>{
 const wire=transport();await expect(downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>[{address:"93.184.216.34",family:4},{address:"10.0.0.1",family:4}],request:wire.request})).rejects.toThrow();expect(wire.calls).toBe(0);
});
test("socket uses validated address without rebinding, credentials, redirects or pooled reuse",async()=>{
 const wire=transport();let resolves=0;const bytes=await downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>{resolves++;return [{address:"93.184.216.34",family:4}]},request:wire.request});expect(bytes).toEqual(png);expect(resolves).toBe(1);
 expect(wire.options.agent).toBe(false);expect(wire.options.servername).toBe(url.hostname);
 expect(wire.options.headers).toEqual({Accept:"image/png, image/jpeg","Accept-Encoding":"identity"});
 let pinned="";wire.options.lookup("different-host",{},(_e:any,address:string)=>{pinned=address});expect(pinned).toBe("93.184.216.34");
});
test("connection failure tries another validated pinned address without carrying client credentials",async()=>{
 const addresses:string[]=[];const wire=transport();
 const send=((actual:URL,options:any,callback:any)=>{
  options.lookup('',{},(_e:any,address:string)=>addresses.push(address));
  if(addresses.length===1){const req=new EventEmitter() as any;req.setTimeout=()=>req;req.end=()=>queueMicrotask(()=>req.emit('error',new Error('synthetic')));return req;}
  return wire.request(actual,options,callback);
 }) as any;
 expect(await downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>[{address:'93.184.216.34',family:4},{address:'1.1.1.1',family:4}],request:send})).toEqual(png);
 expect(addresses).toEqual(['93.184.216.34','1.1.1.1']);expect(wire.options.headers).toEqual({Accept:'image/png, image/jpeg','Accept-Encoding':'identity'});
});
test("synthetic baseline and progressive JPEGs pass the pinned downloader and renderer",async()=>{
 for(const progressive of [false,true]){
  const jpeg=await sharp({create:{width:16,height:16,channels:3,background:{r:60,g:100,b:150}}}).jpeg({progressive}).toBuffer();
  const wire=transport(200,'image/jpeg',jpeg);
  const bytes=await downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>[{address:'93.184.216.34',family:4}],request:wire.request});
  const result=await renderRequestedImages('<img src="https://images.example.org/banner.jpg">',async()=>bytes);
  expect(result.loaded).toBe(1);expect(result.bodyHtml).toContain('data:image/jpeg;base64,');
 }
});
test("redirects, compressed payloads, MIME mismatch and streamed oversize are rejected",async()=>{
 for(const wire of [transport(302),transport(200,"image/svg+xml"),transport(200,"image/jpeg"),transport(200,"image/png",png,{"content-encoding":"gzip"}),transport(200,"image/png",Buffer.alloc(imageByteLimit+1)),transport(200,"image/png",png,{"content-length":String(imageByteLimit+1)})])await expect(downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>[{address:"93.184.216.34",family:4}],request:wire.request})).rejects.toThrow();
});
test("default sanitization blocks images; explicit partial loading preserves safe HTML and blocks pixels/resources",async()=>{
 const html='<p>Hello</p><img alt="Banner" src="https://images.example.org/banner.png"><img alt="Failed" src="https://images.example.org/missing.png"><img width="1" height="1" src="https://images.example.org/pixel"><img src="cid:logo"><script>evil()</script><div style="background:url(https://tracker.example/x)">Text</div>';
 expect(sanitizeInboundHtml(html)).not.toContain('<img');expect(hasLoadableImages(html)).toBe(true);
 let fetched=0;const result=await renderRequestedImages(html,async u=>{fetched++;if(u.pathname.includes('missing'))throw new Error('secret remote URL');return png});
 expect(fetched).toBe(2);expect(result.loaded).toBe(1);expect(result.blocked).toBe(3);expect(result.bodyHtml).toContain('src="data:image/png;base64,');expect(result.bodyHtml).toContain('[Image blocked: Failed]');expect(result.bodyHtml).not.toMatch(/<script|https:\/\/|cid:|secret remote/);expect(result.sourceHash).toHaveLength(64);
 expect(result.attempted).toBe(2);expect(result.reasons).toEqual({ineligible:2,requestLimit:0,stopped:0,byteBudget:0,downloadFailed:1,invalidRaster:0});
});
test("image count and total byte budgets bound sender requests",async()=>{
 const html=Array.from({length:30},(_,i)=>`<img src="https://images.example.org/${i}" alt="Image">`).join('');let calls=0;
 await renderRequestedImages(html,async()=>{calls++;return png});expect(calls).toBe(12);
 calls=0;const large=paddedPng(2*1024*1024-1);const result=await renderRequestedImages(html,async()=>{calls++;return large});expect(calls).toBe(4);expect(result.loaded).toBe(4);
});
test("native POST resolves only an authenticated user's stored message, before any image request",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'orca-images-'));const path=join(dir,'db.sqlite');const {db,sqlite}=createDatabaseClient(path);migrate(db,{migrationsFolder:resolve(import.meta.dir,'../../../drizzle')});
 try{
  db.insert(users).values([{id:'owner',email:'owner@example.com'},{id:'stranger',email:'stranger@example.com'}]).run();db.insert(oauthAccounts).values({id:'account',userId:'owner',provider:'gmail',providerEmail:'owner@example.com',providerId:'provider'}).run();db.insert(threads).values({id:'thread',accountId:'account',providerThreadId:'thread'}).run();db.insert(emails).values({id:'message',accountId:'account',threadId:'thread',providerMessageId:'message',bodyHtml:'<img alt="Banner" src="https://images.example.org/banner.png">'}).run();
  const owner=createMobileSession(db,'owner'),stranger=createMobileSession(db,'stranger');let requests=0;const app=new Hono<{Variables:AuthVariables}>();registerMessageImageRoutes(app,{dbFactory:()=>createDatabaseClient(path),allowedOrigin:'https://orca.example',downloadImage:async()=>{requests++;return png}});
  const endpoint='/v1/messages/message/images/v2?accountId=account';
  const revision=imageSourceRevision('<img alt="Banner" src="https://images.example.org/banner.png">');
  const post=(token:string, rev=revision)=>({method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({revision:rev})});
  expect((await app.request(endpoint,{method:'POST'})).status).toBe(401);
  expect((await app.request(endpoint,{method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`,'Content-Type':'application/json'},body:'{}'})).status).toBe(400);
  const legacyEndpoint='/v1/messages/message/images?accountId=account';
  expect((await app.request(legacyEndpoint,{method:'POST',headers:{Authorization:`Bearer ${stranger.accessToken}`}})).status).toBe(404);
  expect((await app.request('/v1/messages/message/images',{method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`}})).status).toBe(400);
  expect((await app.request(endpoint,post(stranger.accessToken))).status).toBe(404);
  expect((await app.request('/v1/messages/message/images/v2?accountId=other',post(owner.accessToken))).status).toBe(404);
  expect((await app.request(endpoint,post(owner.accessToken,'0'.repeat(64)))).status).toBe(409);
  expect((await app.request(endpoint,post(owner.accessToken,imageSourceRevision('<img alt="Banner" src="https://images.example.org/other.png">')))).status).toBe(409);
  expect((await app.request(endpoint,{headers:{Authorization:`Bearer ${owner.accessToken}`}})).status).toBe(404);expect(requests).toBe(0);
  const response=await app.request(endpoint,post(owner.accessToken));expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect((await response.json()).loaded).toBe(1);expect(requests).toBe(1);
  const legacy=await app.request(legacyEndpoint,{method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`}});expect(legacy.status).toBe(200);
  const oldBody=await legacy.json();expect(Object.keys(oldBody).sort()).toEqual(['blocked','bodyHtml','loaded','sourceHash']);expect(oldBody.sourceHash).toBe(imageSourceHash('<img alt="Banner" src="https://images.example.org/banner.png">'));expect(oldBody.loaded).toBe(1);expect(requests).toBe(2);
  const oldSecret=process.env.SESSION_SECRET,oldKey=process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET='images-test-session-secret-long-enough';process.env.TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
  try {
   const session=await createSession(db,'owner'); const cookie=`orca_session=${session.token}`;
   expect((await app.request(legacyEndpoint,{method:'POST',headers:{cookie}})).status).toBe(403);
   const web=(origin?:string,contentType='application/json')=>({method:'POST',headers:{cookie,...(origin?{origin}:{}),'content-type':contentType},body:JSON.stringify({revision})});
   expect((await app.request(endpoint,web())).status).toBe(403);
   expect((await app.request(endpoint,web('https://evil.example'))).status).toBe(403);
   expect((await app.request(endpoint,web('https://orca.example','text/plain'))).status).toBe(400);
   const other=await createSession(db,'stranger');
   expect((await app.request(endpoint,{...web('https://orca.example'),headers:{cookie:`orca_session=${other.token}`,origin:'https://orca.example','content-type':'application/json'}})).status).toBe(404);
   expect((await app.request(endpoint,{method:'POST',headers:{cookie,origin:'https://orca.example','content-type':'application/json'},body:JSON.stringify({revision,padding:'x'.repeat(5000)})})).status).toBe(413);
   expect(requests).toBe(2);
   expect((await app.request(endpoint,web('https://orca.example'))).status).toBe(200);expect(requests).toBe(3);
  }finally{if(oldSecret===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=oldSecret;if(oldKey===undefined)delete process.env.TOKEN_ENCRYPTION_KEY;else process.env.TOKEN_ENCRYPTION_KEY=oldKey;}
 }finally{sqlite.close();rmSync(dir,{recursive:true,force:true});}
});
test("duplicate concurrent requests cannot start a second set of downloads",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'orca-images-busy-'));const path=join(dir,'db.sqlite');const {db,sqlite}=createDatabaseClient(path);migrate(db,{migrationsFolder:resolve(import.meta.dir,'../../../drizzle')});
 try{
  db.insert(users).values({id:'owner',email:'owner@example.com'}).run();db.insert(oauthAccounts).values({id:'account',userId:'owner',provider:'gmail',providerEmail:'owner@example.com',providerId:'provider'}).run();db.insert(threads).values({id:'thread',accountId:'account',providerThreadId:'thread'}).run();const html='<img src="https://images.example.org/banner.png">';db.insert(emails).values({id:'message',accountId:'account',threadId:'thread',providerMessageId:'message',bodyHtml:html}).run();
  const owner=createMobileSession(db,'owner');let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let calls=0;
  const app=new Hono<{Variables:AuthVariables}>();registerMessageImageRoutes(app,{dbFactory:()=>createDatabaseClient(path),downloadImage:async()=>{calls++;entered();await new Promise<void>(resolve=>{release=resolve;});return png;}});
  const post=()=>({method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({revision:imageSourceRevision(html)})});
  const first=app.request('/v1/messages/message/images/v2?accountId=account',post());await started;
  expect((await app.request('/v1/messages/message/images/v2?accountId=account',post())).status).toBe(429);expect(calls).toBe(1);
  release();expect((await first).status).toBe(200);
 }finally{sqlite.close();rmSync(dir,{recursive:true,force:true});}
});

test("failed downloads spend their allowance and a partly used budget is never overrun",async()=>{
 const html=Array.from({length:30},(_,i)=>`<img src="https://images.example.org/${i}">`).join('');let calls=0;
 const failed=await renderRequestedImages(html,async()=>{calls++;throw new Error("secret sender URL");});expect(calls).toBe(4);
 expect(failed.reasons.downloadFailed).toBe(4);expect(failed.reasons.byteBudget).toBe(26);
 expect(JSON.stringify(failed.reasons)).not.toContain("secret");
 calls=0;let transferred=0;const almost=paddedPng(2*1024*1024-100);
 await renderRequestedImages(html,async()=>{calls++;transferred+=almost.length;return almost;});expect(calls).toBe(4);expect(transferred).toBeLessThanOrEqual(8*1024*1024);
});
test("synthetic newsletter-shaped input exposes conservative failure budgeting without network access",async()=>{
 const html=Array.from({length:26},(_,i)=>`<img src="https://images.example.org/${i}.png">`).join('')
   + '<img width="3" height="1" src="https://images.example.org/pixel.gif">'.repeat(2);
 let calls=0;
 const result=await renderRequestedImages(html,async()=>{calls++;throw new Error('synthetic failure');});
 expect(calls).toBe(4);expect(result.loaded).toBe(0);expect(result.reasons.downloadFailed).toBe(4);
 expect(result.reasons.byteBudget).toBe(22);expect(result.reasons.ineligible).toBe(2);
});
test("retry retains successful slots and prioritizes previously unattempted candidates",async()=>{
 const html=Array.from({length:26},(_,i)=>`<img alt="Image ${i}" src="https://images.example.org/${i}.png">`).join('');
 const first=await renderRequestedImages(html,async()=>png);expect(first.loaded).toBe(12);expect(first.reasons.requestLimit).toBe(14);
 const paths:string[]=[];
 const second=await renderRequestedImages(html,async u=>{paths.push(u.pathname);return png;},undefined,first.slots.map(s=>s.index),first.attemptedIndices);
 expect(paths).toEqual(Array.from({length:12},(_,i)=>`/${i+12}.png`));expect(second.loaded).toBe(12);
 expect(second.bodyHtml).toContain('<span data-orca-retained-slot="0"></span>');
 expect(second.bodyHtml).not.toContain('https://');
 const failures=await renderRequestedImages(html,async()=>{throw new ImageFetchError('dns')});
 expect(failures.attempted).toBe(12);expect(failures.failures.dns).toBe(12);expect(failures.reasons.byteBudget).toBe(0);
 const legacy=await renderRequestedImages(html,async()=>{throw new ImageFetchError('dns');},undefined,[],[],undefined,'legacy');
 expect(legacy.attempted).toBe(4);expect(legacy.reasons.byteBudget).toBe(22);
});
test("source revision changes when only an image URL changes",()=>{
 const a='<img alt="Banner" src="https://images.example.org/one.png">';
 const b='<img alt="Banner" src="https://images.example.org/two.png">';
 expect(sanitizeInboundHtml(a)).toBe(sanitizeInboundHtml(b));expect(imageSourceRevision(a)).not.toBe(imageSourceRevision(b));
});
test("global cancellation interrupts DNS before any socket is opened",async()=>{
 const controller=new AbortController();const wire=transport();const pending=downloadRemoteImage(url,controller.signal,{resolve:()=>new Promise(()=>{}),request:wire.request});controller.abort();await expect(pending).rejects.toThrow();expect(wire.calls).toBe(0);
});
test("cancellation prevents later candidates from starting",async()=>{
 const controller=new AbortController();let calls=0;
 const html=Array.from({length:5},(_,i)=>`<img src="https://images.example.org/${i}.png">`).join('');
 const result=await renderRequestedImages(html,async()=>{calls++;controller.abort();throw new ImageFetchError('cancelled');},controller.signal);
 expect(calls).toBe(1);expect(result.reasons.stopped).toBe(4);expect(result.failures.cancelled).toBe(1);
});
