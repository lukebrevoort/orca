import {expect,test} from 'bun:test';
import {withImagePermit} from './permits';
test('an aborted queued task never runs after another request releases its permit',async()=>{
 let release!:()=>void,entered=0;const hold=new Promise<void>(resolve=>{release=resolve;});
 const active=Array.from({length:4},()=>withImagePermit(new AbortController().signal,async()=>{entered++;await hold;}));
 await new Promise(resolve=>setTimeout(resolve,0));expect(entered).toBe(4);
 const controller=new AbortController();let late=false;
 const waiting=withImagePermit(controller.signal,async()=>{late=true;});controller.abort();
 await expect(waiting).rejects.toThrow();release();await Promise.all(active);expect(late).toBe(false);
 expect(await withImagePermit(new AbortController().signal,async()=>7)).toBe(7);
});
