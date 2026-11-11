from pathlib import Path
import subprocess,os,time,json,signal,sys
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert head == 'f15310e69f509356c56a95b7b56d84f2e47ede4d'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
out=Path('/tmp/bre457-discard-candidate-'+head[:8]);out.mkdir(exist_ok=False)
started=time.monotonic();stages=[]
env=dict(os.environ,PATH='/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:'+os.environ['PATH'])
files=[str(p) for d in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in sorted(Path(d).rglob('*.swift'))]
commands=[('controllers-api',['python3','apps/ios/Tools/ReviewRegressions/run.py',str(out/'controllers'),'--api']),('swift-parse',['/usr/bin/xcrun','swiftc','-frontend','-parse',*files]),('runner-syntax',['zsh','-n','apps/ios/OrcaUITests/run-fixture-tests.sh']),('runner-lifecycle',['python3','apps/ios/Tools/ReviewRegressions/runner-lifecycle.py'])]
for name,cmd in commands:
 remaining=50-(time.monotonic()-started)
 if remaining<=0:stages.append({'stage':name,'notStarted':'50s exhausted'});break
 with (out/(name+'.log')).open('w') as log:
  proc=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=proc.wait(timeout=remaining)
  except subprocess.TimeoutExpired:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=2)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
   stages.append({'stage':name,'timeout':True});break
 stages.append({'stage':name,'exit':code,'elapsed':time.monotonic()-started})
 if code != 0: break
receipt={'sha':head,'scope':'production Foundation/API/controller and synthetic runner lifecycle; grammar only for Apple UI, not SwiftUI runtime','expectedControllerCases':223,'overallCapSeconds':50,'swiftParseCount':len(files),'runtimes':{'node':subprocess.check_output(['node','--version'],env=env,text=True).strip(),'bun':subprocess.check_output(['/opt/homebrew/bin/bun','--version'],env=env,text=True).strip()},'elapsed':time.monotonic()-started,'stages':stages}
(out/'execution.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt));sys.exit(0 if len(stages)==4 and all(s.get('exit')==0 for s in stages) else 1)
