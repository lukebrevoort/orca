from pathlib import Path
import subprocess,os,json,time,hashlib,sys,signal,resource
expected,outarg=sys.argv[1:3];expectedCases=int(sys.argv[3]) if len(sys.argv)>3 else 267;assert expectedCases>0;out=Path(outarg);out.mkdir(exist_ok=False)
sha=lambda:subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
status=lambda:subprocess.check_output(['git','status','--porcelain'],text=True)
start=time.monotonic();startSHA=sha();startStatus=status();assert startSHA==expected and not startStatus
files=[p for d in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in sorted(Path(d).rglob('*.swift'))];assert len(files)==37
hashes=lambda:{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
beforeHashes=hashes();env=dict(os.environ,PATH='/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:'+os.environ['PATH'],TMPDIR='/private/tmp')
receipt={'status':'running','expectedCaseCount':expectedCases,'startSHA':startSHA,'startStatus':startStatus,'sourceHashes':beforeHashes,'driverHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'stages':[],'resourceBefore':list(resource.getrusage(resource.RUSAGE_CHILDREN))}
(out/'driver.py').write_bytes(Path(__file__).read_bytes())
def run(name,cmd,cap):
 with (out/(name+'.log')).open('w') as log:
  p=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  timed=False
  try:code=p.wait(timeout=cap)
  except subprocess.TimeoutExpired:
   timed=True;os.killpg(p.pid,signal.SIGINT)
   try:p.wait(timeout=2)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   code=124
 receipt['stages'].append({'stage':name,'command':cmd,'exit':code,'timeout':timed,'elapsedSeconds':time.monotonic()-start})
 return code
try:
 code=run('controllers-api',['python3','apps/ios/Tools/ReviewRegressions/run.py',str(out/'controllers'),'--api'],35)
 cases=(out/'controllers/results.log').read_text().splitlines() if (out/'controllers/results.log').exists() else []
 cases=[s for s in cases if s.startswith('CASE ')];receipt['actualCompleted']=len(cases);receipt['actualPass']=sum(': PASS —' in s for s in cases);receipt['actualFailures']=[s for s in cases if ': FAIL —' in s]
 remaining=40-(time.monotonic()-start)
 if remaining>0:parse=run('grammar',['/usr/bin/xcrun','swiftc','-frontend','-parse',*[str(p) for p in files]],min(3,remaining))
 else:parse=None
 receipt['status']='terminal';receipt['endSHA']=sha();receipt['endStatus']=status();receipt['endSourceHashes']=hashes();receipt['resourceAfter']=list(resource.getrusage(resource.RUSAGE_CHILDREN));receipt['elapsedSeconds']=time.monotonic()-start
 receipt['identityUnchanged']=receipt['endSHA']==startSHA and not receipt['endStatus'] and beforeHashes==receipt['endSourceHashes']
 receipt['ownedAPICleanupReceiptPresent']=(out/'controllers/api-evidence.json').exists()
 receipt['coverageMatched']=len(cases)==expectedCases and receipt['actualPass']+len(receipt['actualFailures'])==expectedCases and len({s.split(': ',1)[0] for s in cases})==expectedCases
 receipt['resultsPassed']=receipt['actualPass']==expectedCases and not receipt['actualFailures']
 receipt['finalExit']=code if code else (parse if parse is not None else 124)
 if not receipt['identityUnchanged'] or not receipt['coverageMatched'] or not receipt['ownedAPICleanupReceiptPresent']:receipt['finalExit']=2
 if receipt['finalExit']==0 and not receipt['resultsPassed']:receipt['finalExit']=2
 receipt['scope']='Foundation/API/SQLite controls and Swift grammar only; runtime failure is not a pass; no Apple UI proof'
finally:(out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt.get(k) for k in ['startSHA','endSHA','actualCompleted','actualPass','actualFailures','identityUnchanged','coverageMatched','finalExit','elapsedSeconds','stages']}));sys.exit(receipt['finalExit'])
