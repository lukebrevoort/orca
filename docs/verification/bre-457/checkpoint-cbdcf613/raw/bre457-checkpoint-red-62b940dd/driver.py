from pathlib import Path
import ast,hashlib,json,os,resource,signal,subprocess,sys,time
root=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b')
expected='62b940ddafb9147b5d891e913d70d4cc7b7ea2d1'
out=Path('/tmp/bre457-checkpoint-red-62b940dd');out.mkdir(exist_ok=False)
sha=lambda:subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
status=lambda:subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True)
files=[p for folder in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in sorted((root/folder).rglob('*.swift'))]
assert len(files)==44 and sha()==expected and not status()
hashes=lambda:{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
receipt={'scope':'One actual runner-phase outer-kill evidence control; fake Apple commands ONLY, no local Apple/native product proof','startSHA':sha(),'sourceHashes':hashes(),'stages':[],'exit':2}
env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1');start=time.monotonic();cap=15
source=(root/'apps/ios/Tools/ReviewRegressions/phase-b-gate.py').read_text();tree=ast.parse(source)
owned='\n'.join(ast.get_source_segment(source,n) for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in ['GateInterrupted','run'])
(out/'owned-stage-runner.py').write_text(owned)
exec(compile(owned,'owned-stage-runner.py','exec'))
try:receipt['exit']=run('checkpoint-red',[sys.executable,'-B','scripts/ci/test-evidence-checkpoint.py','CheckpointTests.test_outer_kill_during_dark_keeps_light_checkpoint'],12)
except BaseException as e:receipt['exit']=128+e.signum if isinstance(e,GateInterrupted) else 2;receipt['failure']=repr(e)
finally:
 receipt.update(endSHA=sha(),endStatus=status(),endingSourceHashes=hashes(),elapsedSeconds=time.monotonic()-start)
 receipt['identityUnchanged']=receipt['endSHA']==expected and not receipt['endStatus'] and receipt['sourceHashes']==receipt['endingSourceHashes']
 if not receipt['identityUnchanged'] or any(s.get('cleanupFailure') for s in receipt['stages']):receipt['exit']=2
 (out/'driver.py').write_bytes(Path(__file__).read_bytes());(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'head':expected,'count':len(files),'exit':receipt['exit'],'elapsed':receipt['elapsedSeconds'],'identity':receipt['identityUnchanged']}));sys.exit(receipt['exit'])
