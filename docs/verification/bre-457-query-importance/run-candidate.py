#!/usr/bin/env python3
"""PREPARED SOURCE ONLY. Requires an explicit ROOT allocation and exact frozen head."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import shutil

ROOT = Path(__file__).resolve().parents[3]
BASE = 'a19a3bba31805d56263851cc800f8267e95db7b3'
BRANCH = 't3/bre-457-query-importance-read'
BUN = '/opt/homebrew/bin/bun'
NODE = '/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
TSC = ROOT / 'node_modules/typescript/bin/tsc'
TEST = 'apps/api/src/organization/collections-pins/query-importance-baseline.test.ts'
FOCUSED = [
    'apps/api/src/organization/collections-pins/query-results.test.ts',
    'apps/api/src/mailbox/read.test.ts',
    'packages/shared/src/organization-saved-query-results.test.ts',
    'packages/shared/src/organization-collections-pins.test.ts', TEST,
    'apps/api/src/organization/collections-pins/query-importance-candidate.test.ts',
]
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
USAGE = re.compile(r'(?im)^\s*(?:Usage: (?:bun|tsc)|tsc: The TypeScript Compiler)')
OBSERVER = '''const fs=require('node:fs');let entry;try{entry=fs.realpathSync(process.argv[1]);}catch{return;}
if(entry!==process.env.BRE457_TSC_ENTRY)return;
const a=process.argv.slice(2),i=a.indexOf('--project');if(i<0)return;
const base={pid:process.pid,entry,execPath:fs.realpathSync(process.execPath),project:a[i+1],args:a,stage:process.env.BRE457_IMPORTANCE_GATE_STAGE};
function record(event){fs.appendFileSync(process.env.BRE457_COMPILER_EVENTS,JSON.stringify({...base,...event})+'\\n');}
record({event:'start'});process.on('exit',code=>record({event:'exit',exitCode:code}));'''


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, timeout=5).strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def processes():
    rows = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,command='], text=True, timeout=5).splitlines():
        parts = line.split(None, 8)
        if len(parts) == 9:
            rows[int(parts[0])] = dict(pid=int(parts[0]), ppid=int(parts[1]), pgid=int(parts[2]), birth=' '.join(parts[3:8]), commandSHA256=hashlib.sha256(parts[8].encode()).hexdigest())
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head', required=True)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    out = args.output.resolve()
    assert git('rev-parse', 'HEAD') == args.head and not git('status', '--porcelain'), 'Exact clean frozen HEAD required'
    assert git('branch', '--show-current') == BRANCH and git('merge-base', BASE, args.head) == BASE
    assert not git('diff', BASE, args.head, '--', TEST), 'Original five assertions/control test must remain byte-identical'
    for directory in [ROOT, ROOT / 'apps/api', ROOT / 'packages/shared']:
        assert not any((directory / name).exists() for name in ['.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']), f'No automatic environment files: {directory}'
    slot = Path('/tmp/orca-ui-heavy-slot.lock').stat()
    fds = []
    for item in Path('/dev/fd').iterdir():
        try:
            fd = int(item.name)
            stat = os.fstat(fd)
            if fd > 2 and (stat.st_dev, stat.st_ino) == (slot.st_dev, slot.st_ino):
                fds.append(fd)
        except (ValueError, OSError):
            pass
    assert fds, 'Shared wrapper inherited lock FD required'
    assert not out.exists() and out != ROOT and ROOT not in out.parents and not any(char.isspace() for char in str(out))
    out.mkdir()
    scratch = out / 'owned-scratch'
    scratch.mkdir()
    observer = out / 'compiler-observer.cjs'
    observer.write_text(OBSERVER)
    tracked = sorted(git('ls-files').splitlines())
    before = {path: sha(ROOT / path) for path in tracked}
    manifest = dict(testedHead=args.head, baselineRed=BASE, stages=[], overallExit=2,
        driverSha256=sha(__file__), beforeFileSHA256=before, startedAt=time.time(),
        cancellationInjectionTested=False, kind='focused candidate + actual project compilers + finite Hono/SQLite metadata demo; no full workspace/native acceptance')
    env = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM'] if key in os.environ}
    env.update(PATH=str(Path(NODE).parent) + ':/opt/homebrew/bin:/usr/bin:/bin', TMPDIR=str(scratch), LANG='en_US.UTF-8', CI='true',
        BRE457_TSC_ENTRY=str(TSC.resolve()), BRE457_COMPILER_EVENTS=str(out / 'compiler-events.jsonl'), NODE_OPTIONS='--require=' + str(observer),
        BRE457_IMPORTANCE_SCRATCH=str(scratch), BRE457_QUERY_STAGE='candidate', BRE457_METADATA_PYTHON=sys.executable)
    child = None
    owned = {}
    groups = set()
    phase = 'idle'
    pending = None
    deadline = time.monotonic() + 210

    def save():
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    def track():
        rows = processes()
        known = {pid for pid, record in owned.items() if rows.get(pid, {}).get('birth') == record['birth']}
        active_groups = {rows[pid]['pgid'] for pid in known}
        if child:
            active_groups.add(child.pid)  # Retain this explicitly created group after coordinator exit.
        groups.intersection_update(active_groups)
        if child:
            known.add(child.pid)
        known.update(pid for pid, record in rows.items() if record['pgid'] in groups)
        while True:
            more = {pid for pid, record in rows.items() if record['ppid'] in known}
            if more <= known:
                break
            known |= more
        for pid in known:
            if pid in rows:
                owned[pid] = rows[pid]
                groups.add(rows[pid]['pgid'])
        return {pid: record for pid, record in rows.items() if pid in owned and record['birth'] == owned[pid]['birth'] and record['commandSHA256'] == owned[pid]['commandSHA256']}

    def cleanup():
        nonlocal phase
        phase = 'cleanup'
        for sig, grace in [(signal.SIGTERM, 2), (signal.SIGKILL, .5)]:
            live = track()
            if not live:
                break
            for group in groups:
                if group != os.getpgrp() and any(row['pgid'] == group for row in live.values()):
                    try:
                        os.killpg(group, sig)
                    except ProcessLookupError:
                        pass
            until = time.monotonic() + grace
            while time.monotonic() < until and track():
                time.sleep(.05)
        if child:
            try:
                child.wait(timeout=.3)
            except subprocess.TimeoutExpired:
                pass
        return track()

    def stop(sig, _frame):
        nonlocal pending, phase
        if pending is None:
            pending = sig
        if phase == 'waiting':
            phase = 'cleanup'
            raise InterruptedError(f'Owned candidate interrupted by {pending}')

    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, stop)

    def stage(name, command, cap, extra=None, expected_tests=None, project=None):
        nonlocal child, phase
        assert git('rev-parse', 'HEAD') == args.head and not git('status', '--porcelain')
        assert {path: sha(ROOT / path) for path in tracked} == before, 'Source changed between stages'
        start = time.monotonic()
        limit = min(deadline, start + cap)
        log_path = out / (name + '.log')
        record = dict(name=name, command=command, hardCapSeconds=cap)
        manifest['stages'].append(record)
        save()
        print(f'BRE457 importance START {name} cap={cap}s', flush=True)
        code = None
        try:
            with log_path.open('wb') as log:
                phase = 'starting'
                child = subprocess.Popen(command, cwd=ROOT, env={**env, 'BRE457_IMPORTANCE_GATE_STAGE': name, **(extra or {})}, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, pass_fds=tuple(fds))
                groups.add(child.pid)
                track()
                phase = 'waiting'
                if pending is not None:
                    raise InterruptedError('Interrupted before stage wait')
                next_progress = start + 15
                while child.poll() is None:
                    track()
                    if time.monotonic() >= limit:
                        raise TimeoutError(f'{name} cap; no pass or product-red claim')
                    if time.monotonic() >= next_progress:
                        print(f'BRE457 importance {name} elapsed={time.monotonic()-start:.1f}s ownedPid={child.pid}', flush=True)
                        next_progress += 15
                    time.sleep(.2)
                code = child.returncode
        finally:
            remaining = cleanup()
            record.update(rawExit=code, seconds=time.monotonic()-start, ownedRemaining=list(remaining.values()), logSha256=sha(log_path) if log_path.exists() else None)
            save()
        text = ANSI.sub('', log_path.read_text(errors='replace'))
        checked = code if code is not None else 2
        if code == 0 and (USAGE.search(text) or remaining):
            checked = 2
        if expected_tests is not None:
            passes = re.findall(r'^\s*(\d+) pass\s*$', text, re.M)
            fails = re.findall(r'^\s*(\d+) fail\s*$', text, re.M)
            record['testSummary'] = dict(passes=passes, fails=fails)
            if passes != [str(expected_tests)] or fails != ['0']:
                checked = 2
        if project is not None:
            events = [json.loads(line) for line in Path(env['BRE457_COMPILER_EVENTS']).read_text().splitlines()] if Path(env['BRE457_COMPILER_EVENTS']).exists() else []
            events = [event for event in events if event.get('stage') == name]
            record['actualCompilerEvents'] = events
            starts = [event for event in events if event['event'] == 'start' and event['project'] == str(project) and event['entry'] == str(TSC.resolve()) and event['execPath'] == str(Path(NODE).resolve())]
            if len(starts) != 1 or not any(event['event'] == 'exit' and event['exitCode'] == 0 and event['pid'] == starts[0]['pid'] for event in events):
                checked = 2
        record['checkedExit'] = checked
        save()
        print(f'BRE457 importance END {name} raw={code} checked={checked} actualSeconds={record["seconds"]:.3f}', flush=True)
        if checked != 0:
            raise RuntimeError(f'Stop first nonzero: {name} raw={code} checked={checked}; inspect retained log')

    try:
        manifest['bun'] = subprocess.check_output([BUN, '--version'], env=env, text=True, timeout=5).strip()
        manifest['node'] = subprocess.check_output([NODE, '--version'], env=env, text=True, timeout=5).strip()
        manifest['compiler'] = dict(version=subprocess.check_output([NODE, str(TSC), '--version'], env=env, text=True, timeout=5).strip(), entry=str(TSC.resolve()), sha256=sha(TSC), implementationSha256=sha(TSC.parent.parent / 'lib/_tsc.js'))
        assert (manifest['bun'], manifest['node'], manifest['compiler']['version']) == ('1.3.14', 'v24.22.1', 'Version 5.9.3')
        stage('controls', [BUN, 'test', TEST, '--timeout', '15000'], 30, {'BRE457_IMPORTANCE_STAGE': 'controls', 'BRE457_IMPORTANCE_RECEIPTS': str(out / 'controls.jsonl')}, expected_tests=1)
        stage('focused', [BUN, 'test', *FOCUSED, '--timeout', '15000'], 90,
            {'BRE457_IMPORTANCE_STAGE': 'extension', 'BRE457_IMPORTANCE_RECEIPTS': str(out / 'candidate.jsonl'), 'BRE457_RECEIPTS': str(out / 'original78.jsonl')}, expected_tests=106)
        for workspace, cap in [('packages/shared', 30), ('apps/api', 60)]:
            project = ROOT / workspace / 'tsconfig.json'
            stage('shared-types' if workspace == 'packages/shared' else 'api-types', [NODE, str(TSC), '--project', str(project)], cap, project=project)
        stage('metadata-demo', [BUN, 'docs/verification/bre-457-query-importance/candidate-demo.ts', str(out / 'demo.json')], 30,
            {'BRE457_IMPORTANCE_STAGE': 'demo', 'BRE457_IMPORTANCE_RECEIPTS': str(out / 'demo.jsonl')})
        assert json.loads((out / 'demo.json').read_text())['rounds'] == 3
        for profile in ['dense', 'sparse']:
            actual = json.loads((out / (profile + '-metadata-work.json')).read_text())
            assert actual['actualBatchSelects'] == 2 and actual['connectionTotalChanges'] == 0
        manifest['overallExit'] = 0
    except BaseException as error:
        manifest['error'] = repr(error)
    finally:
        remaining = cleanup()
        manifest.update(finalHead=git('rev-parse', 'HEAD'), finalStatus=git('status', '--porcelain'), endingFileSHA256={path: sha(ROOT / path) for path in tracked}, ownedProcesses=list(owned.values()), ownedRemaining=list(remaining.values()), finishedAt=time.time())
        shutil.rmtree(scratch)
        manifest['ownedScratchRemoved'] = not scratch.exists()
        if pending is not None:
            manifest['overallExit'] = 128 + pending
        if manifest['finalHead'] != args.head or manifest['finalStatus'] or manifest['endingFileSHA256'] != before or sorted(git('ls-files').splitlines()) != tracked or remaining:
            manifest['overallExit'] = 2
            manifest['sourceOrCleanupFailure'] = True
        manifest['artifacts'] = [dict(path=str(path.relative_to(out)), bytes=path.stat().st_size, sha256=sha(path)) for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'manifest.json']
        save()
        print(json.dumps(dict(state='TERMINAL', exit=manifest['overallExit'], head=manifest['finalHead'], dirty=manifest['finalStatus'], ownedRemaining=manifest['ownedRemaining'], out=str(out))), flush=True)
    return manifest['overallExit']


if __name__ == '__main__':
    raise SystemExit(main())
