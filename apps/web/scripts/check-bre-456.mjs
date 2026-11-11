/** Sequential workspace gates at one committed revision. Invoke this entire
 * command through /tmp/orca-ui-heavy-slot.py; never nest that wrapper. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {webSourceIdentity,webBundleIdentity} from './verification-revision.mjs';
const [directory]=process.argv.slice(2);
assert(directory,'New evidence directory required');
const output=resolve(directory);await mkdir(output);
const before=await webSourceIdentity();
assert.deepEqual(before.dirty,[],'Commit the candidate before final checks');
const result={revision:before,gates:[],complete:false};
try{
 for(const name of ['lint','typecheck','test','build']){
  const file=join(output,name+'.log'),log=createWriteStream(file);
  const executable=name==='build'?process.execPath:'/opt/homebrew/bin/bun';
  const args=name==='build'?['apps/web/scripts/build-bre-456.mjs']:['run','--sequential','--filter','*',name];
  console.log('Starting '+name+'; log '+file);
  const started=Date.now(),child=spawn(executable,args,{stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
  await new Promise(done=>log.end(done));
  result.gates.push({name,exitCode:code,elapsedMs:Date.now()-started,log:file});
  console.log(name+' exit '+code);
  assert.equal(code,0,name+' failed; retain its log and stop');
 }
 const after=await webSourceIdentity();
 assert.deepEqual(after,before,'Revision or source changed during the checks');
 result.bundle=await webBundleIdentity();result.complete=true;
}finally{await writeFile(join(output,'results.json'),JSON.stringify(result,null,2));}
