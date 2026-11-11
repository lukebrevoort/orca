/** Record source and bundle identity so dirty-development evidence is never
 * presented as a passing committed revision or a stale bundle as current UI. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
async function sourceDigest(paths){
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard',...paths],{encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
 const digest=createHash('sha256');for(const path of files){digest.update(path+'\0');digest.update(await readFile(path));}
 return digest.digest('hex');
}
export async function webSourceIdentity(){
 return {head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha256:await sourceDigest(['apps/web/src','apps/web/public','apps/web/vite.config.ts','apps/web/package.json','bun.lock']),sharedSourceSha256:await sourceDigest(['packages/shared/src','packages/shared/package.json']),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)};
}
export async function webBundleIdentity(){
 const files=[];
 async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await visit(path);else if(entry.name!=='bre456-source.json')files.push(path);}}
 await visit('apps/web/dist');files.sort();const digest=createHash('sha256');
 for(const path of files){digest.update(path+'\0');digest.update(await readFile(path));}
 return {bundleSha256:digest.digest('hex'),bundleFiles:files.length};
}
