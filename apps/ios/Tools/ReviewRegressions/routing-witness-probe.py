#!/usr/bin/env python3
"""Owned mobile-fixture HTTP/SQLite witness check; invoke only inside heavy slot."""
import json, os, pathlib, re, signal, subprocess, sys, tempfile, time, urllib.request, urllib.error
root = pathlib.Path(__file__).resolve().parents[4]
out = pathlib.Path(sys.argv[1]); out.mkdir(exist_ok=False, parents=True)
results = []; process = None; connection_path = None
expected = ['unauthenticated-witness', 'unknown-thread-rejected', 'original-inherit-precondition', 'first-command-real-200', 'first-receipt-binds-command', 'first-receipt-exact-inverse', 'independent-sql-moved', 'unauthenticated-put-no-receipt', 'exact-revision-restores-original', 'independent-sql-restored', 'stale-compensation-rejected', 'stale-rejection-no-fake-receipt', 'no-provider-delivery']
def check(name, passed, detail):
 results.append({'case': name, 'pass': bool(passed), 'detail': detail})
 if not passed: raise AssertionError(name)
manifest = {'scope': 'owned mobile fixture real routing PUT receipts + independent fixed synthetic SQL; not XCTest or provider delivery', 'expectedCases': expected}
log = (out/'fixture.log').open('w')
try:
 process = subprocess.Popen(['/opt/homebrew/bin/bun', 'apps/api/scripts/mobile-fixture.ts'], cwd=root, stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, TMPDIR='/private/tmp'))
 deadline = time.monotonic()+15
 while process.poll() is None and time.monotonic()<deadline:
  text = (out/'fixture.log').read_text()
  match = re.search(r'Synthetic connection details: (.+)', text)
  if match:
   connection_path = pathlib.Path(match.group(1).strip())
   if connection_path.is_file(): break
  time.sleep(.04)
 if connection_path is None or not connection_path.is_file(): raise RuntimeError('Owned mobile fixture did not publish readiness')
 connection = json.loads(connection_path.read_text()); token = connection['accessToken']; base = connection['apiURL']; account = connection['accountId']; thread = 'ios-fixture-thread-1'
 assert account == 'ios-fixture-account' and base.startswith('http://127.0.0.1:')
 def request(path, method='GET', body=None, auth=True):
  headers = {'Accept': 'application/json'}
  if auth: headers['Authorization'] = 'Bearer '+token
  data = None if body is None else json.dumps(body).encode()
  if data is not None: headers['Content-Type'] = 'application/json'
  req = urllib.request.Request(base+path, method=method, data=data, headers=headers)
  try:
   with urllib.request.urlopen(req, timeout=8) as response: status = response.status; raw = response.read()
  except urllib.error.HTTPError as error: status = error.code; raw = error.read()
  return status, json.loads(raw) if raw else None
 path = '/v1/destinations/routing?accountId='+account+'&threadId='+thread
 witness_path = '/__fixture/routing-receipts?threadId='+thread
 status, _ = request(witness_path, auth=False); check('unauthenticated-witness', status == 401, 'Bearer gate precedes diagnostic data/SQLite access')
 status, _ = request('/__fixture/routing-receipts?threadId=foreign'); check('unknown-thread-rejected', status == 400, 'No arbitrary SQL target')
 status, before = request(path); _, initial = request(witness_path); _, catalog = request('/v1/destinations'); _, provider_before = request('/__fixture/compose/state')
 original = before['selection']['explicitDestinationId']; revision = before['revision']; focus = catalog['legacyDestinationIds']['focus']; ordinal = initial['ordinal']
 check('original-inherit-precondition', status == 200 and original is None and initial['sqlite']['manualOverrideDestinationId'] is None, 'Actual default synthetic thread has inherited placement before mutation')
 command = {'expectedRevision': revision, 'target': {'scope': 'conversation', 'threadId': thread}, 'destinationId': focus}
 status, applied = request('/v1/destinations/routing?accountId='+account, 'PUT', command)
 check('first-command-real-200', status == 200 and applied['state']['revision'] == revision+1, 'Original production app handler and real Organization SQLite commit')
 _, first = request(witness_path); entries = [e for e in first['receipts'] if e['ordinal'] > ordinal]
 check('first-receipt-binds-command', len(entries) == 1 and entries[0]['command'] == command and entries[0]['status'] == 200 and entries[0]['receipt']['state']['revision'] == applied['state']['revision'] and entries[0]['receivedAt'] <= entries[0]['responseAt'], 'Clone of real response; no reconstructed/fabricated receipt')
 check('first-receipt-exact-inverse', entries[0]['receipt']['undo'] == {'expectedRevision': revision+1, 'target': command['target'], 'destinationId': original}, 'Original explicit null and exact acknowledged revision preserved')
 check('independent-sql-moved', first['sqlite']['manualOverrideDestinationId'] == focus, 'Independent fixed-thread SQL, not response-derived membership')
 status, _ = request('/v1/destinations/routing?accountId='+account, 'PUT', dict(command, expectedRevision=revision+1), auth=False)
 _, no_auth = request(witness_path)
 check('unauthenticated-put-no-receipt', status == 401 and no_auth['ordinal'] == first['ordinal'], 'Authentication failure cannot manufacture an owned routing receipt')
 undo = entries[0]['receipt']['undo']; status, restored = request('/v1/destinations/routing?accountId='+account, 'PUT', undo)
 check('exact-revision-restores-original', status == 200 and restored['state']['selection']['explicitDestinationId'] == original, 'Compensation at recorded ack revision; never GET-current overwrite')
 _, restored_sql = request(witness_path)
 check('independent-sql-restored', restored_sql['sqlite']['manualOverrideDestinationId'] is None and restored_sql['sqlite']['bindingDestinationId'] is None, 'Original inherited semantics verified independently; no provider rollback or row-deletion claim')
 status, _ = request('/v1/destinations/routing?accountId='+account, 'PUT', undo)
 check('stale-compensation-rejected', status == 409, 'A repeated original ack revision cannot overwrite intervening state')
 _, final = request(witness_path); last = final['receipts'][-1]
 check('stale-rejection-no-fake-receipt', last['status'] == 409 and last['receipt'] is None and final['sqlite']['manualOverrideDestinationId'] is None, 'Failed commands remain visible failures, never acknowledged cleanup')
 _, provider_after = request('/__fixture/compose/state')
 check('no-provider-delivery', provider_before['deliveries'] == provider_after['deliveries'] and provider_before['sendRequests'] == provider_after['sendRequests'], 'Synthetic delivery/send ledger unchanged; not physical provider evidence')
 (out/'witness.json').write_text(json.dumps({'before': initial, 'afterFocus': first, 'afterRestoreAndStale': final}, indent=2)+'\n')
 manifest['exit'] = 0
except Exception as error:
 manifest['error'] = type(error).__name__+': '+str(error); manifest['exit'] = 1
finally:
 if process is not None:
  if process.poll() is None:
   process.terminate()
   try: process.wait(timeout=5)
   except subprocess.TimeoutExpired: process.kill(); process.wait()
  manifest['ownedFixtureTerminal'] = process.poll() is not None
 log.close()
 manifest['ownedTemporaryMailboxRemoved'] = connection_path is None or not connection_path.parent.exists()
 manifest['results'] = results
 manifest['coverageMatched'] = [r['case'] for r in results] == expected
 if not manifest['coverageMatched'] or not manifest.get('ownedFixtureTerminal') or not manifest['ownedTemporaryMailboxRemoved']: manifest['exit'] = 2
 (out/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({k: manifest[k] for k in ['exit', 'coverageMatched', 'ownedTemporaryMailboxRemoved']})); sys.exit(manifest['exit'])
