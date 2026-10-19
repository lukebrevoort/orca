from pathlib import Path
import subprocess,json
root=Path('/workspace/orca-retry-diagnosis');p=root/'apps/web/src/App.interaction.test.tsx';out=Path('/workspace/pr261-retry-evidence')
refs={'combined':'7b084a8232c5db29e18bd33739e8e0c2c5827f89','main':'357ee56de74e3f080c2dcb6e3ccfadfed1a199e0','approved':'54021edc5b49909e80f9376709eeca9369b3b3e3'}
for name,sha in refs.items():
 subprocess.run(['git','checkout','--detach',sha],cwd=root,check=True,capture_output=True)
 original=p.read_text();start=original.index('  test("fetches fresh detail after explicit Retry');end=original.index('\n  test(',start+10)
 block=original[start:end]
 block=block.replace('threadReads.push(`${url.pathname}${url.search}`);','threadReads.push(`${url.pathname}${url.search}`);\n        console.info("RETRY_READ", threadReads.length, url.pathname + url.search, new Error("synthetic request source").stack);')
 block=block.replace('      await act(async () => retry.click());','      console.info("RETRY_ERROR_VISIBLE");\n      await waitFor(150);\n      console.info("RETRY_CLICK", JSON.stringify(threadReads));\n      await act(async () => retry.click());')
 try:
  p.write_text(original[:start]+block+original[end:])
  r=subprocess.run(['/workspace/.orca-tools/node_modules/.bin/bun','--no-env-file','test','apps/web/src/App.interaction.test.tsx','--test-name-pattern','fetches fresh detail after explicit Retry'],cwd=root,env={'PATH':'/workspace/.orca-tools/node_modules/.bin:/usr/bin:/bin','HOME':'/tmp'},capture_output=True,text=True,timeout=20)
  (out/(name+'.log')).write_text(r.stdout+r.stderr)
  print(name,sha,r.returncode,flush=True)
 finally:p.write_text(original)
