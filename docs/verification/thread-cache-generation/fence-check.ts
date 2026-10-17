import assert from 'node:assert/strict';
import {ThreadDetailCache} from './thread-detail-cache';
async function scenario(naivePrune:boolean){
 const cache=new ThreadDetailCache(30);
 const ref={accountId:'synthetic',threadId:'pending'};
 let resolve!:(v:any)=>void;
 const request=cache.load(ref,()=>new Promise(done=>{resolve=done}));
 const captured=cache.currentGeneration(ref);
 cache.invalidate(ref);
 assert.equal(cache.isCurrentGeneration(ref,captured),false);
 // Deliberately unsafe negative control, only in this disposable harness.
 if(naivePrune)(cache as any).generations.clear();
 resolve({thread:{id:'old-response'},messages:[]});
 await request;
 return {oldTokenAccepted:cache.isCurrentGeneration(ref,captured),oldPayloadCached:cache.peek(ref)!==null};
}
const baseline=await scenario(false),negativeControl=await scenario(true);
assert.deepEqual(baseline,{oldTokenAccepted:false,oldPayloadCached:false});
assert.deepEqual(negativeControl,{oldTokenAccepted:true,oldPayloadCached:true});
console.log(JSON.stringify({baseline,negativeControl,passed:true},null,2));
