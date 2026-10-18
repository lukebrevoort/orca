import os, pathlib, subprocess, time
out=pathlib.Path(__file__).parent
base='e9f928258479aa7b46f7489c6e3e100c254a064f'
head='f5569abc45fa9a47bd1c94e81025703595d7b7d5'
for index,role in enumerate(['baseline','candidate','candidate','baseline'],1):
    cwd='/workspace/orca-oct18-base' if role=='baseline' else '/workspace/orca-oct18-perf'
    env=dict(os.environ,IMAGE_BENCH_SHA=base if role=='baseline' else head,IMAGE_BENCH_ROLE=role)
    name=f'{index}-{role}'
    print('START',name,flush=True)
    start=time.monotonic()
    with (out/f'{name}.stdout.log').open('x') as stdout,(out/f'{name}.stderr.log').open('x') as stderr:
        subprocess.run(['/workspace/.orca-tools/node_modules/.bin/bun','apps/api/benchmarks/image-eligibility.ts',str(out/f'{name}.json')],cwd=cwd,env=env,stdout=stdout,stderr=stderr,check=True,timeout=180)
    print('DONE',name,'seconds',round(time.monotonic()-start,3),flush=True)
