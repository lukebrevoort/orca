from pathlib import Path
import subprocess, os, json, time, hashlib, sys, signal
ROOT=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
HEAD='64b3308a2fb79a149f08f23a06f7578e85a35b3a'
OUT=Path('/tmp/bre457-reader-grammar-64b3308a')
os.chdir(ROOT)
git=lambda *a:subprocess.check_output(['git',*a],text=True).strip()
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
plan=json.loads(Path('docs/verification/bre-457/reader-native-switch-candidate/planned-grammar-inputs.json').read_text())
files=plan['sourceHashes'];assert len(files)==44
assert git('rev-parse','HEAD')==HEAD and not git('status','--porcelain')
assert {p:sha(p) for p in files}==files
OUT.mkdir(exist_ok=False)
proc=None;pending=None;phase='preparing';timed_out=False;started=time.monotonic();code=2
def stop(signum,frame):
 global pending
 if pending is None:pending=signum
 if phase=='waiting':raise SystemExit(128+pending)
for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,stop)
command=['/usr/bin/xcrun','swiftc','-frontend','-parse',*sorted(files)]
try:
 with (OUT/'grammar.log').open('wb') as log:
  phase='starting';proc=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);phase='waiting'
  if pending is not None:raise SystemExit(128+pending)
  try:code=proc.wait(timeout=3)
  except subprocess.TimeoutExpired:timed_out=True;code=124
except BaseException as error:
 code=error.code if isinstance(error,SystemExit) else 2
finally:
 phase='cleanup'
 if proc and proc.poll() is None:
  for sig,grace in ((signal.SIGTERM,.3),(signal.SIGKILL,.3)):
   if proc.poll() is not None:break
   try:os.killpg(proc.pid,sig)
   except ProcessLookupError:pass
   try:proc.wait(timeout=grace)
   except subprocess.TimeoutExpired:pass
 if pending is not None:code=128+pending
 ending={p:sha(p) for p in files}
 receipt={'startSHA':HEAD,'endSHA':git('rev-parse','HEAD'),'startStatus':'','endStatus':git('status','--porcelain'),'sourceCount':44,'sourceHashes':files,'endSourceHashes':ending,'exit':code,'timeout':timed_out,'signal':pending,'ownedParserPID':proc.pid if proc else None,'parserTerminal':proc.poll() is not None if proc else True,'elapsedSeconds':time.monotonic()-started,'command':command,'driverSHA256':sha(__file__),'scope':'Only Swift grammar; no UIKit types, XCTest/UI runtime, build,423Foundation or runner repeat.'}
 if ending!=files or receipt['endSHA']!=HEAD or receipt['endStatus'] or not receipt['parserTerminal']:code=1;receipt['exit']=code
 (OUT/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({k:v for k,v in receipt.items() if k not in ['sourceHashes','endSourceHashes','command']}))
sys.exit(code)
