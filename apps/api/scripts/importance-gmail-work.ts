/** Paired actual persistGmailMessages execution, immutable migration SQL, no provider calls. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { createDatabaseClient } from "../src/db/client.ts";
import { persistGmailMessages } from "../src/providers/gmail/sync.ts";
import type { GmailMessage } from "../src/providers/gmail/types.ts";
const root=resolve(import.meta.dir,"../../..");
function git(...args:string[]){const r=spawnSync("git",["-C",root,...args],{encoding:"utf8"});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
if(process.argv.includes("--worker")){
  const input=JSON.parse(await Bun.stdin.text()); const {db,sqlite}=createDatabaseClient(":memory:");
  try{
    for(const sql of input.sql) sqlite.exec(sql.text);
    sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.com'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','a','self@example.com')");
    const sqliteVersion=(sqlite.query("SELECT sqlite_version() v").get() as {v:string}).v;
    let prepares=0; const prepare=sqlite.prepare.bind(sqlite); Object.defineProperty(sqlite,"prepare",{configurable:true,value:(sql:string)=>{prepares++;return prepare(sql);}});
    const messages:GmailMessage[]=Array.from({length:input.n},(_,i)=>({id:`m${i}`,threadId:"one-long-thread",internalDate:String(1700000000000+i),labelIds:["INBOX","UNREAD"],snippet:"Synthetic receipt",payload:{mimeType:"text/plain",headers:[{name:"From",value:input.distinct?`person${i}@example.com`:"robot@example.com"},{name:"To",value:"self@example.com"},{name:"Subject",value:"Same conversation"}],body:{data:Buffer.from("Synthetic body").toString("base64")}}}));
    const results=[];
    for(const phase of ["insert","labelRefresh"]){
      if(phase==="labelRefresh") for(const m of messages)m.labelIds=["INBOX","UNREAD","STARRED"];
      const rssBeforeBytes=process.memoryUsage().rss; const cpu=process.cpuUsage();const start=performance.now();prepares=0;
      const result=await persistGmailMessages(db,{accountId:"a",accountEmail:"self@example.com",gmailMessages:messages,labelList:[{id:"INBOX",name:"Inbox"},{id:"UNREAD",name:"Unread"},{id:"STARRED",name:"Starred"}],now:new Date("2026-11-11T12:00:00Z"),propagationTrigger:"sync",propagationOptions:{enabled:false}});
      const wallMs=performance.now()-start; const used=process.cpuUsage(cpu); const preparedStatements=prepares;
      if(result.changedEmailCount!==input.n)throw Error("Refresh did not actually traverse changed-message association replacement");
      const state=sqlite.query("SELECT effective,participant_count,retained_count FROM importance_thread_state").get() as any;
      if(state.effective!=="unreviewed"||state.participant_count!==(input.distinct?input.n:1)||state.retained_count!==input.n)throw Error("Materialization diverged after actual Gmail persist");
      results.push({phase,sqliteVersion,wallMs,cpuMs:(used.user+used.system)/1000,rssBeforeBytes,rssAfterBytes:process.memoryUsage().rss,preparedStatements,changedEmailCount:result.changedEmailCount,labelAssociationRows:(sqlite.query("SELECT count(*) n FROM email_labels").get() as {n:number}).n});
    }
    console.log(JSON.stringify(results));
  }finally{sqlite.close();}
}else{
  const [candidate,output]=process.argv.slice(2);if(!candidate||!output)throw Error("Usage: importance-gmail-work.ts <candidate-commit> <new-output.json>");
  const old="2ebee41d73e3601610ef00dd39e5b81a60f486e2",head=git("rev-parse","--verify",candidate+"^{commit}");if(!/^[a-f0-9]{40}$/.test(head))throw Error("Full commit required");
  const syncPath="apps/api/src/providers/gmail/sync.ts";
  if(git("show",old+":"+syncPath)!==git("show",head+":"+syncPath)||git("diff",head,"--",syncPath))throw Error("Production Gmail sync differs between paired sources");
  const sources=[...new Set([old,head])].map(sha=>({sha,sql:git("ls-tree","-r","--name-only",sha,"apps/api/drizzle").split("\n").filter(p=>p.endsWith(".sql")).sort().map(path=>{const text=spawnSync("git",["-C",root,"show",sha+":"+path],{encoding:"utf8"});if(text.status!==0)throw Error(text.stderr);return{path,text:text.stdout,sha256:hash(text.stdout)};})}));
  const runs=[];
  for(const n of [100,200,400])for(const distinct of [false,true])for(let sample=1;sample<=3;sample++)for(const source of sample%2?sources:[...sources].reverse()){
    const child=spawnSync(process.execPath,[import.meta.path,"--worker"],{input:JSON.stringify({sql:source.sql,n,distinct}),encoding:"utf8",maxBuffer:1024*1024});if(child.status!==0)throw Error(child.stderr+child.stdout);
    runs.push({sha:source.sha,messages:n,distinct,sample,results:JSON.parse(child.stdout)});
  }
  writeFileSync(output,JSON.stringify({baseline:old,candidate:head,runtime:Bun.version,productionSyncSha256:hash(git("show",head+":"+syncPath)),scope:"Actual production persistGmailMessages + normalization, synthetic same-thread messages, changed normal-label sets force wholesale refresh; no network/provider; fresh Bun subprocess per paired sample",rss:"actual before/after process RSS bytes, not per-phase peak",sources:sources.map(s=>({sha:s.sha,sql:s.sql.map(({text,...metadata})=>metadata)})),runs},null,2)+"\n",{flag:"wx"});
  console.log(JSON.stringify({candidate:head,pairedSamples:runs.length,output}));
}
