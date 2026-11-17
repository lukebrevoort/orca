from pathlib import Path
import subprocess,os,json,time,hashlib,sys,signal
expected='d485fae8138ce0ecdb49f5508c6ab360be7487c2'
sha=lambda:subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
status=lambda:subprocess.check_output(['git','status','--porcelain'],text=True)
start_sha=sha();start_status=status();assert start_sha==expected and not start_status
out=Path('/tmp/bre457-diagnostic-grammar-d485fae8');out.mkdir(exist_ok=False)
files=[p for d in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in sorted(Path(d).rglob('*.swift'))]
assert len(files)==36,len(files)
hashes={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
env=dict(os.environ,PATH='/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:'+os.environ['PATH'])
command=['/usr/bin/xcrun','swiftc','-frontend','-parse',*[str(p) for p in files]]
started=time.time();tick=time.monotonic();timed_out=False
with (out/'grammar.log').open('w') as log:
 proc=subprocess.Popen(command,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 try:code=proc.wait(timeout=5)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(proc.pid,signal.SIGTERM);proc.wait();code=124
end_sha=sha();end_status=status()
receipt={'startSHA':start_sha,'endSHA':end_sha,'startStatus':start_status,'endStatus':end_status,'sourceHashes':hashes,'endSourceHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'sourceCount':len(files),'startedEpoch':started,'endedEpoch':time.time(),'elapsedSeconds':time.monotonic()-tick,'exit':code,'timeout':timed_out,'command':command,'proof':'Swift grammar only; no SwiftUI/XCTest typecheck/runtime, controllers, runner repeat or Apple simulator','pinnedNode':subprocess.check_output(['node','--version'],env=env,text=True).strip(),'pinnedBun':subprocess.check_output(['/opt/homebrew/bin/bun','--version'],env=env,text=True).strip()}
(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({k:v for k,v in receipt.items() if k not in ['sourceHashes','endSourceHashes','command']}))
assert start_sha==end_sha and not end_status and receipt['sourceHashes']==receipt['endSourceHashes']
sys.exit(code)
