import hashlib,json,os,re,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
HEAD='1be7086f6525b57b251e0afe0921869fc3566a90'
OUT=Path('/tmp/bre457-mailbox-shard-1be7086f-01')
os.chdir(ROOT)
def git(*args):return subprocess.check_output(['git',*args],text=True).strip()
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def inventory():return {p:sha(p) for p in git('ls-files').splitlines()}
assert git('rev-parse','HEAD')==HEAD and not git('status','--porcelain')
assert not OUT.exists()
identity=json.loads(Path('/tmp/bre457-mailbox-shard-candidate-1be7086f.json').read_text())
for key in ['sourceHashes','Swift44HashesPreserved']:
 for p,v in identity[key].items():assert sha(p)==v,p
before=inventory();OUT.mkdir();started=time.monotonic();deadline=started+34;current=None;owned={};groups=set();phase='idle';pending_signal=None
slot=Path('/tmp/orca-ui-heavy-slot.lock').stat();fds=[]
for entry in Path('/dev/fd').iterdir():
 try:
  fd=int(entry.name);s=os.fstat(fd)
  if fd>2 and (s.st_dev,s.st_ino)==(slot.st_dev,slot.st_ino):fds.append(fd)
 except (ValueError,OSError):pass
assert fds
receipt={'head':HEAD,'driverSHA256':sha(__file__),'startedAt':time.time(),'python':sys.version,'inputsBefore':before,'stages':[],'status':'RUNNING','scope':'Actual CI shell/exporter code with synthetic tools; no Xcode, simulator, UIKit, API or browser execution. No cancellation injection.'}
def save():(OUT/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
def processes():
 rows={}
 for line in subprocess.check_output(['ps','-axo','pid=,ppid=,pgid=,lstart=,command='],text=True).splitlines():
  p=line.split(None,8)
  if len(p)==9:rows[int(p[0])]={'pid':int(p[0]),'ppid':int(p[1]),'pgid':int(p[2]),'birth':' '.join(p[3:8]),'commandHash':hashlib.sha256(p[8].encode()).hexdigest()}
 return rows
def track():
 rows=processes();known={p for p,v in owned.items() if rows.get(p,{}).get('birth')==v['birth']}
 if current:known.add(current.pid)
 known.update(p for p,r in rows.items() if r['pgid'] in groups)
 while True:
  more={p for p,r in rows.items() if r['ppid'] in known}
  if more<=known:break
  known|=more
 for p in known:
  if p in rows:owned[p]=rows[p]
 return {p:r for p,r in rows.items() if p in owned and r['birth']==owned[p]['birth'] and r['commandHash']==owned[p]['commandHash']}
def cleanup():
 global phase
 phase='cleanup'
 for sig,grace in [(signal.SIGTERM,1.5),(signal.SIGKILL,.3)]:
  live=track()
  if not live:break
  for g in groups:
   if any(r['pgid']==g for r in live.values()):
    try:os.killpg(g,sig)
    except ProcessLookupError:pass
  for pid,r in live.items():
   if r['pgid'] not in groups:
    try:os.kill(pid,sig)
    except ProcessLookupError:pass
  until=time.monotonic()+grace
  while time.monotonic()<until and track():time.sleep(.03)
 if current:
  try:current.wait(timeout=.2)
  except subprocess.TimeoutExpired:pass
 return track()
def stop(signum,frame):
 global pending_signal,phase
 if pending_signal is None:pending_signal=signum;receipt['interruptedSignal']=signum
 if phase=='waiting':phase='cleanup';raise SystemExit(128+pending_signal)
for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,stop)
stages=[('phase-tests',[sys.executable,'scripts/ci/test-ios-mailbox-phases.py','-v'],5),('shard-tests',[sys.executable,'scripts/ci/test-ios-mailbox-shards.py','-v'],6),('checkpoint-tests',[sys.executable,'scripts/ci/test-evidence-checkpoint.py','-v'],11),('sanitizer-tests',[sys.executable,'scripts/ci/test-export-evidence.py','-v'],25),('runner-lifecycle',[sys.executable,'apps/ios/Tools/ReviewRegressions/runner-lifecycle.py'],None),('bash-syntax',['bash','-n','scripts/ci/fixture-check.sh'],None),('zsh-syntax',['zsh','-n','apps/ios/OrcaUITests/run-fixture-tests.sh'],None)]
code=0
try:
 for name,command,count in stages:
  if pending_signal is not None:raise SystemExit(128+pending_signal)
  if time.monotonic()>=deadline:code=124;break
  stage={'name':name,'command':command};receipt['stages'].append(stage);save();print(json.dumps({'stage':name,'state':'STARTING'}),flush=True);began=time.monotonic()
  env=dict(os.environ);env.pop('ORCA_UI_TEST_APPEARANCE',None);env.pop('ORCA_CI_UI_TEST_APPEARANCE',None);env['PYTHONDONTWRITEBYTECODE']='1'
  with (OUT/(name+'.log')).open('wb') as log:
   phase='starting';current=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,pass_fds=tuple(fds),env=env);groups.add(current.pid);phase='waiting';stage['ownedPGID']=current.pid
   if pending_signal is not None:phase='cleanup';raise SystemExit(128+pending_signal)
   while current.poll() is None:
    track()
    if time.monotonic()>=deadline:stage['interrupted']=True;cleanup();break
    time.sleep(min(.15,max(.001,deadline-time.monotonic())))
   raw=124 if stage.get('interrupted') else current.returncode
  remaining=cleanup();stage.update(rawExit=raw,elapsedSeconds=time.monotonic()-began,ownedRemaining=list(remaining.values()),logSHA256=sha(OUT/(name+'.log')))
  if not remaining:groups.clear()
  current=None
  if pending_signal is not None:raise SystemExit(128+pending_signal)
  assert not remaining,'Owned stage process remains'
  if raw:code=raw;break
  text=(OUT/(name+'.log')).read_text()
  if count is not None:
   counts=re.findall(r'^Ran (\d+) tests? in ',text,re.M);assert counts==[str(count)],(name,counts)
   assert re.search(r'^OK$',text,re.M) and not re.search(r'\bskipped=|\(skipped\b',text),name
   stage['actualUnittestMethods']=count
  if name=='runner-lifecycle':
   actual=json.loads(text);assert [x['scope'] for x in actual['results']]==['all','notifications','mailbox','compose'] and all(x['pass'] is True and x['exit']==0 for x in actual['results']);stage['actualSyntheticScopes']=4
  print(json.dumps({'stage':name,'rawExit':raw,'seconds':stage['elapsedSeconds']}),flush=True);save()
 else:receipt['status']='SCOPED_SYNTHETIC_PASS'
except BaseException as e:
 code=e.code if isinstance(e,SystemExit) and isinstance(e.code,int) else 2;receipt['exception']=repr(e)
finally:
 remaining=cleanup();receipt.update(ownedRemaining=list(remaining.values()),ownedProcessesObserved=list(owned.values()),inputsAfter=inventory(),endHead=git('rev-parse','HEAD'),endingDirty=git('status','--porcelain'),elapsedSeconds=time.monotonic()-started)
 if pending_signal is not None:code=128+pending_signal
 if remaining or receipt['inputsAfter']!=before or receipt['endHead']!=HEAD or receipt['endingDirty']:code=2
 receipt['rawFinalExit']=code;receipt['notStarted']=[n for n,_,_ in stages if n not in [x['name'] for x in receipt['stages']]]
 if code:receipt['status']='NONPASS_RAW_RETAINED'
 save();print(json.dumps({k:receipt[k] for k in ['status','rawFinalExit','elapsedSeconds','endHead','endingDirty','ownedRemaining','notStarted']}),flush=True)
raise SystemExit(code)
