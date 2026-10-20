import {test,expect} from 'bun:test';
import {ThreadDetailCache} from './thread-detail-cache';
test('settled stale refreshes retain only the payload working set',async()=>{
 const cache=new ThreadDetailCache(3);
 for(let i=0;i<100;i++){
  const ref={accountId:'synthetic',threadId:`thread-${i}`};
  const loader=async()=>({thread:{id:ref.threadId},messages:[]}) as any;
  await cache.load(ref,loader);cache.markStale(ref);await cache.load(ref,loader);
 }
 expect((cache as any).generations.size).toBe(3);
});
