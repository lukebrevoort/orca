/** Synthetic image eligibility benchmark. Each process measures one immutable revision. */
import assert from 'node:assert/strict';
import { mock, spyOn } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createSession } from '../src/auth/session-store.ts';
import { createDatabaseClient } from '../src/db/client.ts';
import * as schema from '../src/db/schema.ts';
const expectedSha = process.env.IMAGE_BENCH_SHA;
const role = process.env.IMAGE_BENCH_ROLE;
assert.ok(expectedSha && /^[a-f0-9]{40}$/.test(expectedSha));
assert.ok(role === 'baseline' || role === 'candidate');
const sha=Bun.spawnSync(['git','rev-parse','HEAD']).stdout.toString().trim();
assert.equal(sha, expectedSha);
assert.equal(Bun.spawnSync(['git','diff','--quiet']).exitCode, 0, 'tracked source must be clean');
assert.equal(Bun.spawnSync(['git','diff','--cached','--quiet']).exitCode, 0, 'index must be clean');
assert.ok(process.argv[2], 'provide a new output path');
const require = createRequire(import.meta.url);
const parserVersion = require('htmlparser2/package.json').version;
const sanitizerRequire = createRequire(require.resolve('sanitize-html'));
const sanitizerParserVersion = sanitizerRequire('htmlparser2/package.json').version;
assert.equal(parserVersion, '12.0.0'); assert.equal(sanitizerParserVersion, '12.0.0');
const provider = await import('../src/mail/provider-html.ts');
const sanitize = provider.sanitizeProviderHtml;
let providerCalls=0, providerInputBytes=0;
const providerSpy=spyOn(provider,'sanitizeProviderHtml').mockImplementation(html => {
  providerCalls++; providerInputBytes += Buffer.byteLength(html ?? ''); return sanitize(html);
});
const render = await import('../src/mail/images/render.ts');
const realScan = render.hasLoadableImages;
let calls=0, bytes=0, scanMs=0;
mock.module('../src/mail/images/render.ts', () => ({...render, hasLoadableImages(html:string|null) {
  calls++; bytes += Buffer.byteLength(html ?? ''); const start=performance.now();
  try { return realScan(html); } finally {scanMs += performance.now()-start;}
}}));
const {createApp} = await import('../src/index.ts');
const directory=mkdtempSync(join(tmpdir(),'orca-oct18-synthetic-'));
const path=join(directory,'fixture.sqlite');
let sqlite: ReturnType<typeof createDatabaseClient>['sqlite'] | undefined;
process.env.SESSION_SECRET='oct18-synthetic-only-session-secret';
process.env.TOKEN_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
let downloadCalls=0;
const app=createApp({dbFactory:()=>createDatabaseClient(path), downloadMessageImage:async()=>{downloadCalls++;throw Error('No network allowed in benchmark');}});
const rows: Array<Record<string, unknown>>=[];
const controls: Array<Record<string, unknown>>=[];

