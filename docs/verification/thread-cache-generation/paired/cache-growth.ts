import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const mode=Bun.argv[2]; assert(['base','head'].includes(mode));
const {ThreadDetailCache}=await import(`./${mode}.ts`);
const cache=new ThreadDetailCache(30);
const internals=cache as any;
let loads=0;
const samples:any[]=[];
const cpuStart=process.cpuUsage(); const started=performance.now();
function snapshot(n:number){
 Bun.gc(true);
 samples.push({n,details:internals.details.size,generations:internals.generations.size,inFlight:internals.inFlight.size,
 generationKeyUtf8Bytes:[...internals.generations.keys()].reduce((n,k)=>n+Buffer.byteLength(k),0),
 heap:process.memoryUsage(),elapsedMs:performance.now()-started,cpu:process.cpuUsage(cpuStart)});
}
snapshot(0);
for(let i=0;i<10000;i++){
 const ref={accountId:'synthetic-account',threadId:`synthetic-thread-${i}`};
 const loader=async()=>{loads++;return {thread:{id:ref.threadId},messages:[{id:`message-${i}`,bodyText:`synthetic-${i}:`+'x'.repeat(1024)}]} as any;};
 await cache.load(ref,loader,{version:'v1'});
 cache.markStale(ref);
 const request=cache.load(ref,loader,{version:'v1',refresh:true});
 const token=mode==='base'?cache.currentGeneration(ref):cache.retainGeneration(ref);
 await request;
 assert(mode==='base'?cache.isCurrentGeneration(ref,token):token.isCurrent());
 if(mode==='head')token.release();
 assert.equal(cache.peek(ref)?.detail.thread.id,ref.threadId);
 if([100,1000,5000,10000].includes(i+1))snapshot(i+1);
}
assert.equal(loads,20000);assert.equal(internals.details.size,30);assert.equal(internals.inFlight.size,0);
assert.equal(internals.generations.size,mode==='base'?10000:30);
assert.equal(cache.peek({accountId:'synthetic-account',threadId:'synthetic-thread-0'}),null);
console.log(JSON.stringify({sourceMode:mode,runtime:Bun.version,mode,loads,samples,resources:process.resourceUsage(),cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8'),cpuStat:readFileSync('/sys/fs/cgroup/cpu.stat','utf8'),passed:true},null,2));
