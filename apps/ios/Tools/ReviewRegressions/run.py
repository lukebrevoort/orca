#!/usr/bin/env python3
"""Run through /tmp/orca-ui-heavy-slot.py. Foundation/HTTP, never simulator/Xcode UI."""
import argparse, hashlib, json, os, pathlib, subprocess, tempfile, time
parser = argparse.ArgumentParser(); parser.add_argument('output'); parser.add_argument('--api', action='store_true'); parser.add_argument('--importance-ref'); parser.add_argument('--preferences-ref'); args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[4]
out = pathlib.Path(args.output); out.mkdir(parents=True, exist_ok=False)
head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip(), 'Commit regression source before execution'
sources = ['Orca/Core/Models.swift','Orca/Core/APIClient.swift','Orca/Core/CacheStore.swift','Orca/Core/MailActionJSON.swift','Orca/Core/Importance.swift','Orca/Core/InboxViewModel.swift','Orca/Core/AccountPreferences.swift','Orca/Core/NotificationNavigation.swift','Orca/Core/ViewCommitStatus.swift','Orca/Core/NativeViewEditorController.swift','Tools/ReviewRegressions/Support.swift','Tools/ReviewRegressions/PaginationCases.swift','Tools/ReviewRegressions/PrimaryMailSenderCases.swift','Tools/ReviewRegressions/AppliedReloadCases.swift','Tools/ReviewRegressions/CommitStatusCases.swift','Tools/ReviewRegressions/Run.swift']
manifest = {'sourceSHA':head,'scope':'production Foundation controllers, synthetic URLProtocol and optional actual HTTP/API/SQLite; not Apple UI runtime','sourceHashes':{p:hashlib.sha256((root/'apps/ios'/p).read_bytes()).hexdigest() for p in sources}}
manifest['harnessHashes'] = {p:hashlib.sha256((root/'apps/ios/Tools/ReviewRegressions'/p).read_bytes()).hexdigest() for p in ['run.py','api-fixture.ts','runner-lifecycle.py']}
with tempfile.TemporaryDirectory(prefix='bre457-review-run-') as scratch:
    scratch = pathlib.Path(scratch); exe = scratch/'regressions'
    compile_sources = [str(root/'apps/ios'/p) for p in sources]
    if args.importance_ref:
        original = subprocess.check_output(['git','show',args.importance_ref+':apps/ios/Orca/Core/Importance.swift'],cwd=root)
        frozen = scratch/'Importance.swift'; frozen.write_bytes(original)
        compile_sources[sources.index('Orca/Core/Importance.swift')] = str(frozen)
        manifest['importanceSourceRef'] = subprocess.check_output(['git','rev-parse',args.importance_ref],cwd=root,text=True).strip()
        manifest['sourceHashes']['Orca/Core/Importance.swift'] = hashlib.sha256(original).hexdigest()
    if args.preferences_ref:
        original = subprocess.check_output(['git','show',args.preferences_ref+':apps/ios/Orca/Core/AccountPreferences.swift'],cwd=root)
        frozen = scratch/'AccountPreferences.swift'; frozen.write_bytes(original)
        compile_sources[sources.index('Orca/Core/AccountPreferences.swift')] = str(frozen)
        manifest['preferencesSourceRef'] = subprocess.check_output(['git','rev-parse',args.preferences_ref],cwd=root,text=True).strip()
        manifest['sourceHashes']['Orca/Core/AccountPreferences.swift'] = hashlib.sha256(original).hexdigest()
    with (out/'compile.log').open('w') as log:
        code = subprocess.run(['/usr/bin/xcrun','swiftc','-swift-version','5','-parse-as-library',*compile_sources,'-o',str(exe)],cwd=root,stdout=log,stderr=subprocess.STDOUT).returncode
    manifest['compileExit'] = code
    api = None; api_log = None
    try:
        if code == 0:
            command = [str(exe)]
            if args.api:
                connection = scratch/'connection.json'; api_log = (out/'api.log').open('w')
                api = subprocess.Popen(['/opt/homebrew/bin/bun',str(root/'apps/ios/Tools/ReviewRegressions/api-fixture.ts'),str(connection)],cwd=root,stdout=api_log,stderr=subprocess.STDOUT)
                deadline = time.monotonic()+20
                while not connection.exists() and api.poll() is None and time.monotonic()<deadline: time.sleep(.05)
                if not connection.exists(): raise RuntimeError('Owned actual API fixture did not become ready')
                command.append(str(connection))
            with (out/'results.log').open('w') as log: code = subprocess.run(command,cwd=root,stdout=log,stderr=subprocess.STDOUT).returncode
            manifest['regressionExit'] = code
    finally:
        if api is not None:
            api.terminate()
            try: api.wait(timeout=5)
            except subprocess.TimeoutExpired: api.kill(); api.wait()
        if api_log: api_log.close()
        evidence = scratch/'connection.json.evidence.json'
        if evidence.exists(): (out/'api-evidence.json').write_bytes(evidence.read_bytes())
        (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest)); raise SystemExit(code)
