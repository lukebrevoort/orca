"""ROOT source/inherited-slot/owned-process guard. No runtime until allocated."""
import hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829')
HEAD='2b7cf3b76e0cc03d72f2d03cb7c75c501c9b4cea'
BASE='7c97193688599e5996bb657c34227a63927c384c'
OUT=Path('/tmp/bre457-query-importance-root-2b7cf3b7-02')
INNER=Path('docs/verification/bre-457-query-importance/run-baseline.py')
EXPECTED_DRIVER='b6078a7658c1d8e65650fc33bb3758d84842eb246e9a8db0e02de5e4b4541a90'
os.chdir(ROOT)
def git(*args):return subprocess.check_output(['git',*args],text=True,timeout=5).strip()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert git('rev-parse','HEAD')==HEAD and not git('status','--porcelain')
assert sha(INNER)==EXPECTED_DRIVER
assert not any((d/n).exists() for d in [ROOT,ROOT/'apps/api'] for n in ['.env','.env.local','.env.test','.env.test.local']),'No implicit env-file loading'
inv=json.loads(Path('docs/verification/bre-457-query-importance/source-inventory.json').read_text())
assert inv['entryCount']==798
# Exact base object identity and actual working-file bytes; extra test/docs
# inputs are included separately in the full starting/ending inventory.
baseEntries=set(git('ls-tree','-r',BASE).splitlines())
headEntries=set(git('ls-tree','-r',HEAD).splitlines())
assert all(entry in baseEntries and entry in headEntries for entry in inv['entries'])
paths=sorted(git('ls-files').splitlines())
before={p:sha(p) for p in paths}
slot=Path('/tmp/orca-ui-heavy-slot.lock').stat();fds=[]
for entry in Path('/dev/fd').iterdir():
 try:
  fd=int(entry.name);s=os.fstat(fd)
  if fd>2 and (s.st_dev,s.st_ino)==(slot.st_dev,slot.st_ino):fds.append(fd)
 except (ValueError,OSError):pass
assert fds,'Shared wrapper inherited lock required'
assert not OUT.exists();OUT.mkdir()
receipt={'head':HEAD,'base':BASE,'guardSHA256':sha(__file__),'innerDriverSHA256':sha(INNER),'beforeFileSHA256':before,'stages':[],'startedAt':time.time(),'cancellationInjectionTested':False}
def save():(OUT/'root-guard.json').write_text(json.dumps(receipt,indent=2)+'\n')
def processes():
 out={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,lstart=,command='],text=True).splitlines():
  p=line.split(None,8)
  if len(p)==9:out[int(p[0])]={'pid':int(p[0]),'ppid':int(p[1]),'pgid':int(p[2]),'birth':' '.join(p[3:8]),'commandSHA256':hashlib.sha256(p[8].encode()).hexdigest()}
 return out
child=None;owned={};groups=set();phase='idle';pending=None;deadline=time.monotonic()+130
def track():
 rows=processes();known={p for p,r in owned.items() if rows.get(p,{}).get('birth')==r['birth']}
 groups.intersection_update({rows[p]['pgid'] for p in known})
 if child:known.add(child.pid)
 known.update(p for p,r in rows.items() if r['pgid'] in groups)
 while True:
  more={p for p,r in rows.items() if r['ppid'] in known}
  if more<=known:break
  known|=more
 for p in known:
  if p in rows:owned[p]=rows[p];groups.add(rows[p]['pgid'])
 return {p:r for p,r in rows.items() if p in owned and r['birth']==owned[p]['birth'] and r['commandSHA256']==owned[p]['commandSHA256']}
def cleanup():
 global phase
 phase='cleanup'
 for sig,grace in [(signal.SIGTERM,2),(signal.SIGKILL,.5)]:
  live=track()
  if not live:break
  # Never infer exit of descendants from a terminal coordinator.
  for g in groups:
   if g==os.getpgrp():continue
   if any(r['pgid']==g for r in live.values()):
    try:os.killpg(g,sig)
    except ProcessLookupError:pass
  until=time.monotonic()+grace
  while time.monotonic()<until and track():time.sleep(.05)
 if child:
  try:child.wait(timeout=.3)
  except subprocess.TimeoutExpired:pass
 return track()
def stop(sig,frame):
 global pending,phase
 if pending is None:pending=sig
 if phase=='waiting':phase='cleanup';raise SystemExit(128+pending)
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,stop)
code=2
try:
 save()
 commands=[('frozen-install',['/opt/homebrew/bin/bun','install','--frozen-lockfile'],30),('baseline',['python3',str(INNER),'--head',HEAD,str(OUT/'baseline')],95)]
 for name,command,cap in commands:
  stage={'name':name,'command':command,'capSeconds':cap,'startedAt':time.time()};receipt['stages'].append(stage);save();began=time.monotonic();stageDeadline=min(deadline,began+cap)
  with (OUT/(name+'-stdout.log')).open('wb') as log:
   phase='starting';child=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,pass_fds=tuple(fds));groups.add(child.pid);stage['ownedPGID']=child.pid;phase='waiting'
   if pending is not None:phase='cleanup';raise SystemExit(128+pending)
   print(json.dumps({'state':'STARTING','stage':name,'pid':child.pid,'head':HEAD,'hardCapSeconds':cap}),flush=True)
   while child.poll() is None:
    track()
    if time.monotonic()>=stageDeadline:stage['timeout']=True;cleanup();break
    time.sleep(.2)
   raw=124 if stage.get('timeout') else child.returncode
  stage.update(rawExit=raw,elapsedSeconds=time.monotonic()-began,ownedRemaining=list(cleanup().values()));save()
  print(json.dumps({'state':'STAGE_TERMINAL','stage':name,'rawExit':raw,'elapsedSeconds':stage['elapsedSeconds']}),flush=True)
  code=raw
  if raw or stage['ownedRemaining']:break
  assert git('rev-parse','HEAD')==HEAD and not git('status','--porcelain')
  child=None
 receipt['rawDriverExit']=code
except BaseException as error:
 code=error.code if isinstance(error,SystemExit) and isinstance(error.code,int) else 2;receipt['exception']=repr(error)
finally:
 remaining=cleanup()
 if pending is not None:code=128+pending
 receipt.update(endingHead=git('rev-parse','HEAD'),endingStatus=git('status','--porcelain'),endingFileSHA256={p:sha(p) for p in paths},ownedProcesses=list(owned.values()),ownedRemaining=list(remaining.values()),endingAt=time.time())
 if receipt['endingHead']!=HEAD or receipt['endingStatus'] or receipt['endingFileSHA256']!=before or git('ls-files').splitlines()!=paths or remaining:
  receipt['identityOrCleanupFailure']=True;code=2
 receipt['finalExit']=code;save()
 print(json.dumps({'state':'TERMINAL','exit':code,'head':receipt['endingHead'],'dirty':receipt['endingStatus'],'ownedRemaining':receipt['ownedRemaining'],'out':str(OUT)}),flush=True)
sys.exit(code)