const payload=(size:number,image:boolean)=>{
 const tail=image?'<img alt="Synthetic" src="https://images.example.org/banner.png">':'';
 const unit='<p>Synthetic message content only.</p>';
 const remaining=size-tail.length;
 return unit.repeat(Math.floor(remaining/unit.length))+'x'.repeat(remaining%unit.length)+tail;
};
const workloads=[
 {name:'null-250',count:250,html:null},
 {name:'4KiB-250-noimg',count:250,html:payload(4096,false)},
 {name:'100KiB-1-noimg',count:1,html:payload(102400,false)},
 {name:'100KiB-50-noimg',count:50,html:payload(102400,false)},
 {name:'100KiB-50-tailimg',count:50,html:payload(102400,true)},
 {name:'1MiB-1-noimg',count:1,html:payload(1048576,false)},
 {name:'1MiB-10-tailimg',count:10,html:payload(1048576,true)},
];
try {
 const client=createDatabaseClient(path); sqlite=client.sqlite; const db=client.db;
 migrate(db,{migrationsFolder:resolve(import.meta.dir,'../drizzle')});
 db.insert(schema.users).values([{id:'owner',email:'owner@example.com'},{id:'other',email:'other@example.com'}]).run();
 db.insert(schema.oauthAccounts).values([{id:'account',userId:'owner',provider:'gmail',providerId:'owner',providerEmail:'owner@example.com'},{id:'foreign',userId:'other',provider:'gmail',providerId:'other',providerEmail:'other@example.com'}]).run();
 const session=await createSession(db,'owner');
 const headers={cookie:`orca_session=${session.token}`};
 for(const workload of workloads){
  db.insert(schema.threads).values({id:workload.name,accountId:'account',providerThreadId:workload.name,messageCount:workload.count}).run();
  for(let i=0;i<workload.count;i++) db.insert(schema.emails).values({id:`${workload.name}-${i}`,accountId:'account',threadId:workload.name,providerMessageId:`${workload.name}-${i}`,fromAddress:'sender@example.com',toRecipients:JSON.stringify([{name:null,email:'owner@example.com'}]),bodyHtml:workload.html,bodyText:'Synthetic plain text',receivedAt:new Date(1000+i),createdAt:new Date(1000+i)}).run();
 }
 db.insert(schema.threads).values({id:'private',accountId:'foreign',providerThreadId:'private',messageCount:1}).run();
 db.insert(schema.emails).values({id:'secret',accountId:'foreign',threadId:'private',providerMessageId:'secret',bodyHtml:payload(102400,true)}).run();
 const dbBefore=sqlite.query('PRAGMA page_count').get();
 async function request(url:string,auth=true){
  calls=0;bytes=0;scanMs=0;providerCalls=0;providerInputBytes=0;
  const cpu=process.cpuUsage(),rssBefore=process.memoryUsage().rss,start=performance.now();
  const response=await app.request(url,auth?{headers}:{});const body=await response.text();
  const wallMs=performance.now()-start,cpuUsed=process.cpuUsage(cpu),rssAfter=process.memoryUsage().rss;
  return {status:response.status,body,wallMs,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,rssBefore,rssAfter,scanCalls:calls,scanBytes:bytes,scanMs,providerCalls,providerInputBytes};
 }
 for(const [name,url,auth,status] of [
  ['unauthenticated','/v1/threads/100KiB-50-noimg?accountId=account',false,401],
  ['foreign-account','/v1/threads/private?accountId=foreign',true,404],
  ['foreign-thread','/v1/threads/private?accountId=account',true,404],
  ['missing-thread','/v1/threads/missing?accountId=account',true,404],
 ] as const){const r=await request(url,auth);assert.equal(r.status,status);assert.equal(r.scanCalls,0);assert.equal(r.providerCalls,0);controls.push({name,status:r.status,scanCalls:r.scanCalls});}
 for(const w of workloads){
  let signature='';
  for(let pair=-1;pair<6;pair++){
   for(const label of pair%2===0?['A','B']:['B','A']){
    const r=await request(`/v1/threads/${w.name}?accountId=account`);
    assert.equal(r.status,200);assert.equal(r.scanCalls,w.count);assert.equal(r.scanBytes,w.count*Buffer.byteLength(w.html??''));
    const expectedProviderCalls=role==='baseline'||w.name.includes('tailimg')?w.count:0;
    assert.equal(r.providerCalls,expectedProviderCalls);
    assert.equal(r.providerInputBytes,expectedProviderCalls*Buffer.byteLength(w.html??''));
    const body=JSON.parse(r.body);assert.equal(body.messages.length,w.count);
    for(const m of body.messages){assert.equal(m.accountId,'account');assert.equal(m.imageLoadAvailable,w.name.includes('tailimg'));assert.ok(!m.bodyHtml?.includes('<img'));}
    const hash=createHash('sha256').update(r.body).digest('hex');signature ||=hash;assert.equal(hash,signature);
    if(pair>=0){const {body:_,...metrics}=r;rows.push({workload:w.name,pair,label,...metrics,responseBytes:Buffer.byteLength(r.body),responseSha256:hash});}
   }
  }
  console.error(`completed ${w.name}`);
 }
 assert.equal(downloadCalls,0);assert.deepEqual(sqlite.query('PRAGMA page_count').get(),dbBefore);
 const output={revision:sha,role,mode:'one immutable revision per process; labels A/B are same-code repeats; instrumented warm in-process GET, no sockets',parserVersion,sanitizerParserVersion,lockSha256:createHash('sha256').update(readFileSync('bun.lock')).digest('hex'),harnessSha256:createHash('sha256').update(readFileSync(import.meta.path)).digest('hex'),runtime:Bun.version,cpu:cpus()[0]?.model,cpus:cpus().length,loadavg:loadavg(),workloads:workloads.map(({html,...w})=>({...w,bytesPerMessage:Buffer.byteLength(html??''),payloadSha256:createHash('sha256').update(html??'').digest('hex')})),controls,downloadCalls,dbPageCount:dbBefore,rows};
 writeFileSync(process.argv[2]!,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
}finally{sqlite?.close();rmSync(directory,{recursive:true,force:true});providerSpy.mockRestore();mock.restore();}
