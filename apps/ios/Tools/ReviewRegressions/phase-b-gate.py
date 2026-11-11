#!/usr/bin/env python3
"""One explicitly allocated heavy-slot invocation; no install, Apple UI or retries."""
from pathlib import Path
import hashlib, json, os, resource, signal, subprocess, sys, time
root = Path(__file__).resolve().parents[4]
expected, output = sys.argv[1:3]; out = Path(output); out.mkdir(exist_ok=False)
cap = 60; start = time.monotonic()
sha = lambda: subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
status = lambda: subprocess.check_output(['git','status','--porcelain'], cwd=root, text=True)
inventory = json.loads((Path(__file__).parent/'expected-phase-b-cases.json').read_text())
files = [p for folder in ['apps/ios/Orca','apps/ios/OrcaTests','apps/ios/OrcaUITests'] for p in sorted((root/folder).rglob('*.swift'))]
assert len(files) == 44
inputs = files + [p for p in sorted(Path(__file__).parent.iterdir()) if p.is_file() and p.suffix in ['.py','.swift','.ts','.json']] + [root/'apps/api/scripts/mobile-fixture.ts', root/'apps/ios/OrcaUITests/run-fixture-tests.sh', root/'apps/ios/Orca.xcodeproj/project.pbxproj', root/'bun.lock']
inputs = list(dict.fromkeys(inputs))
hashes = lambda: {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs}
receipt = {'scope':'418 planned Foundation/API controls +13 mobile-fixture receipt probes +44 Swift grammar +fixture/transitive types +runner syntax/lifecycle; NOT SwiftUI/XCTest/event-hit proof', 'startSHA':sha(),'startStatus':status(),'sourceHashes':hashes(),'expectedCaseCount':inventory['expectedCount'],'stages':[],'resourcesBefore':list(resource.getrusage(resource.RUSAGE_CHILDREN)),'exit':2}
assert receipt['startSHA'] == expected and not receipt['startStatus']
env = dict(os.environ, PATH='/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:'+os.environ['PATH'], TMPDIR='/private/tmp')
(out/'driver.py').write_bytes(Path(__file__).read_bytes())
class GateInterrupted(BaseException):
 def __init__(self, signum): self.signum = signum
def run(name, command, stage_cap):
 remaining = cap - (time.monotonic()-start)
 if remaining <= 0: return 124
 stage = {'stage':name,'command':command,'exit':2,'timeout':False,'cleanup':'not-started'}
 receipt['stages'].append(stage)
 process = None; code = 2; phase = 'starting'; pending_signal = None
 previous = {sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
 def interrupted(signum, frame):
  nonlocal pending_signal, phase
  if pending_signal is None: pending_signal = signum
  # A signal may arrive before Popen returns its handle or while cleanup
  # waits. Defer it until we own the handle; cleanup must never re-enter.
  if phase == 'waiting':
   phase = 'cleanup'
   raise GateInterrupted(pending_signal)
 try:
  for sig in previous: signal.signal(sig, interrupted)
  with (out/(name+'.log')).open('w') as log:
   # Retain the inherited slot descriptor until the recorded group is gone.
   process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=False)
   stage['ownedPidAndPgid'] = process.pid
   phase = 'waiting'
   if pending_signal is not None:
    phase = 'cleanup'
    raise GateInterrupted(pending_signal)
   try: code = process.wait(timeout=min(stage_cap,remaining))
   except subprocess.TimeoutExpired:
    stage['timeout'] = True; code = 124
   finally: phase = 'cleanup'
 except GateInterrupted as error:
  phase = 'cleanup'; code = 128 + error.signum
  raise
 except BaseException as error:
  phase = 'cleanup'; stage['exception'] = type(error).__name__ + ': ' + str(error)
  raise
 finally:
  phase = 'cleanup'
  try:
   if process is not None:
    # Existing run.py/probe finally blocks get a cooperative cleanup window.
    try: os.killpg(process.pid, signal.SIGINT); stage['cleanup'] = 'interrupt-sent'
    except ProcessLookupError: stage['cleanup'] = 'already-terminal'
    try: process.wait(timeout=3)
    except subprocess.TimeoutExpired:
     try: os.killpg(process.pid, signal.SIGKILL)
     except ProcessLookupError: pass
     process.wait(timeout=1); stage['escalated'] = True
    try:
     os.killpg(process.pid, 0)
     os.killpg(process.pid, signal.SIGKILL)
     stage['cleanupFailure'] = 'Owned stage group remained after direct-child wait'
    except ProcessLookupError: stage['cleanup'] = 'terminal'
  except BaseException as error:
   stage['cleanupFailure'] = type(error).__name__ + ': ' + str(error)
   raise
  finally:
   if pending_signal is not None:
    code = 128 + pending_signal; stage['interruptedSignal'] = pending_signal
   stage['exit'] = code; stage['elapsedSeconds'] = time.monotonic()-start
   for sig, handler in previous.items(): signal.signal(sig, handler)
 # Also preserve cancellation that first arrived during normal/timeout cleanup.
 if pending_signal is not None: raise GateInterrupted(pending_signal)
 return code

