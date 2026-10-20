import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ThreadDetailCache} from './thread-detail-cache';
const mode=Bun.argv[2]; assert(['control','stale'].includes(mode));
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
 if(mode==='stale')cache.markStale(ref);
 await cache.load(ref,loader,{version:'v1',refresh:true});
 assert.equal(cache.peek(ref)?.detail.thread.id,ref.threadId);
 if([100,1000,5000,10000].includes(i+1))snapshot(i+1);
}
assert.equal(loads,20000);assert.equal(internals.details.size,30);assert.equal(internals.inFlight.size,0);
assert.equal(internals.generations.size,mode==='stale'?10000:0);
assert.equal(cache.peek({accountId:'synthetic-account',threadId:'synthetic-thread-0'}),null);
console.log(JSON.stringify({revision:'5baf7f3ea9e208001c607a7bc0f5c418fb056d58',runtime:Bun.version,mode,loads,samples,resources:process.resourceUsage(),cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8'),cpuStat:readFileSync('/sys/fs/cgroup/cpu.stat','utf8'),passed:true},null,2));
