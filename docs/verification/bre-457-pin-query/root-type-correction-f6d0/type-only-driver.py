from pathlib import Path
import importlib.util, json, subprocess, sys, hashlib, time
sys.dont_write_bytecode=True
root=Path('/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829')
out=Path('/tmp/bre457-root-actual-types-f6d0e168');out.mkdir(exist_ok=False)
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert sha=='f6d0e168fe89b86af99ba06ea5ff55bf8eed2241'
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
spec=importlib.util.spec_from_file_location('candidate_gate',root/'docs/verification/bre-457-pin-query/run-candidate.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
old=Path('/private/tmp/bre457-pin-query-candidate-869ce35f-01/api-types.log')
usage=old.read_text();assert usage.startswith('Usage: bun run')
guarded=gate.checked_type_exit(0,usage);assert guarded==2
assert gate.checked_type_exit(2,'real compiler error')==2
assert gate.checked_type_exit(0,'')==0
negative={'legacyReportedExit':0,'exactLegacyOutputSha256':hashlib.sha256(old.read_bytes()).hexdigest(),'newGuardExit':guarded,'interpretation':'retained actual usage-only0 rejected; not a compiler execution','realCompilerFailurePreserved':True}
(out/'usage-only-regression.json').write_text(json.dumps(negative,indent=2)+'\n')
started=time.monotonic()
r=subprocess.run(['python3',str(root/'docs/verification/bre-457-pin-query/run-candidate.py'),str(out/'actual-types'),sha,'--types-only'],cwd=root,timeout=170)
end=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
status=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
receipt={'startSHA':sha,'endSHA':end,'status':status,'exit':r.returncode,'elapsed':time.monotonic()-started,'scope':'actual direct pinnedNode/TypeScript shared+API types only; focused78/demo remain at source-identical869','usageOnlyRegression':negative}
(out/'root-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
assert end==sha and not status
print(json.dumps(receipt));sys.exit(r.returncode)