try:
 code = run('controllers-api', ['python3','apps/ios/Tools/ReviewRegressions/run.py',str(out/'controllers'),'--api'], 40)
 rows = (out/'controllers/results.log').read_text().splitlines() if (out/'controllers/results.log').exists() else []
 rows = [s for s in rows if s.startswith('CASE ')]
 ids = [s.split(': ',1)[0].removeprefix('CASE ') for s in rows]
 receipt['actualCompleted'] = len(rows); receipt['actualPass'] = sum(': PASS —' in s for s in rows); receipt['actualFailures'] = [s for s in rows if ': FAIL —' in s]
 receipt['coverageMatched'] = len(ids) == len(set(ids)) == inventory['expectedCount'] and set(ids) == set(inventory['expectedCaseIDs'])
 receipt['missingCases'] = sorted(set(inventory['expectedCaseIDs'])-set(ids)); receipt['unexpectedCases'] = sorted(set(ids)-set(inventory['expectedCaseIDs']))
 parse = run('grammar',['/usr/bin/xcrun','swiftc','-frontend','-parse',*[str(p.relative_to(root)) for p in files]], 3)
 final = code or parse
 if not code and not receipt['coverageMatched']: final = 2
 if not final:
  final = run('fixture-types',['/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node','node_modules/typescript/bin/tsc','-p','apps/ios/Tools/ReviewRegressions/tsconfig.fixture.json','--noEmit'], 10)
 if not final:
  final = run('routing-witness',['python3','apps/ios/Tools/ReviewRegressions/routing-witness-probe.py',str(out/'routing-witness')], 15)
 if not final: final = run('runner-syntax',['zsh','-n','apps/ios/OrcaUITests/run-fixture-tests.sh'], 2)
 if not final: final = run('runner-lifecycle',['python3','apps/ios/Tools/ReviewRegressions/runner-lifecycle.py'], 5)
 if not final: final = run('project-syntax',['plutil','-lint','apps/ios/Orca.xcodeproj/project.pbxproj'], 2)
 receipt['exit'] = final

except BaseException as error:
 receipt['failure'] = {'type':type(error).__name__,'message':str(error)}
 receipt['exit'] = 128 + error.signum if isinstance(error, GateInterrupted) else 130 if isinstance(error, KeyboardInterrupt) else 2
finally:
 try:
  receipt['endSHA'] = sha(); receipt['endStatus'] = status(); receipt['endingSourceHashes'] = hashes()
  receipt['identityUnchanged'] = receipt['endSHA'] == receipt['startSHA'] and not receipt['endStatus'] and receipt['sourceHashes'] == receipt['endingSourceHashes']
 except BaseException as error:
  receipt['identityUnchanged'] = False; receipt['endStateError'] = str(error)
 receipt['ownedAPICleanupReceiptPresent'] = (out/'controllers/api-evidence.json').exists()
 receipt['notStarted'] = [name for name in ['controllers-api','grammar','fixture-types','routing-witness','runner-syntax','runner-lifecycle','project-syntax'] if name not in [stage['stage'] for stage in receipt['stages']]]
 if not receipt['identityUnchanged'] or any(stage.get('cleanupFailure') for stage in receipt['stages']): receipt['exit'] = 2
 if receipt.get('exit',2) == 0 and (not receipt.get('coverageMatched') or not receipt['ownedAPICleanupReceiptPresent'] or receipt.get('actualFailures') or receipt.get('actualPass') != inventory['expectedCount']): receipt['exit'] = 2
 receipt['elapsedSeconds'] = time.monotonic()-start; receipt['resourcesAfter'] = list(resource.getrusage(resource.RUSAGE_CHILDREN))
 (out/'manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:receipt.get(k) for k in ['startSHA','endSHA','actualCompleted','actualPass','actualFailures','coverageMatched','identityUnchanged','exit','elapsedSeconds']})); sys.exit(receipt['exit'])
