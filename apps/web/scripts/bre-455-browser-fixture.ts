/** Owned synthetic HTTP fixture: real notification routes, full Orca API,
 * SQLite, Gmail persistence and browser constructor. No provider networking. */
import { Hono } from 'hono';
import { resolve,join,sep } from 'node:path';
import { writeFileSync } from 'node:fs';
import { notificationFixture } from '../../api/src/notifications/fixture.ts';
import { setMobilePushTestEnv,clearMobilePushTestEnv } from '../../api/src/mobile-push/test-helpers.ts';
import { createDatabaseClient } from '../../api/src/db/client.ts';
import { createApp } from '../../api/src/index.ts';
import { ProviderRegistry } from '../../api/src/providers/registry.ts';
import { gmailProvider } from '../../api/src/providers/gmail/provider.ts';
setMobilePushTestEnv();
const f=await notificationFixture();f.state.now=Date.now();
let providerCalls=0;
const app=createApp({dbFactory:()=>createDatabaseClient(f.path),providerRegistry:new ProviderRegistry([{...gmailProvider,createOAuthApp:()=>new Hono(),async syncPage(){return {nextCursor:null,emailCount:0,threadCount:0,labelCount:0,contactCount:0};},createTransport:()=>({async saveDraft(){throw new Error('No compose operation allowed in notification fixture');},async deleteDraft(){throw new Error('No provider draft delete allowed');},async send(){providerCalls++;throw new Error('No provider sending allowed');}})}])});
const web=resolve(import.meta.dir,'../dist');
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/__fixture/login'||url.pathname==='/__fixture/login-other')return new Response(null,{status:302,headers:{'set-cookie':`orca_session=${url.pathname.endsWith('other')?f.other.token:f.session.token}; HttpOnly; Path=/; SameSite=Lax`,location:'/'}});
 if(url.pathname==='/__fixture/fresh'&&request.method==='POST'){const input=await request.json() as {id:string;thread?:string};await f.fresh(input.id,input.thread??'conversation');return Response.json({now:f.state.now,threadId:`gmail:a:${input.thread??'conversation'}`});}
 if(url.pathname==='/__fixture/old'&&request.method==='POST'){await f.persist(f.message('old','old'));await f.important('gmail:a:old');return Response.json({threadId:'gmail:a:old'});}
 if(url.pathname==='/__fixture/advance'&&request.method==='POST'){const input=await request.json() as {milliseconds:number};if(!Number.isSafeInteger(input.milliseconds)||input.milliseconds<0||input.milliseconds>3600000)return new Response(null,{status:400});f.state.now+=input.milliseconds;return Response.json({now:f.state.now});}
 if(url.pathname==='/__fixture/state')return Response.json({providerCalls,arrivals:f.sqlite.query('select * from important_notification_arrivals').all(),deliveries:f.sqlite.query('select * from important_notification_web_deliveries').all()});
 if(url.pathname.startsWith('/v1/notifications/'))return f.app.fetch(request);
 if(url.pathname.startsWith('/v1/')||url.pathname==='/health')return app.fetch(request);
 const path=resolve(web,'.'+url.pathname);if(path!==web&&!path.startsWith(web+sep))return new Response(null,{status:404});
 const file=Bun.file(path);return new Response(path!==web&&await file.exists()?file:Bun.file(join(web,'index.html')));
}});
const directory=resolve(f.path,'..'),metadata=join(directory,'connection.json');
writeFileSync(metadata,JSON.stringify({url:`http://127.0.0.1:${server.port}`,directory,databasePath:f.path}));console.log(metadata);
function stop(){server.stop(true);f.sqlite.close();clearMobilePushTestEnv();process.exit(0);}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,stop);
