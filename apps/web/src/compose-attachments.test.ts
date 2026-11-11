import { expect, test } from 'bun:test';
import { acceptComposeFiles, serializeComposeAttachments } from './compose-workspace';
test('attachment identities preserve equal filenames and serialize the entire selected set',async()=>{
 const accepted=acceptComposeFiles([],Array.from({length:25},(_,index)=>new File([`file ${index}`],'same.txt',{type:'text/plain'}))).accepted;
 expect(accepted).toHaveLength(25);
 expect(new Set(accepted.map(file=>file.id)).size).toBe(25);
 const saved=await serializeComposeAttachments(accepted);
 expect(saved.map(file=>file.id)).toEqual(accepted.map(file=>file.id));
 expect(saved.map(file=>atob(file.contentBase64!))).toEqual(Array.from({length:25},(_,index)=>`file ${index}`));
 const remaining=accepted.filter((_,index)=>index!==0);
 expect((await serializeComposeAttachments(remaining)).map(file=>file.id)).toEqual(remaining.map(file=>file.id));
 expect(acceptComposeFiles(accepted,[new File(['more'],'same.txt')]).rejected).toHaveLength(1);
});
test('restored metadata retains identity and bytes without inventing unavailable content',async()=>{
 const restored={id:'persisted',filename:'same.txt',mimeType:'text/plain',size:3,file:null,previewUrl:null,contentBase64:btoa('old')};
 expect(await serializeComposeAttachments([restored])).toEqual([{id:'persisted',filename:'same.txt',mimeType:'text/plain',size:3,contentBase64:btoa('old')}]);
 expect((await serializeComposeAttachments([{...restored,contentBase64:null}]))[0]!.contentBase64).toBeNull();
 await expect(serializeComposeAttachments([restored,restored])).rejects.toThrow('identities');
});
