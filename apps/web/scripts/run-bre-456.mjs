/** One owned loopback fixture/browser run. Invoke through the shared heavy slot. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { webSourceIdentity, webBundleIdentity } from './verification-revision.mjs';
const [script, output, ...args] = process.argv.slice(2);
if (!script || !output) throw new Error('script and new evidence directory required');
const identity=await webSourceIdentity();
const built=JSON.parse(await readFile('apps/web/dist/bre456-source.json','utf8'));
assert.equal(built.sourceSha256,identity.sourceSha256,'Web bundle is stale. Run build-bre-456.mjs through the heavy slot first.');
assert.equal(built.sharedSourceSha256,identity.sharedSourceSha256,'Shared source changed since build. Rebuild first.');
assert.equal(built.bundleSha256,(await webBundleIdentity()).bundleSha256,'Built asset bytes changed since the recorded build. Rebuild first.');
const fixture = spawn('/opt/homebrew/bin/bun', [process.env.ORCA_FIXTURE_SCRIPT ?? 'apps/api/scripts/compose-fixture.ts'], {stdio:['ignore','pipe','inherit']});
let connection = '', buffer = '';
try {
  await new Promise((done, reject) => {
    fixture.once('exit', code => reject(new Error(`Fixture exited ${code}`)));
    fixture.stdout.on('data', data => { buffer += data; const line = buffer.split('\n').find(x=>x.endsWith('/connection.json')); if(line) {connection=line.trim(); done();} });
  });
  const browser = spawn(process.execPath, [resolve(script), connection, resolve(output), ...args], {stdio:'inherit',env:{...process.env,ORCA_CHROMIUM_EXECUTABLE:process.env.ORCA_CHROMIUM_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}});
  const [code] = await once(browser,'exit'); process.exitCode=code??1;
} finally { fixture.kill('SIGTERM'); await once(fixture,'exit').catch(()=>{}); }
