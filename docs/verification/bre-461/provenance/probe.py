import subprocess,pathlib,json,sys
root=pathlib.Path(__file__).resolve().parents[4]; output=pathlib.Path(sys.argv[1]).resolve(); assert not output.is_relative_to(root); output.mkdir(); sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert not subprocess.check_output(['git','status','--porcelain=v1'],cwd=root,text=True).strip()
target=root/'apps/api/src/providers/gmail/normalizer.ts'; original=target.read_bytes(); marker='BRE461_DIRTY_NORMALIZER_EXECUTED'; records=[]
def probe(name,expected):
 out=output/(name+'.json'); assert not out.exists()
 result=subprocess.run(['/opt/homebrew/bin/bun','apps/api/scripts/importance-gmail-work.ts',expected,str(out)],cwd=root,text=True,capture_output=True,timeout=10)
 (output/(name+'.log')).write_text(result.stdout+result.stderr)
 record={'case':name,'requestedCandidate':expected,'executionHead':sha,'exitCode':result.returncode,'rejected':result.returncode!=0 and not out.exists() and marker not in result.stderr,'outputCreated':out.exists()}; assert record['rejected'],record;records.append(record)
try:
 target.write_bytes(original.replace(b'  const headers = getHeaders(message.payload);',b'  throw new Error("'+marker.encode()+b'");\n  const headers = getHeaders(message.payload);'))
 probe('dirty-normalizer',sha)
finally: target.write_bytes(original)
scratch=root/'apps/api/src/bre461-untracked-source-probe.ts';assert not scratch.exists()
try:
 scratch.write_text('// synthetic provenance probe\n');probe('untracked-source',sha)
finally:scratch.unlink()
probe('wrong-head','db8a1e6e41f5d99183b680e8e43531486edddad5')
assert not subprocess.check_output(['git','status','--porcelain=v1'],cwd=root,text=True).strip()
(output/'results.json').write_text(json.dumps({'head':sha,'records':records,'cleanAfter':True},indent=2)+'\n');print(json.dumps({'head':sha,'cases':len(records),'rejected':sum(r['rejected'] for r in records),'cleanAfter':True}))
