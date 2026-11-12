#!/usr/bin/env python3
"""SOURCE-ONLY PREPARED: run once through ROOT's allocated heavy wrapper."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path('/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829')
BUN = '/opt/homebrew/bin/bun'
NODE = '/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
BASELINE = '1f9bbc979681c8bf5e5c3c10fd8704a26a8f1e2b'
APPROVED_FINAL = '2ef7fb452d644a08afc1dac0ef154ac632310c55'
DEMO_HEAD = '869ce35f8f0d0eb71902ad5433b27fbb00e7be05'
OLD = Path('/private/tmp/bre457-pin-query-candidate-869ce35f-01')
PHASES = [('lint', 120), ('typecheck', 120), ('test', 300), ('build', 180)]
DEMO_CAP = 60
FOCUSED_CAP = 90
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
USAGE = re.compile(r'(?m)^(?:[^\n]*?: )?(?:Usage: bun(?: run)?\b|tsc: The TypeScript Compiler)')

# Records only real compiler/Vite entrypoints; no test argv, credentials or env.
# Installed outside the checkout and inherited by script-launched pinned Node.
OBSERVER = r'''
const fs = require('node:fs');
const path = require('node:path');
let entry;
try { entry = fs.realpathSync(process.argv[1]); } catch { return; }
if (![process.env.BRE457_TSC_ENTRY, process.env.BRE457_VITE_ENTRY].includes(entry)) return;
const args = process.argv.slice(2);
let project = null;
const index = args.findIndex(arg => arg === '-p' || arg === '--project');
if (index >= 0 && args[index + 1]) project = path.resolve(process.cwd(), args[index + 1]);
const base = {pid: process.pid, entry, execPath: fs.realpathSync(process.execPath), command: [fs.realpathSync(process.execPath), entry, ...args], cwd: process.cwd(), args, project, stage: process.env.BRE457_FINAL_STAGE};
function record(event) { fs.appendFileSync(process.env.BRE457_NODE_EVENTS, JSON.stringify({...base, ...event}) + '\n'); }
record({event: 'start'});
process.on('exit', code => record({event: 'exit', exitCode: code}));
'''


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, timeout=15).strip()


def source_inputs(revision):
    paths = ['apps/api/src', 'packages/shared/src', 'docs/verification/bre-457-pin-query/candidate-demo.ts']
    raw = subprocess.check_output(['git', 'ls-tree', '-r', '-z', revision, '--', *paths], cwd=ROOT, timeout=15)
    return [entry.decode() for entry in raw.split(b'\0') if entry]


def checked_compile_exit(code, output):
    if code:
        return code
    return 2 if USAGE.search(ANSI.sub('', output)) else 0


def terminate_owned_group(child):
    # A stage has its own new POSIX session/group. Never target by process name.
    pid = child.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return 'already-terminal'
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        child.poll()  # Reap the owned direct child before checking its group.
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return 'terminated'
        time.sleep(.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        return 'terminated'
    return 'kill-sent-to-owned-group'


def main():
    if len(sys.argv) != 3:
        raise SystemExit('ROOT allocation required: bre457-final-gates.py NEW_EVIDENCE_DIRECTORY EXACT_FINAL_SHA')
    evidence = Path(sys.argv[1]).resolve()
    expected = sys.argv[2]
    if expected != APPROVED_FINAL or git('rev-parse', 'HEAD') != expected or git('status', '--porcelain'):
        raise SystemExit('Final gate requires the explicitly allocated exact clean final SHA')
    subprocess.run(['git', 'merge-base', '--is-ancestor', BASELINE, expected], cwd=ROOT, check=True, timeout=15)
    if evidence.exists() or ROOT in evidence.parents or evidence == ROOT or re.search(r'\s', str(evidence)):
        raise SystemExit('Evidence must be a new outside-checkout path without whitespace')
    workspaces = []
    for pattern in ['apps/*/package.json', 'packages/*/package.json']:
        for package in sorted(ROOT.glob(pattern)):
            data = json.loads(package.read_text())
            workspaces.append({'path': str(package.parent.relative_to(ROOT)), 'name': data['name'], 'scripts': data.get('scripts', {}), 'packageSha256': sha(package)})
            for name in ['.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']:
                if (package.parent / name).exists():
                    raise SystemExit(f'Refusing automatic environment-file loading: {package.parent / name}')
    for name in ['.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.production.local']:
        if (ROOT / name).exists():
            raise SystemExit(f'Refusing automatic environment-file loading: {ROOT / name}')
    evidence.mkdir(parents=True)
    owned_tmp = Path(tempfile.mkdtemp(prefix='bre457-final-', dir='/private/tmp'))
    deadline = time.monotonic() + 400
    manifest = {'kind': 'ROOT-allocated current-main sequential workspace gate', 'startSHA': expected, 'startStatus': '', 'startedAt': time.time(), 'driver': {'path': str(Path(__file__).resolve()), 'sha256': sha(__file__)}, 'workspaces': workspaces, 'stages': [], 'ownedTmp': str(owned_tmp), 'overallExit': 2}
    observer = evidence / 'node-observer.cjs'
    observer.write_text(OBSERVER)
    compiler = (ROOT / 'node_modules/typescript/bin/tsc').resolve()
    vite = (ROOT / 'node_modules/vite/bin/vite.js').resolve()
    events = evidence / 'node-executions.jsonl'
    env = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME', 'SHELL'] if key in os.environ}
    env.update({'PATH': str(Path(NODE).parent) + ':/opt/homebrew/bin:/usr/bin:/bin', 'TMPDIR': str(owned_tmp), 'CI': 'true', 'NO_COLOR': '1', 'TERM': 'dumb', 'LANG': 'en_US.UTF-8', 'BRE457_QUERY_STAGE': 'candidate', 'NODE_OPTIONS': '--require=' + str(observer), 'BRE457_NODE_EVENTS': str(events), 'BRE457_TSC_ENTRY': str(compiler), 'BRE457_VITE_ENTRY': str(vite)})

    def save():
        (evidence / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    def stage(name, command, cap, extra=None):
        if git('rev-parse', 'HEAD') != expected or git('status', '--porcelain'):
            raise RuntimeError('Source drift detected before stage; no further command launched')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Overall400s work deadline reached; remaining stages NOTSTARTED')
        cap = min(cap, remaining)
        started = time.monotonic()
        print(f'BRE457 final starting {name}; cap={cap}s', flush=True)
        log = evidence / (name + '.log')
        record = {'name': name, 'command': command, 'cwd': str(ROOT), 'hardCapSeconds': cap, 'startedAt': time.time(), 'rawExit': None, 'exitCode': 2}
        manifest['stages'].append(record)
        save()
        with log.open('w') as output:
            child = subprocess.Popen(command, cwd=ROOT, env={**env, 'BRE457_FINAL_STAGE': name, **(extra or {})}, stdout=output, stderr=subprocess.STDOUT, start_new_session=True, close_fds=False)
            record['ownedPidAndPgid'] = child.pid
            try:
                raw = child.wait(timeout=cap)
            except subprocess.TimeoutExpired:
                raw = 124
            finally:
                record['ownedProcessCleanup'] = terminate_owned_group(child)
                if child.poll() is None:
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
        text = log.read_text(errors='replace')
        clean = ANSI.sub('', text)
        code = checked_compile_exit(raw, text) if name in ['lint', 'typecheck', 'build'] else raw
        proof = []
        problems = []
        if name in ['lint', 'typecheck', 'build']:
            data = [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
            for workspace in workspaces:
                if name not in workspace['scripts']:
                    continue
                project = str(ROOT / workspace['path'] / 'tsconfig.json')
                starts = [event for event in data if event.get('stage') == name and event.get('event') == 'start' and event.get('entry') == str(compiler) and event.get('project') == project and event.get('execPath') == str(Path(NODE).resolve())]
                passed = [event for event in data if event.get('stage') == name and event.get('event') == 'exit' and event.get('exitCode') == 0 and any(event.get('pid') == start['pid'] for start in starts)]
                proof.append({'workspace': workspace['name'], 'project': project, 'sourceScript': workspace['scripts'][name], 'compilerStarts': starts, 'successfulExits': passed})
                if not starts or not passed:
                    problems.append('Missing actual successful pinned compiler for ' + workspace['name'])
        elif name == 'test':
            for workspace in workspaces:
                if 'test' in workspace['scripts']:
                    prefix = re.escape(workspace['name']) + r'(?:\s+test:|:test\s+\|)'
                    passed = re.findall(r'(?m)^' + prefix + r'\s+(\d+) pass\b', clean)
                    failed = re.findall(r'(?m)^' + prefix + r'\s+(\d+) fail\b', clean)
                    skipped = re.findall(r'(?m)^' + prefix + r'\s+(\d+) skip\b', clean)
                    proof.append({'workspace': workspace['name'], 'passCounts': passed, 'failCounts': failed, 'skipCounts': skipped})
                    if not passed or not failed or any(int(value) <= 0 for value in passed) or any(int(value) for value in failed):
                        problems.append('Missing successful actual test summary for ' + workspace['name'])
        elif name == 'focused-replay':
            passed = re.findall(r'(?m)^\s*(\d+) pass\b', clean)
            failed = re.findall(r'(?m)^\s*(\d+) fail\b', clean)
            proof.append({'passCounts': passed, 'failCounts': failed, 'expectedTests': 78})
            if passed != ['78'] or failed != ['0']:
                problems.append('Expected actual focused78 summary was not established')
        if record['ownedProcessCleanup'] == 'kill-sent-to-owned-group':
            try:
                os.killpg(child.pid, 0)
                problems.append('Owned process group terminal state not established')
            except ProcessLookupError:
                record['ownedProcessCleanup'] = 'terminated'
        if code == 0 and problems:
            code = 2
        if name == 'build':
            vite_starts = [event for event in data if event.get('stage') == name and event.get('event') == 'start' and event.get('entry') == str(vite) and event.get('args', [])[:1] == ['build'] and event.get('execPath') == str(Path(NODE).resolve())]
            vite_passed = [event for event in data if event.get('stage') == name and event.get('event') == 'exit' and event.get('exitCode') == 0 and any(event.get('pid') == start['pid'] for start in vite_starts)]
            if not vite_starts or not vite_passed or not (ROOT / 'apps/web/dist/index.html').is_file():
                problems.append('Actual successful Vite build/artifact not established')
                if code == 0:
                    code = 2
            record['viteExecutionProof'] = {'starts': vite_starts, 'successfulExits': vite_passed}
            record['retainedBuildArtifacts'] = [{'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size, 'sha256': sha(path)} for path in sorted((ROOT / 'apps/web/dist').rglob('*')) if path.is_file()]
        record.update({'rawExit': raw, 'exitCode': code, 'seconds': time.monotonic() - started, 'logSha256': sha(log), 'executionProof': proof, 'proofProblems': problems, 'usageDetected': bool(USAGE.search(clean))})
        save()
        print(f'BRE457 final finished {name}; raw={raw}; checked={code}', flush=True)
        return code

    try:
        manifest['bun'] = subprocess.check_output([BUN, '--version'], cwd=ROOT, env=env, text=True, timeout=10).strip()
        manifest['node'] = subprocess.check_output([NODE, '--version'], cwd=ROOT, env=env, text=True, timeout=10).strip()
        package = ROOT / 'node_modules/typescript/package.json'
        manifest['compiler'] = {'version': json.loads(package.read_text())['version'], 'entry': str(compiler), 'sha256': sha(compiler), 'implementationSha256': sha(ROOT / 'node_modules/typescript/lib/_tsc.js')}
        if manifest['bun'] != '1.3.14' or manifest['node'] != 'v24.22.1' or manifest['compiler']['version'] != '5.9.3':
            raise RuntimeError('Pinned runtime/compiler version mismatch')
        manifest['configs'] = {item['path']: sha(ROOT / item['path'] / 'tsconfig.json') for item in workspaces if 'typecheck' in item['scripts']}
        old_usage = OLD / 'api-types.log'
        guard = checked_compile_exit(0, old_usage.read_text())
        manifest['usageOnlyRegression'] = {'source': str(old_usage), 'sha256': sha(old_usage), 'rawExit': 0, 'checkedExit': guard}
        if guard != 2 or checked_compile_exit(7, old_usage.read_text()) != 7:
            raise RuntimeError('Usage-only rejection or preservation of real failures broke')
        source_now = source_inputs(expected)
        source_old = source_inputs(DEMO_HEAD)
        manifest['demoSourceEquivalence'] = {'previousHead': DEMO_HEAD, 'sameBlobEntries': source_now == source_old, 'finalInputTreeSha256': hashlib.sha256('\n'.join(source_now).encode()).hexdigest()}
        save()
        phase_exit = 0
        for name, cap in PHASES:
            code = stage(name, [BUN, 'run', '--sequential', '--elide-lines=0', '--filter', '*', '--no-install', '--no-env-file', name], cap, {'BRE457_RECEIPTS': str(evidence / 'full-test-receipts.jsonl')} if name == 'test' else None)
            if code:
                phase_exit = code
                break
        if phase_exit == 0:
            phase_exit = stage('focused-replay', [BUN, 'test', 'apps/api/src/organization/collections-pins/query-results.test.ts', 'apps/api/src/mailbox/read.test.ts', 'packages/shared/src/organization-saved-query-results.test.ts', 'packages/shared/src/organization-collections-pins.test.ts'], FOCUSED_CAP, {'BRE457_RECEIPTS': str(evidence / 'focused-receipts.jsonl')})
        if phase_exit == 0:
            phase_exit = stage('http-work-replay', [BUN, 'docs/verification/bre-457-pin-query/candidate-demo.ts', str(evidence / 'demo-work.json')], DEMO_CAP, {'BRE457_RECEIPTS': str(evidence / 'demo-receipts.jsonl')})
        manifest['focusedAndDemoPolicy'] = 'ROOT current-main97 integration; six new current-source stages, old f232/bfd evidence remains historical'
        manifest['overallExit'] = phase_exit
    except BaseException as error:
        manifest['error'] = {'type': type(error).__name__, 'message': str(error)}
        manifest['overallExit'] = 2
    finally:
        # Only this driver's newly created temp root; evidence/build outputs stay.
        try:
            shutil.rmtree(owned_tmp)
        except OSError as error:
            manifest['cleanupError'] = str(error)
            manifest['overallExit'] = 2
        manifest['ownedTmpRemoved'] = not owned_tmp.exists()
        try:
            manifest['endSHA'] = git('rev-parse', 'HEAD')
            manifest['endStatus'] = git('status', '--porcelain')
        except BaseException as error:
            manifest['endStateError'] = str(error)
            manifest['endSHA'] = None
            manifest['endStatus'] = 'not established'
        manifest['finishedAt'] = time.time()
        if manifest['endSHA'] != expected or manifest['endStatus']:
            manifest['overallExit'] = 2
        manifest['notStarted'] = [name for name in ['lint','typecheck','test','build','focused-replay','http-work-replay'] if name not in [stage['name'] for stage in manifest['stages']]]
        manifest['observerSha256'] = sha(observer)
        manifest['nodeExecutionEventsSha256'] = sha(events) if events.exists() else None
        save()
        print('BRE457 final evidence: ' + str(evidence), flush=True)
    return manifest['overallExit']


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise InterruptedError(f'Final runner interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
