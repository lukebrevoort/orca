/** Record source and bundle identity so dirty-development evidence is never
 * presented as a passing committed revision or a stale bundle as current UI. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function webSourceIdentity(){
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','apps/web/src','apps/web/public','apps/web/vite.config.ts','apps/web/package.json','bun.lock'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
 const digest=createHash('sha256');for(const path of files){digest.update(path+'\0');digest.update(await readFile(path));}
 return {head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceSha256:digest.digest('hex'),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)};
}
