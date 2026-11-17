from pathlib import Path
import hashlib,json,os,signal,subprocess,sys,tempfile,time
expected='0bd8e7876dd2bf1b32f99009cc9c486cca3eb1ad'
out=Path('/tmp/bre457-root-viewport-0bd8e787');out.mkdir(exist_ok=False)
os.environ['TMPDIR']='/private/tmp';tempfile.tempdir='/private/tmp'
start=time.monotonic();deadline=start+9
def git(*args):return subprocess.check_output(['git',*args],text=True).strip()
assert git('rev-parse','HEAD')==expected and not git('status','--porcelain')
files=sorted(p for folder in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in Path(folder).rglob('*.swift'))
assert len(files)==38
extra=Path('apps/ios/Tools/ViewportGeometryChecks.swift')
hashes=lambda:{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [*files,extra]}
receipt={'startSHA':expected,'startStatus':'','inputHashes':hashes(),'scope':'UI-test-only pure rectangle geometry plus38Swift grammar; no API, simulator, XCTest, event-routing or product runtime proof','stages':[]}
(out/'driver.py').write_bytes(Path(__file__).read_bytes())
def run(name,command,cap):
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  try:code=p.wait(timeout=max(.01,min(cap,deadline-time.monotonic())))
  except subprocess.TimeoutExpired:
   os.killpg(p.pid,signal.SIGKILL);p.wait();code=124
 receipt['stages'].append({'name':name,'command':command,'exit':code})
 return code
code=2
try:
 with tempfile.TemporaryDirectory(prefix='bre457-viewport-') as temp:
  binary=str(Path(temp)/'geometry')
  code=run('compile',['/usr/bin/xcrun','swiftc','apps/ios/OrcaUITests/ViewportGeometry.swift',str(extra),'-o',binary],5)
  if code==0:
   code=run('geometry',[binary],2)
   lines=[s for s in (out/'geometry.log').read_text().splitlines() if s.startswith('CASE ')]
   receipt['geometryCompleted']=len(lines);receipt['geometryPass']=sum(': PASS —' in s for s in lines);receipt['geometryFailures']=[s for s in lines if ': FAIL —' in s]
   if len(lines)!=12 or len({s.split(': ',1)[0] for s in lines})!=12 or receipt['geometryPass']!=12:code=2
  if code==0:code=run('grammar',['/usr/bin/xcrun','swiftc','-frontend','-parse',*[str(p) for p in files]],2)
finally:
 receipt.update(endSHA=git('rev-parse','HEAD'),endStatus=git('status','--porcelain'),endingHashes=hashes(),elapsedSeconds=time.monotonic()-start)
 receipt['identityUnchanged']=receipt['endSHA']==expected and not receipt['endStatus'] and receipt['inputHashes']==receipt['endingHashes']
 if not receipt['identityUnchanged']:code=2
 receipt['finalExit']=code;(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps({k:receipt.get(k) for k in ['startSHA','endSHA','geometryCompleted','geometryPass','geometryFailures','identityUnchanged','elapsedSeconds','finalExit']}))
sys.exit(code)
