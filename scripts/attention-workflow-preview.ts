// Isolated browser verification harness. Run with Bun; ATTENTION_REPO points to the built worktree.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const repo = process.env.ATTENTION_REPO;
if (!repo) throw new Error('Set ATTENTION_REPO to the isolated implementation worktree.');
process.env.SESSION_SECRET = randomBytes(48).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { createDatabaseClient } = await import(join(repo, 'apps/api/src/db/client.ts'));
const schema = await import(join(repo, 'apps/api/src/db/schema.ts'));
const { migrate } = await import(join(repo, 'node_modules/drizzle-orm/bun-sqlite/migrator.js'));
const { createSession } = await import(join(repo, 'apps/api/src/auth/session-store.ts'));
const { createApp } = await import(join(repo, 'apps/api/src/index.ts'));
const directory = mkdtempSync(join(tmpdir(), 'orca-attention-browser-'));
const databasePath = join(directory, 'sample.sqlite');
const client = createDatabaseClient(databasePath);
migrate(client.db, { migrationsFolder: join(repo, 'apps/api/drizzle') });
client.db.insert(schema.users).values([
  {id:'sample-owner',email:'luke@example.com',displayName:'Luke',onboardingCompletedAt:new Date()},
  {id:'sample-foreign',email:'private@example.com',displayName:'Private account',onboardingCompletedAt:new Date()},
]).run();
client.db.insert(schema.userPreferences).values({userId:'sample-owner',firstViewGuidanceCompletedAt:new Date().toISOString()}).run();
client.db.insert(schema.oauthAccounts).values([
  {id:'sample-work',userId:'sample-owner',provider:'gmail',providerId:'sample-work',providerEmail:'luke@studio.example',scope:'https://www.googleapis.com/auth/gmail.readonly',lastSyncedAt:new Date()},
  {id:'sample-personal',userId:'sample-owner',provider:'gmail',providerId:'sample-personal',providerEmail:'luke@personal.example',scope:'https://www.googleapis.com/auth/gmail.readonly',lastSyncedAt:new Date()},
  {id:'sample-foreign',userId:'sample-foreign',provider:'gmail',providerId:'sample-foreign',providerEmail:'private@example.com',scope:'https://www.googleapis.com/auth/gmail.readonly',lastSyncedAt:new Date()},
]).run();
const samples = [
 ['sample-work','kickoff','maya@studio.example','Maya Chen','Kickoff notes','The first draft is ready. Could you take a look before our kickoff?'],
 ['sample-work','review','maya@studio.example','Maya Chen','Thursday review','I have two small questions for our Thursday review.'],
 ['sample-work','timeline','alex@work.example','Alex Rivera','A little more time for the timeline','We can make room for another pass this week. Let me know what would help.'],
 ['sample-work','bulletin','hello@weekly.example','The Weekly Edit','This week in design','A short collection of things to read when you have time.'],
 ['sample-work','deploy','notifications@github.example','GitHub','Deployment finished','Your latest deployment is complete.'],
 ['sample-work','long','avery.morgan@long-company-name.example','Avery Morgan · Customer Experience and Research','A thoughtful follow-up on the research session','Thanks for taking the time. I have included the session notes and next steps.'],
 ['sample-personal','dinner','maya@studio.example','Maya Chen','Dinner on Friday?','Would Friday work for dinner?'],
 ['sample-personal','receipt','receipts@shop.example','Corner shop','Your receipt','Thanks for stopping by. Here is your receipt.'],
 ['sample-foreign','private','maya@studio.example','Maya Chen','Private account message','This must not appear for the sample owner.'],
];
// Optional larger fixture for exercising real mailbox cursors without production data.
const extraMessages = Math.min(300, Math.max(0, Number(process.env.ATTENTION_PREVIEW_EXTRA_MESSAGES) || 0));
for (let index = 0; index < extraMessages; index++) {
 const suffix = String(index).padStart(3, '0');
 samples.push(['sample-work', `page-${suffix}`, `person${suffix}@pages.example`, `Person ${suffix}`, `Pagination sample ${suffix}`, 'An older sample message for checking mailbox pagination.']);
}
client.db.insert(schema.threads).values(samples.map(([accountId,id,,,subject])=>({id:`thread-${id}`,accountId,providerThreadId:`provider-${id}`,subject,messageCount:1}))).run();
client.db.insert(schema.emails).values(samples.map(([accountId,id,fromAddress,fromName,subject,bodyText],index)=>({
 id:`message-${id}`,accountId,threadId:`thread-${id}`,providerMessageId:`provider-message-${id}`,fromAddress,fromName,subject,snippet:bodyText,bodyText,
 toRecipients:JSON.stringify([{email:accountId==='sample-personal'?'luke@personal.example':'luke@studio.example'}]),
 receivedAt:new Date(Date.now()-index*600000),isRead:index>2,humanSignal:9,humanClassification:'likely_human',humanClassificationReasons:'[]',
}))).run();
client.db.insert(schema.labels).values(['sample-work','sample-personal','sample-foreign'].map(accountId=>({id:`inbox-${accountId}`,accountId,providerLabelId:'INBOX',name:'INBOX',type:'system'}))).run();
client.db.insert(schema.emailLabels).values(samples.map(([accountId,id])=>({id:`label-${id}`,emailId:`message-${id}`,labelId:`inbox-${accountId}`}))).run();
if (process.env.ATTENTION_PREVIEW_LEGACY_CHOICES === '1') client.db.insert(schema.senderAttentionRules).values([
 {id:'rule-bulletin',accountId:'sample-work',scope:'address',value:'hello@weekly.example',behavior:'quiet',source:'user_choice'},
 {id:'rule-receipt',accountId:'sample-personal',scope:'address',value:'receipts@shop.example',behavior:'quiet',source:'user_choice'},
 {id:'rule-deploy',accountId:'sample-work',scope:'address',value:'notifications@github.example',behavior:'focus',source:'user_choice'},
]).run();
const session = await createSession(client.db,'sample-owner');
client.sqlite.close();
const app = createApp({dbFactory:()=>createDatabaseClient(databasePath)});
const dist = resolve(repo,'apps/web/dist');
if (!await Bun.file(join(dist,'index.html')).exists()) throw new Error('Build apps/web first.');
type PreviewFault = { method: string; path: string; status: number; afterCommit: boolean; delayMs: number; passthrough: boolean; queryIncludes: string };
let nextFault: PreviewFault | null = null;
const server = Bun.serve({idleTimeout:30,hostname:'127.0.0.1',port:Number(process.env.ATTENTION_PREVIEW_PORT ?? 0),async fetch(request) {
 const url = new URL(request.url);
 if (url.pathname === '/__preview/fault' && request.method === 'POST') {
   const raw = await request.json() as Partial<PreviewFault>;
   if (!((raw.path?.startsWith('/v1/attention/') || raw.path?.startsWith('/v1/destinations')) || (raw.path === '/v1/inbox' && raw.method === 'GET')) || !['GET','PUT','POST','PATCH'].includes(raw.method ?? '')) return Response.json({error:'Only Attention fixture requests can be faulted.'},{status:400});
   nextFault = { method:raw.method!, path:raw.path, status:raw.status === 401 ? 401 : raw.status === 403 ? 403 : 503, afterCommit:raw.afterCommit === true, delayMs:Math.min(15000,Math.max(0,Number(raw.delayMs)||0)), passthrough:raw.passthrough === true, queryIncludes:typeof raw.queryIncludes === 'string' ? raw.queryIncludes : '' };
   return Response.json({queued:true});
 }
 // Synthetic sync stays local: preserve the real mailbox read path without provider calls.
 if (url.pathname === '/v1/sync/gmail' && request.method === 'POST') return Response.json({synthetic:true});
 if (url.pathname === '/v1/sync/status') {
   const headers = new Headers(request.headers); headers.set('cookie',`orca_session=${session.token}`);
   const response = await app.fetch(new Request(request,{headers}));
   const status = await response.json() as { accounts: Array<Record<string,unknown>> };
   return Response.json({accounts:status.accounts.map(account=>({...account,state:'idle',error:null}))});
 }
 if (url.pathname.startsWith('/v1/')) {
   if (!['GET','HEAD'].includes(request.method) && !/^\/v1\/(attention|destinations|threads|messages|preferences)(\/|$)/.test(url.pathname)) return Response.json({error:{message:'This isolated preview only supports mail organization changes.'}},{status:403});
   const headers = new Headers(request.headers); headers.set('cookie',`orca_session=${session.token}`);
   const fault = nextFault?.method === request.method && nextFault.path === url.pathname && url.search.includes(nextFault.queryIncludes) ? nextFault : null;
   if (fault) {
     nextFault = null;
     if (fault.passthrough) {
       const captured = await app.fetch(new Request(request,{headers}));
       const body = await captured.arrayBuffer();
       if (fault.delayMs) await Bun.sleep(fault.delayMs);
       return new Response(body,{status:captured.status,headers:captured.headers});
     }
     if (fault.delayMs) await Bun.sleep(fault.delayMs);
     if (fault.afterCommit) await app.fetch(new Request(request,{headers}));
     return Response.json({error:{message:fault.afterCommit ? 'The response could not be confirmed. Reload your saved choice.' : 'Temporary preview failure. Try reloading.'}},{status:fault.status});
   }
   return app.fetch(new Request(request,{headers}));
 }
 if (url.pathname === '/__preview/guide') {
   const guide = Bun.file(join(repo, 'docs/attention-verification.html'));
   if (!await guide.exists()) return new Response('Review guide not installed in this worktree.', {status:404});
   return new Response((await guide.text()).replaceAll('src="attention-evidence/', 'src="/__preview/evidence/'), {headers:{'content-type':'text/html'}});
 }
 if (url.pathname.startsWith('/__preview/evidence/')) {
   const filename = url.pathname.slice('/__preview/evidence/'.length);
   if (!/^[a-z0-9-]+\.png$/.test(filename)) return new Response('Not found',{status:404});
   const screenshot = Bun.file(join(repo,'docs/attention-evidence',filename));
   return await screenshot.exists() ? new Response(screenshot) : new Response('Not found',{status:404});
 }
 if(url.pathname==='/__preview/info') return Response.json({kind:'synthetic mailbox',accounts:['sample-work','sample-personal'],database:directory});
 let pathname; try { pathname=decodeURIComponent(url.pathname); } catch { return new Response('Bad path',{status:400}); }
 const target = resolve(dist,'.'+pathname);
 if (!target.startsWith(dist+'/') && target!==dist) return new Response('Not found',{status:404});
 const asset = Bun.file(target);
 if (target!==dist && await asset.exists() && pathname.includes('.')) return new Response(asset);
 const html = (await Bun.file(join(dist,'index.html')).text()).replace('</body>','<aside aria-label="Preview environment" style="position:fixed;bottom:4px;right:8px;z-index:10000;padding:3px 8px;border-radius:4px;background:#182c25;color:white;font:11px sans-serif;pointer-events:none">Synthetic mailbox · changes stay in this preview</aside></body>');
 return new Response(html,{headers:{'content-type':'text/html'}});
}});
console.log(JSON.stringify({url:server.url.href,databasePath,kind:'isolated synthetic mailbox'}));

// Keep the disposable mailbox for the preview lifetime, then remove it on shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
 server.stop(true);
 rmSync(directory, {recursive:true, force:true});
 process.exit(0);
});
