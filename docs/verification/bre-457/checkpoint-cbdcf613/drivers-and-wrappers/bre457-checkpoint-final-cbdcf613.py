from pathlib import Path
import ast,hashlib,json,os,resource,signal,subprocess,sys,time
root=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
expected='cbdcf6132c765f4e59aafcdb98c008437ba4871f'
out=Path('/tmp/bre457-checkpoint-final-cbdcf613');out.mkdir(exist_ok=False)
sha=lambda:subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
status=lambda:subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)
paths=['scripts/ci/test-evidence-checkpoint.py','scripts/ci/export-evidence.py','scripts/ci/fixture-check.sh','apps/ios/OrcaUITests/run-fixture-tests.sh','.github/workflows/native-mailbox.yml','scripts/ci/test-export-evidence.py','scripts/ci/test-ios-mailbox-phases.py','apps/ios/Tools/ReviewRegressions/runner-lifecycle.py']
hashes=lambda:{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
assert sha()==expected and not status()
receipt={'scope':'Seven synthetic checkpoint/kill/cleanup/status/privacy/browser-layout controls ONLY. Existing25export tests exactfc3, phase2/lifecycle4/shellsyntax exactee retained separately; no Apple/native product execution','startSHA':sha(),'sourceHashes':hashes(),'stages':[],'exit':2}
env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1', GITHUB_ACTIONS='false', RUNNER_ENVIRONMENT='synthetic-local')
start=time.monotonic();cap=10
source=(root/'apps/ios/Tools/ReviewRegressions/phase-b-gate.py').read_text();tree=ast.parse(source)
owned='\n'.join(ast.get_source_segment(source,n) for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ['GateInterrupted','run'])
(out/'owned-stage-runner.py').write_text(owned);exec(compile(owned,'owned-stage-runner.py','exec'))
stages=[('checkpoint-controls',[sys.executable,'-B','scripts/ci/test-evidence-checkpoint.py'],8)]
try:
 for name,command,timeout in stages:
  code=run(name,command,timeout)
  if code:receipt['exit']=code;break
 else:receipt['exit']=0
except BaseException as e:receipt['exit']=128+e.signum if isinstance(e,GateInterrupted) else 2;receipt['failure']=repr(e)
finally:
 receipt.update(endSHA=sha(),endStatus=status(),endingSourceHashes=hashes(),elapsedSeconds=time.monotonic()-start)
 receipt['identityUnchanged']=receipt['endSHA']==expected and not receipt['endStatus'] and receipt['sourceHashes']==receipt['endingSourceHashes']
 receipt['notStarted']=[n for n,_,_ in stages if n not in [s['stage'] for s in receipt['stages']]]
 if not receipt['identityUnchanged'] or any(s.get('cleanupFailure') for s in receipt['stages']):receipt['exit']=2
 (out/'driver.py').write_bytes(Path(__file__).read_bytes());(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'head':expected,'exit':receipt['exit'],'elapsed':receipt['elapsedSeconds'],'identity':receipt['identityUnchanged'],'notStarted':receipt['notStarted']}));sys.exit(receipt['exit'])
