import { expect, test } from 'bun:test';
import { ReaderSessions } from './reader-session';

test('reading sessions are bounded, account scoped, and explicitly clearable', () => {
  const cache = new ReaderSessions(2);
  const value = { open: ['m'], earlier: true, entry: 'm', unreadEntry: null, top: 400, anchor: null, offset: 0 };
  cache.set('a', 'same', value);
  expect(cache.get('b', 'same')).toBeNull();
  cache.set('b', 'same', value);
  cache.get('a', 'same');
  cache.set('a', 'third', value);
  expect(cache.get('b', 'same')).toBeNull();
  expect(cache.get('a', 'same')?.top).toBe(400);
  cache.clear();
  expect(cache.get('a', 'same')).toBeNull();
});

test('retained expansion metadata is bounded for extremely large threads', () => {
  const cache = new ReaderSessions();
  cache.set('a','thread',{open:Array.from({length:2000},(_,i)=>String(i)),earlier:true,entry:'1999',unreadEntry:null,top:0,anchor:null,offset:0});
  expect(cache.get('a','thread')?.open.length).toBe(1000);
});
