/** Synthetic fresh-process cost, with optional temporary bundled-worker comparison.
 * bun apps/api/benchmarks/mail-search-process.ts [path-to-temporary-bundle.js]
 * Example comparison artifact: bun build apps/api/src/mailbox/search-worker.ts --target=bun --outfile=/tmp/search-worker.js
 * This does not make the temporary bundle a deployment dependency.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDatabaseClient } from '../src/db/client.ts';
import { setMailSearchEnabled } from '../src/db/mail-search-index.ts';
import { users, oauthAccounts, threads, emails } from '../src/db/schema.ts';
import { createMailSearchExecutorForTests, type MailSearchExecutionInput, type MailSearchExecutionObservation } from '../src/mailbox/search-executor.ts';
const root = mkdtempSync(join(tmpdir(), 'orca-process-measure-'));
const databasePath = join(root, 'mail.sqlite');
const client = createDatabaseClient(databasePath);
try {
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, '../drizzle') });
  setMailSearchEnabled(client.sqlite, true);
  client.db.insert(users).values({id:'owner', email:'owner@example.com'}).run();
  client.db.insert(oauthAccounts).values({id:'account',userId:'owner',provider:'gmail',providerEmail:'owner@example.com',providerId:'owner'}).run();
  client.sqlite.transaction(()=>{for(let i=0;i<100;i++){
    client.db.insert(threads).values({id:'thread'+i,accountId:'account',providerThreadId:'thread'+i,messageCount:1}).run();
    client.db.insert(emails).values({id:'email'+i,accountId:'account',providerMessageId:'email'+i,threadId:'thread'+i,subject:'Synthetic harbor mail',bodyText:'Synthetic private body '.repeat(300),receivedAt:new Date('2026-01-01T12:00:00Z')}).run();
  }})();
  const input:MailSearchExecutionInput={databasePath,authorization:{userId:'owner',accountIds:['account']},query:{query:'harbor',limit:100,view:'all'},searchBodyText:true};
  const raw=createMailSearchExecutorForTests();
  const comparisonPath = process.argv[2];
  const variants = { raw, ...(comparisonPath ? { bundle: createMailSearchExecutorForTests({ workerPath: resolve(comparisonPath) }) } : {}) };
  const values:Record<string,MailSearchExecutionObservation[]>={raw:[],bundle:[]};
  for(let i=0;i<10;i++)for(const [name,executor] of Object.entries(variants)){
    const result=await executor.read(input,{observe:sample=>values[name]!.push(sample)});
    if(result.response.counts.attention.all!==100||result.response.messages.length!==100)throw new Error('result mismatch');
  }
  for(const [name,samples]of Object.entries(values).filter(([, samples]) => samples.length > 0)){
    const sorted=samples.map(x=>x.processDurationMs).sort((a,b)=>a-b);
    console.log(JSON.stringify({variant:name,samples:samples.length,roundTripP50Ms:Math.round(sorted[5]!),roundTripMaxMs:Math.round(sorted.at(-1)!),meanReaderMs:Math.round(samples.reduce((s,x)=>s+x.readerDurationMs!,0)/samples.length),peakChildVmHWMMiB:samples.every(x => x.peakRssBytes !== null) ? Math.round(Math.max(...samples.map(x=>x.peakRssBytes!))/1024/1024) : null,individual:samples.map(x=>({roundTripMs:Math.round(x.processDurationMs),readerMs:Math.round(x.readerDurationMs!),vmHWMMiB:x.peakRssBytes === null ? null : Math.round(x.peakRssBytes/1024/1024)}))}));
  }
}finally{client.sqlite.close();rmSync(root,{recursive:true,force:true});}
