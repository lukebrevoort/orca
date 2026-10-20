from pathlib import Path
import subprocess,os,json,time
p=Path(__file__).parent
assert not (p/'runs.json').exists()
m={'purpose':'Same immutable cache, paired control versus unique-key stale refresh; not candidate speedup','runs':[],'cpus':2,'memory':'512m','network':'none','timeoutSeconds':30}
for i,mode in enumerate(['control','stale','stale','control'],1):
 assert not subprocess.check_output(['docker','ps','-q']).strip(),'Competing container present; stop'
 start=time.monotonic()
 with (p/f'{i}-{mode}.json').open('w') as out,(p/f'{i}-{mode}.stderr').open('w') as err:
  r=subprocess.run(['docker','run','--rm','--network','none','--cpus=2','--memory=512m','--mount',f'type=bind,source={p},target=/evidence,readonly','--workdir','/evidence','orca-pr235-runtime:20261013','timeout','--signal=TERM','--kill-after=5s','30s','bun','cache-growth.ts',mode],stdout=out,stderr=err,timeout=40,env={**os.environ,'DOCKER_CONFIG':'/workspace/pr235-harness-review/docker-config'})
 m['runs'].append({'index':i,'mode':mode,'exit':r.returncode,'elapsedSeconds':time.monotonic()-start})
 (p/'runs.json').write_text(json.dumps(m,indent=2)+'\n')
 print(m['runs'][-1],flush=True)
 if r.returncode:break
