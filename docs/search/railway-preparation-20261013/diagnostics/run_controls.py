import json,subprocess,time,os
from pathlib import Path
out=Path('/workspace/pr235-evidence/oct13/diagnosis')
assert not (out/'controls.json').exists()
# Predetermined sequence; no conditional retries or threshold changes.
runs=[('reverse-candidate','head','head','fdc78bce2d4e3169f870aaaffd62da20d9f46f30'),('reverse-main','base','base','0e6805131a9c8386107bf70f598e2b61b0cf6a0b'),('same-candidate-1','head','base','fdc78bce2d4e3169f870aaaffd62da20d9f46f30'),('same-candidate-2','head','base','fdc78bce2d4e3169f870aaaffd62da20d9f46f30')]
manifest={'purpose':'Fixed bounded diagnostic controls, not acceptance reruns','runs':[],'maxTotalSeconds':420,'maxChildSeconds':95}
start=time.monotonic()
for name,root,mode,revision in runs:
 assert time.monotonic()-start<320
 print(name,flush=True)
 command=['docker','run','--rm','--user',f'{os.getuid()}:{os.getgid()}','--network','none','--cpus=4','--memory=1g','--mount','type=bind,source=/workspace/pr235-build-sources,target=/workspace/pr235-build-sources,readonly','--mount','type=bind,source=/workspace/pr235-harness-verified-v3,target=/harness,readonly','--mount',f'type=bind,source={out},target=/evidence','--workdir',f'/workspace/pr235-build-sources/{root}','orca-pr235-runtime:20261013','timeout','--signal=TERM','--kill-after=5s','90s','bun','/harness/benchmark.ts',f'--root=/workspace/pr235-build-sources/{root}',f'--revision={revision}',f'--mode={mode}','--size=10000','--samples=20',f'--output=/evidence/{name}.json']
 before=Path('/sys/fs/cgroup/cpu.stat').read_text();at=time.monotonic()
 with (out/f'{name}.log').open('w') as log:
  result=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=100,env={**os.environ,'DOCKER_CONFIG':'/workspace/pr235-harness-review/docker-config'})
 manifest['runs'].append({'name':name,'root':root,'mode':mode,'revision':revision,'exit':result.returncode,'elapsed':time.monotonic()-at,'parentCpuStatBefore':before,'parentCpuStatAfter':Path('/sys/fs/cgroup/cpu.stat').read_text()})
 (out/'controls.json').write_text(json.dumps(manifest,indent=2))
 assert result.returncode==0
manifest['elapsed']=time.monotonic()-start
(out/'controls.json').write_text(json.dumps(manifest,indent=2))
