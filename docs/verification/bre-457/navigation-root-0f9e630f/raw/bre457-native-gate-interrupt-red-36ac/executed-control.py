"""Execute the real gate with only its compiler/API stage replaced by an owned sleeper.
The coordinator keeps the heavy lock until every recorded control process is terminal.
No Swift, Node, API server, browser or provider work is launched.
"""
import hashlib,json,os,pathlib,signal,subprocess,sys,time
repo=pathlib.Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
expected,folder=sys.argv[1:3];out=pathlib.Path(folder);assert not out.exists();out.mkdir()
gate=repo/'apps/ios/Tools/ReviewRegressions/phase-b-gate.py'
def git(*args):return subprocess.check_output(['git',*args],cwd=repo,text=True).strip()
assert git('rev-parse','HEAD')==expected and not git('status','--porcelain')
before=hashlib.sha256(gate.read_bytes()).hexdigest();cases=[]
def running(pid):
 p=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
 return bool(p.stdout.strip()) and not p.stdout.strip().startswith('Z')
for name in ['SIGTERM','SIGINT']:
 case=out/name;case.mkdir();meta=case/'owned-stage.json';ready=case/'stage-ready';driver=None;owned=None
 dummy="import os,pathlib,time;pathlib.Path("+repr(str(ready))+").write_text(str(os.getpid()));time.sleep(30)"
 header='''import runpy,subprocess,sys,json,pathlib,os
real=subprocess.Popen
def observed(command,*args,**kwargs):
 if list(command)[:2]==['python3','apps/ios/Tools/ReviewRegressions/run.py']:
  actual=[sys.executable,'-c',DUMMY]
  p=real(actual,*args,**kwargs)
  META.write_text(json.dumps({'pid':p.pid,'pgid':os.getpgid(p.pid),'requested':command,'executed':actual}))
  return p
 if list(command)[:3]==['/usr/bin/xcrun','swiftc','-frontend']:
  raise RuntimeError('Unexpected grammar launch: interruption control never runs Swift')
 return real(command,*args,**kwargs)
subprocess.Popen=observed
sys.argv=[GATE,EXPECTED,OUTPUT]
runpy.run_path(GATE,run_name='__main__')
'''
 harness=case/'harness.py';harness.write_text('DUMMY='+repr(dummy)+'\nMETA=__import__("pathlib").Path('+repr(str(meta))+')\nGATE='+repr(str(gate))+'\nEXPECTED='+repr(expected)+'\nOUTPUT='+repr(str(case/'gate-output'))+'\n'+header)
 record={'signal':name,'sourceHead':expected,'controllerStageSubstituted':True,'applicationWorkExecuted':False}
 try:
  with (case/'driver.log').open('w') as log:
   driver=subprocess.Popen([sys.executable,str(harness)],cwd=repo,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=False)
   deadline=time.monotonic()+3
   while time.monotonic()<deadline and not (meta.exists() and ready.exists()):
    if driver.poll() is not None:break
    time.sleep(.01)
   assert meta.exists() and ready.exists(),'Control stage did not start; no interruption finding established'
   owned=json.loads(meta.read_text());assert owned['pid']==int(ready.read_text()) and owned['pid']==owned['pgid'] and running(owned['pid'])
   record['ownedStage']=owned;record['driverPid']=driver.pid
   os.kill(driver.pid,getattr(signal,name))
   try:record['driverExit']=driver.wait(timeout=4)
   except subprocess.TimeoutExpired:record['driverWaitTimedOut']=True
   record['stageSurvivedDriver']=running(owned['pid'])
   manifest=case/'gate-output/manifest.json'
   record['actualGateManifest']=json.loads(manifest.read_text()) if manifest.exists() else None
 finally:
  if owned and running(owned['pid']):
   command=subprocess.check_output(['ps','-p',str(owned['pid']),'-o','command='],text=True)
   assert str(ready) in command and os.getpgid(owned['pid'])==owned['pgid'],'Recorded stage identity changed; do not signal it'
   os.killpg(owned['pgid'],signal.SIGTERM)
   deadline=time.monotonic()+1
   while running(owned['pid']) and time.monotonic()<deadline:time.sleep(.01)
   if running(owned['pid']):os.killpg(owned['pgid'],signal.SIGKILL)
  if driver and driver.poll() is None:os.killpg(driver.pid,signal.SIGKILL);driver.wait(timeout=1)
  record['ownedStageTerminalAfterCleanup']=not owned or not running(owned['pid']);cases.append(record)
after=hashlib.sha256(gate.read_bytes()).hexdigest();assert before==after and git('rev-parse','HEAD')==expected and not git('status','--porcelain')
passed=all(not c.get('stageSurvivedDriver') and c.get('driverExit') not in [None,0] and c.get('actualGateManifest',{}).get('exit',0)!=0 and c['ownedStageTerminalAfterCleanup'] for c in cases)
result={'scope':'Actual gate entrypoint with first controller process replaced; control coordinator retained lock through cleanup, so no real overlapping heavy work was permitted','head':expected,'sourceSha256':before,'sourceStable':before==after,'cases':cases,'pass':passed,'exit':0 if passed else 1}
(out/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'head':expected,'signals':[{'name':c['signal'],'driverExit':c.get('driverExit'),'stageSurvived':c.get('stageSurvivedDriver'),'manifestPresent':c.get('actualGateManifest') is not None,'cleanupTerminal':c['ownedStageTerminalAfterCleanup']} for c in cases],'exit':result['exit']}),flush=True)
raise SystemExit(result['exit'])
