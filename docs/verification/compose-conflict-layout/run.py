import importlib.util, pathlib, tempfile, os, subprocess, shutil, time, json, sys
repo=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else '/workspace/orca'); out=pathlib.Path(sys.argv[1]); out.mkdir()
spec=importlib.util.spec_from_file_location('v',repo/'scripts/pstack/verify.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
work=pathlib.Path(tempfile.mkdtemp(prefix='orca-conflict-'));source=work/'source';source.mkdir();raw=work/'raw';raw.mkdir(); fixture=None
try:
 v.snapshot(source,v.git('rev-parse','HEAD'))
 env={'PATH':os.environ['PATH'],'HOME':str(work/'home'),'TMPDIR':str(raw),'ORCA_CHROMIUM_EXECUTABLE':'/usr/bin/chromium','ORCA_PLAYWRIGHT_MODULE':str(source/'node_modules/playwright/index.mjs')};pathlib.Path(env['HOME']).mkdir()
 with (out/'checks.log').open('w') as log:
  v.run(['bun','run','build'],source,env,log)
  fixture=subprocess.Popen(['bun','--no-env-file','apps/api/scripts/compose-fixture.ts'],cwd=source,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  for _ in range(300):
   files=list(raw.glob('orca-compose-fixture-*/connection.json'))
   if files:break
   time.sleep(.1)
  v.instance_doctor(files[0],fixture)
  v.run(['node',str(pathlib.Path(__file__).with_name('probe.mjs')),str(files[0]),str(out)],source,env,log)
finally:
 v.stop(fixture);shutil.rmtree(work)
 (out/'identity.json').write_text(json.dumps({'commit':v.git('rev-parse','HEAD'),'cleanupComplete':not work.exists(),'syntheticOnly':True},indent=2))
