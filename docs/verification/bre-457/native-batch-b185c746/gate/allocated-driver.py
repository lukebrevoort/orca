from pathlib import Path
import subprocess,os,json,time,hashlib,signal,sys,shutil
ROOT=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b');HEAD='b185c7465648c62704b049f78db419de23a66599';OUT=Path('/tmp/bre457-native-b185-minimal-01')
os.chdir(ROOT)
git=lambda *a:subprocess.check_output(['git',*a],text=True).strip()
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
plan=json.loads(Path('/tmp/bre457-native-batch-b185c746.json').read_text());files=plan['plannedGrammarSourceHashes'];prep=json.loads(Path('/tmp/bre457-native-b185-geometry-prep.json').read_text())
assert len(files)==44 and git('rev-parse','HEAD')==HEAD and not git('status','--porcelain')
assert {p:sha(p) for p in files}==files and sha(prep['replay'])==prep['replaySHA256']
slot=Path('/tmp/orca-ui-heavy-slot.lock').stat();fds=[]
for e in Path('/dev/fd').iterdir():
 try:
  fd=int(e.name);v=os.fstat(fd)
  if fd>2 and (v.st_dev,v.st_ino)==(slot.st_dev,slot.st_ino):fds.append(fd)
 except (ValueError,OSError):pass
assert fds,'Inherited shared slot required'
OUT.mkdir(exist_ok=False);shutil.copyfile(prep['replay'],OUT/'main.swift');shutil.copyfile(__file__,OUT/'allocated-driver.py')
receipt={'head':HEAD,'driverSHA256':sha(__file__),'sourceHashes':files,'sourceReplay':prep,'stages':[],'scope':'44Swiftgrammar plus standaloneFoundation/CoreGraphics exactsource14assertion replay, NOTUIKit/XCTest/UI/423','cancellationInjectionTested':False}
current=None;owned={};groups=set();phase='idle';pending=None;started=time.monotonic();deadline=started+22

def save():(OUT/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
def rows():
 result={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,lstart=,command='],text=True).splitlines():
  p=line.split(None,8)
  if len(p)==9:result[int(p[0])]={'pid':int(p[0]),'ppid':int(p[1]),'pgid':int(p[2]),'birth':' '.join(p[3:8]),'commandHash':hashlib.sha256(p[8].encode()).hexdigest()}
 return result
def track():
 all=rows();known={p for p,v in owned.items() if all.get(p,{}).get('birth')==v['birth']}
 if current:known.add(current.pid)
 known.update(p for p,v in all.items() if v['pgid'] in groups)
 while True:
  more={p for p,v in all.items() if v['ppid'] in known}
  if more<=known:break
  known|=more
 for p in known:
  if p in all:owned[p]=all[p]
 return {p:v for p,v in all.items() if p in owned and v['birth']==owned[p]['birth'] and v['commandHash']==owned[p]['commandHash']}
def clean():
 global phase
 phase='cleanup'
 for sig,grace in [(signal.SIGTERM,.5),(signal.SIGKILL,.3)]:
  live=track()
  if not live:break
  for g in groups:
   if any(v['pgid']==g for v in live.values()):
    try:os.killpg(g,sig)
    except ProcessLookupError:pass
  for pid,v in live.items():
   if v['pgid'] not in groups:
    try:os.kill(pid,sig)
    except ProcessLookupError:pass
  until=time.monotonic()+grace
  while time.monotonic()<until and track():time.sleep(.03)
 if current:
  try:current.wait(timeout=.2)
  except subprocess.TimeoutExpired:pass
 return track()
def stop(sig,frame):
 global pending
 pending=pending or sig
 if phase=='waiting':raise SystemExit(128+pending)
for sig in [signal.SIGINT,signal.SIGTERM]:signal.signal(sig,stop)
stages=[('grammar',['/usr/bin/xcrun','swiftc','-frontend','-parse',*sorted(files)],3),('geometry-compile',['/usr/bin/xcrun','swiftc','-swift-version','5','apps/ios/OrcaUITests/ViewportGeometry.swift',str(OUT/'main.swift'),'-o',str(OUT/'geometry')],15),('geometry-replay',[str(OUT/'geometry')],2)]
code=0
try:
 for name,command,cap in stages:
  if pending:raise SystemExit(128+pending)
  if time.monotonic()>=deadline:code=124;break
  stage={'name':name,'command':command,'hardCapSeconds':cap};receipt['stages'].append(stage);save();began=time.monotonic()
  with (OUT/(name+'.log')).open('wb') as log:
   phase='starting';current=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,pass_fds=tuple(fds),env={**os.environ,'TMPDIR':'/private/tmp'});groups.add(current.pid);stage['ownedPGID']=current.pid;phase='waiting'
   if pending:raise SystemExit(128+pending)
   limit=min(deadline,began+cap)
   while current.poll() is None:
    track()
    if time.monotonic()>=limit:stage['timeout']=True;break
    time.sleep(.05)
   raw=124 if stage.get('timeout') else current.returncode
  remaining=clean();stage.update(rawExit=raw,elapsedSeconds=time.monotonic()-began,ownedRemaining=list(remaining.values()),logSHA256=sha(OUT/(name+'.log')));save();print(json.dumps(stage),flush=True)
  if remaining:code=2;break
  current=None;groups.clear()
  if raw:code=raw;break
  if name=='geometry-replay':assert 'originalAssertions=14 scenarioInventory=10 pass=14 fail=0 XCTestRuntime=false' in (OUT/(name+'.log')).read_text()
except BaseException as error:
 code=error.code if isinstance(error,SystemExit) and isinstance(error.code,int) else 2;receipt['exception']=repr(error)
finally:
 remaining=clean();receipt.update(endingHead=git('rev-parse','HEAD'),endingDirty=git('status','--porcelain'),endingSourceHashes={p:sha(p) for p in files},ownedProcesses=list(owned.values()),ownedRemaining=list(remaining.values()),elapsedSeconds=time.monotonic()-started)
 if pending:code=128+pending
 if remaining or receipt['endingHead']!=HEAD or receipt['endingDirty'] or receipt['endingSourceHashes']!=files:code=2
 receipt['finalExit']=code;receipt['notStarted']=[n for n,_,_ in stages if n not in [s['name'] for s in receipt['stages']]];save();print(json.dumps({k:receipt[k] for k in ['head','endingHead','endingDirty','ownedRemaining','elapsedSeconds','finalExit','notStarted']}),flush=True)
sys.exit(code)
