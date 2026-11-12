DUMMY="import os,pathlib,time;pathlib.Path('/tmp/bre457-native-gate-interrupt-red-36ac/SIGTERM/stage-ready').write_text(str(os.getpid()));time.sleep(30)"
META=__import__("pathlib").Path('/tmp/bre457-native-gate-interrupt-red-36ac/SIGTERM/owned-stage.json')
GATE='/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b/apps/ios/Tools/ReviewRegressions/phase-b-gate.py'
EXPECTED='36ac2e844715ec202d4b20841866e35afc2788b1'
OUTPUT='/tmp/bre457-native-gate-interrupt-red-36ac/SIGTERM/gate-output'
import runpy,subprocess,sys,json,pathlib,os
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
