from pathlib import Path
import subprocess,json,time
root=Path('/workspace/orca-lease-stage-probes')
p=root/'apps/api/src/agents/g2-request-guards.test.ts'
original=p.read_text()
out=Path('/workspace/pr261-lease-diagnostics')
# Mutate only this owned scratch test; unchanged product code and 5000ms timeout.
cases=[
 ('entry','      await enteredDeferred;','      await new Promise<void>(() => {});','waiting-for-tool-entry'),
 ('channel','        channel.port2.postMessage(null);','        channel.port1.close(); channel.port2.close();','waiting-for-message-channel'),
 ('second','      const second = await handler.fetch','      await new Promise<void>(() => {});\n      const second = await handler.fetch','waiting-for-second-exchange'),
 ('cleanup','      await observedFirstExchange;','      await new Promise<void>(() => {});\n      await observedFirstExchange;','waiting-for-first-exchange-cleanup'),
 ('abort-assertion','      controller.abort();','      // Fault probe: omit abort.','checking-abort-settlement'),
]
results=[]
try:
 for name,needle,replacement,stage in cases:
  assert original.count(needle)==1,(name,original.count(needle))
  p.write_text(original.replace(needle,replacement))
  start=time.monotonic()
  run=subprocess.run(['/workspace/.orca-tools/node_modules/.bin/bun','--no-env-file','test',str(p),'--test-name-pattern','releases an admitted MCP lease'],cwd=root,env={'PATH':'/workspace/.orca-tools/node_modules/.bin:/usr/bin:/bin','HOME':'/tmp'},capture_output=True,text=True,timeout=12)
  log=run.stdout+run.stderr;(out/(name+'.log')).write_text(log)
  assert run.returncode!=0,name
  assert stage in log,name
  if name!='abort-assertion': assert 'timed out after 5000ms' in log,name
  else: assert 'aborting the admitted HTTP exchange must settle it before deferred tool work completes' in log,name
  r={'case':name,'exit':run.returncode,'wall':time.monotonic()-start,'expectedStage':stage};results.append(r);print(json.dumps(r),flush=True)
finally:
 p.write_text(original)
 (out/'probes.json').write_text(json.dumps(results,indent=2))
