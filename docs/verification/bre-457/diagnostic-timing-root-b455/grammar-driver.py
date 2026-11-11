from pathlib import Path
import json, subprocess, hashlib, time
root=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
out=Path('/tmp/bre457-root-timing-grammar-b455ae18');out.mkdir(exist_ok=False)
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
status=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)
assert sha.startswith('b455ae18') and not status.strip()
original=json.load(open('/tmp/bre457-diagnostic-grammar-d485fae8/manifest.json'))
command=original['command'];paths=command[4:]
assert len(paths)==36
before={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
start=time.monotonic();r=subprocess.run(command,cwd=root,capture_output=True,text=True,timeout=5)
(out/'grammar.log').write_text(r.stdout+r.stderr)
after={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
end=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
endstatus=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)
receipt={'startSHA':sha,'endSHA':end,'startStatus':status,'endStatus':endstatus,'command':command,'sourceCount':36,'sourceHashes':before,'endSourceHashes':after,'exit':r.returncode,'elapsed':time.monotonic()-start,'scope':'grammar only; no Apple UI typecheck/runtime, no223case or4runnerrepeat'}
(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
assert r.returncode==0 and before==after and sha==end and not endstatus.strip()
print(json.dumps({k:receipt[k] for k in ['startSHA','endSHA','sourceCount','exit','elapsed','scope']}))
