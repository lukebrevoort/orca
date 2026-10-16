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
import { downloadRemoteImage, isPublicImageAddress, remoteImageURL, rasterType, imageByteLimit } from "./remote.ts";
import { hasLoadableImages, renderRequestedImages } from "./render.ts";
import { sanitizeInboundHtml } from "../provider-html.ts";
// Small, synthetic 16 x 16 PNG (no real mail or remote resource).
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP8z0AaYCJR/aiGUQ2jGgAAQC8BH/YPB3YAAAAASUVORK5CYII=", "base64");
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
test("redirects, compressed payloads, MIME mismatch and streamed oversize are rejected",async()=>{
 for(const wire of [transport(302),transport(200,"image/svg+xml"),transport(200,"image/jpeg"),transport(200,"image/png",png,{"content-encoding":"gzip"}),transport(200,"image/png",Buffer.alloc(imageByteLimit+1)),transport(200,"image/png",png,{"content-length":String(imageByteLimit+1)})])await expect(downloadRemoteImage(url,AbortSignal.timeout(1000),{resolve:async()=>[{address:"93.184.216.34",family:4}],request:wire.request})).rejects.toThrow();
});
test("default sanitization blocks images; explicit partial loading preserves safe HTML and blocks pixels/resources",async()=>{
 const html='<p>Hello</p><img alt="Banner" src="https://images.example.org/banner.png"><img alt="Failed" src="https://images.example.org/missing.png"><img width="1" height="1" src="https://images.example.org/pixel"><img src="cid:logo"><script>evil()</script><div style="background:url(https://tracker.example/x)">Text</div>';
 expect(sanitizeInboundHtml(html)).not.toContain('<img');expect(hasLoadableImages(html)).toBe(true);
 let fetched=0;const result=await renderRequestedImages(html,async u=>{fetched++;if(u.pathname.includes('missing'))throw new Error('secret remote URL');return png});
 expect(fetched).toBe(2);expect(result.loaded).toBe(1);expect(result.blocked).toBe(3);expect(result.bodyHtml).toContain('src="data:image/png;base64,');expect(result.bodyHtml).toContain('[Image blocked: Failed]');expect(result.bodyHtml).not.toMatch(/<script|https:\/\/|cid:|secret remote/);expect(result.sourceHash).toHaveLength(64);
});
test("image count and total byte budgets bound sender requests",async()=>{
 const html=Array.from({length:30},(_,i)=>`<img src="https://images.example.org/${i}" alt="Image">`).join('');let calls=0;
 await renderRequestedImages(html,async()=>{calls++;return png});expect(calls).toBe(12);
 calls=0;const large=Buffer.alloc(2*1024*1024);png.copy(large);const result=await renderRequestedImages(html,async()=>{calls++;return large});expect(calls).toBe(4);expect(result.loaded).toBe(4);
});
test("native POST resolves only an authenticated user's stored message, before any image request",async()=>{
 const dir=mkdtempSync(join(tmpdir(),'orca-images-'));const path=join(dir,'db.sqlite');const {db,sqlite}=createDatabaseClient(path);migrate(db,{migrationsFolder:resolve(import.meta.dir,'../../../drizzle')});
 try{
  db.insert(users).values([{id:'owner',email:'owner@example.com'},{id:'stranger',email:'stranger@example.com'}]).run();db.insert(oauthAccounts).values({id:'account',userId:'owner',provider:'gmail',providerEmail:'owner@example.com',providerId:'provider'}).run();db.insert(threads).values({id:'thread',accountId:'account',providerThreadId:'thread'}).run();db.insert(emails).values({id:'message',accountId:'account',threadId:'thread',providerMessageId:'message',bodyHtml:'<img alt="Banner" src="https://images.example.org/banner.png">'}).run();
  const owner=createMobileSession(db,'owner'),stranger=createMobileSession(db,'stranger');let requests=0;const app=new Hono<{Variables:AuthVariables}>();registerMessageImageRoutes(app,{dbFactory:()=>createDatabaseClient(path),downloadImage:async()=>{requests++;return png}});
  const endpoint='/v1/messages/message/images?accountId=account';
  expect((await app.request(endpoint,{method:'POST'})).status).toBe(401);
  expect((await app.request(endpoint,{method:'POST',headers:{Authorization:`Bearer ${stranger.accessToken}`}})).status).toBe(404);
  expect((await app.request('/v1/messages/message/images?accountId=other',{method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`}})).status).toBe(404);
  expect((await app.request(endpoint,{headers:{Authorization:`Bearer ${owner.accessToken}`}})).status).toBe(404);expect(requests).toBe(0);
  const response=await app.request(endpoint,{method:'POST',headers:{Authorization:`Bearer ${owner.accessToken}`}});expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('private, no-store');expect((await response.json()).loaded).toBe(1);expect(requests).toBe(1);
 }finally{sqlite.close();rmSync(dir,{recursive:true,force:true});}
});
