#!/usr/bin/env python3
"""SOURCE-ONLY PREPARATION. One ROOT-allocated full workspace gate; no focused/demo replay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

ROOT = Path('/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829')
HEAD = '3de619ce8a92dc52182638fe5ba94de5ac63f380'
BRANCH = 't3/bre-457-query-importance-read'
APPROVED_INPUTS = Path('/tmp/bre457-query-importance-full-3de619ce-inputs.json')
INPUTS_SHA256 = '8f041696907ea71bce6e6eb556d73aa23a63131c274c612dee030b98225fdff8'
WRAPPER = Path('/tmp/orca-ui-heavy-slot.py')
WRAPPER_SHA256 = 'e29f82749105f0fee6535fc4c510b7a3b529c3be7f51f9d6f5930e58ba3f15a8'
BUN = Path('/opt/homebrew/bin/bun')
NODE = Path('/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
TSC = ROOT / 'node_modules/typescript/bin/tsc'
VITE = ROOT / 'node_modules/vite/bin/vite.js'
EXPECTED_TOOL_FILES = {'/opt/homebrew/bin/bun': 'fb46ac6497104821512b67a3b3157c9fbbab8a99e311fb38da5b7039a373d860', '/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node': '4f0f73aa8c10cbf8f5caa825488203f1049ee08c76e70067678dde1cdf1160ea', '/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829/node_modules/typescript/bin/tsc': '8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0', '/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829/node_modules/typescript/lib/_tsc.js': 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419', '/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829/node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6', '/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829/node_modules/vite/bin/vite.js': 'fa03478846d229651a3c6aa64833ba2c6cbf580a798b92bd8f47c7480bafb5d8', '/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829/node_modules/vite/package.json': 'e5ed0f85215f871fe22a48987dcd77fcfbe14064a53c0c9f7f48186a6b7e2cf0'}
PHASES = [('lint', 120), ('typecheck', 120), ('test', 300), ('build', 180)]
GLOBAL_WORK_SECONDS = 600
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
USAGE = re.compile(r'(?im)^(?:[^\n]*?(?::\w+\s*\||\s+\w+:)\s*)?(?:Usage:\s*(?:bun|tsc)\b|tsc: The TypeScript Compiler)')
OBSERVER = r'''const fs=require('node:fs'),path=require('node:path');let entry;
try{entry=fs.realpathSync(process.argv[1]);}catch{return;}
if(![process.env.BRE457_FULL_TSC,process.env.BRE457_FULL_VITE].includes(entry))return;
const args=process.argv.slice(2);const ix=args.findIndex(x=>x==='-p'||x==='--project');
const project=ix>=0&&args[ix+1]?path.resolve(process.cwd(),args[ix+1]):null;
const base={pid:process.pid,entry,execPath:fs.realpathSync(process.execPath),cwd:process.cwd(),args,project,stage:process.env.BRE457_FULL_STAGE};
function emit(event){fs.appendFileSync(process.env.BRE457_FULL_EVENTS,JSON.stringify({...base,...event})+'\n');}
emit({event:'start'});process.on('exit',code=>emit({event:'exit',exitCode:code}));'''


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, timeout=10)


def git_text(*args):
    return git(*args).decode().strip()


def source_snapshot(approved):
    if git_text('rev-parse', 'HEAD') != HEAD or git_text('branch', '--show-current') != BRANCH or git_text('status', '--porcelain'):
        raise RuntimeError('Exact clean frozen branch/head not established')
    raw = git('ls-tree', '-r', '-z', HEAD)
    if hashlib.sha256(raw).hexdigest() != approved['gitTreeEntriesSha256']:
        raise RuntimeError('Git tree inventory mismatch')
    records = []
    for item in approved['files']:
        path = ROOT / item['path']
        data = os.fsencode(os.readlink(path)) if item['gitMode'] == '120000' else path.read_bytes()
        blob = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        digest = hashlib.sha256(data).hexdigest()
        if blob != item['gitBlob'] or digest != item['sha256'] or len(data) != item['bytes']:
            raise RuntimeError('Working-file drift: ' + item['path'])
        records.append({**item, 'observedSHA256': digest})
    listed = set(os.fsdecode(value) for value in git('ls-files', '-z').rstrip(b'\0').split(b'\0'))
    if listed != {item['path'] for item in approved['files']}:
        raise RuntimeError('Tracked path/index set drift')
    return dict(head=HEAD, tree=approved['tree'], status='', files=records, observedAt=time.time())


def workspace_summaries(raw_text, workspaces):
    # Accept only the two observed Bun workspace prefix forms, then require one
    # complete nonzero pass/expect/Ran summary for every workspace test script.
    text = ANSI.sub('', raw_text)
    proof = []
    for workspace in workspaces:
        if 'test' not in workspace['scripts']:
            continue
        name = workspace['name']
        prefix = re.compile(r'^' + re.escape(name) + r'(?::test\s+\||\s+test:)\s?(.*)$')
        content = [match.group(1).strip() for line in text.splitlines() if (match := prefix.match(line))]
        counts = {}
        for label in ['pass', 'fail', 'skip', 'todo', 'expect() calls']:
            values = [int(match.group(1)) for line in content if (match := re.fullmatch(r'(\d+) ' + re.escape(label), line))]
            if label in ['skip', 'todo'] and not values:
                counts[label] = 0
            elif len(values) == 1:
                counts[label] = values[0]
            else:
                raise RuntimeError(f'Incomplete/duplicate {label} summary for {name}: {values}')
        ran = [match for line in content if (match := re.fullmatch(r'Ran (\d+) tests across (\d+) files\.(?:\s+\[[^\]]+\])?', line))]
        if len(ran) != 1 or counts['pass'] <= 0 or counts['expect() calls'] <= 0 or any(counts[label] for label in ['fail', 'skip', 'todo']):
            raise RuntimeError('Nonzero complete zero-fail test proof absent for ' + name)
        run_count, file_count = map(int, ran[0].groups())
        if run_count != counts['pass'] or file_count <= 0:
            raise RuntimeError('Ran/pass/file summary inconsistent for ' + name)
        proof.append(dict(workspace=name, passed=counts['pass'], failed=counts['fail'], skipped=counts['skip'], todo=counts['todo'], expectCalls=counts['expect() calls'], ran=run_count, files=file_count))
    if not proof:
        raise RuntimeError('No runnable workspace test proof')
    return proof


def processes():
    rows = {}
    raw = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid=,lstart=,command='], text=True, timeout=5)
    for line in raw.splitlines():
        fields = line.split(None, 8)
        if len(fields) == 9:
            rows[int(fields[0])] = dict(pid=int(fields[0]), ppid=int(fields[1]), pgid=int(fields[2]), birth=' '.join(fields[3:8]), commandSHA256=hashlib.sha256(fields[8].encode()).hexdigest())
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head', required=True)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.head != HEAD:
        raise SystemExit('NOT STARTED: only the exact ROOT-frozen 3de head is permitted')
    if sha(APPROVED_INPUTS) != INPUTS_SHA256 or sha(WRAPPER) != WRAPPER_SHA256:
        raise SystemExit('NOT STARTED: source-inventory/shared-wrapper identity changed')
    for path, expected in EXPECTED_TOOL_FILES.items():
        if sha(path) != expected:
            raise SystemExit('NOT STARTED: pinned execution tool file changed: ' + path)
    approved = json.loads(APPROVED_INPUTS.read_text())
    start_inputs = source_snapshot(approved)
    workspaces = approved['workspaces']
    for directory in [ROOT, *(ROOT / row['path'] for row in workspaces)]:
        for name in ['.env', '.env.local', '.env.test', '.env.test.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']:
            if (directory / name).exists():
                raise SystemExit('NOT STARTED: refusing automatic environment file ' + str(directory / name))
    lock_stat = Path('/tmp/orca-ui-heavy-slot.lock').stat()
    inherited = []
    for item in Path('/dev/fd').iterdir():
        try:
            fd = int(item.name)
            info = os.fstat(fd)
            if fd > 2 and (info.st_dev, info.st_ino) == (lock_stat.st_dev, lock_stat.st_ino):
                inherited.append(fd)
        except (ValueError, OSError):
            pass
    if not inherited:
        raise SystemExit('NOT STARTED: mandatory actual heavy-wrapper inherited lock FD missing')
    out = args.output.resolve()
    if out.exists() or out == ROOT or ROOT in out.parents or any(char.isspace() for char in str(out)):
        raise SystemExit('NOT STARTED: new external evidence directory without whitespace required')
    out.mkdir()
    owned_tmp = out / 'owned-temp'
    owned_tmp.mkdir()
    (out / 'inputs-approved.json').write_bytes(APPROVED_INPUTS.read_bytes())
    (out / 'inputs-start.json').write_text(json.dumps(start_inputs, indent=2) + '\n')
    observer = out / 'compiler-observer.cjs'
    observer.write_text(OBSERVER)
    events_path = out / 'compiler-events.jsonl'
    manifest = dict(kind='Four sequential full workspace stages ONLY; no standalone focused/control/demo repetition',
        startSHA=HEAD, startStatus='', driver=dict(path=str(Path(__file__).resolve()), sha256=sha(__file__)),
        sourceInventorySHA256=INPUTS_SHA256, trackedInputCount=len(approved['files']),
        wrapperSHA256=WRAPPER_SHA256, inheritedWrapperLockFds=inherited, toolFileHashes=EXPECTED_TOOL_FILES,
        workspaces=workspaces, stages=[], metadataCommands=[], overallExit=2, startedAt=time.time(),
        workCapSeconds=GLOBAL_WORK_SECONDS, requestedOuterSeconds=620, sourceOnlyTestCountEstimate=2404,
        actualCountsAuthoritative=True, cancellationInjectionTested=False,
        previousFocusedTypeDemoEvidence='/tmp/bre457-query-importance-candidate-3de619ce-01',
        claimLimits=['callbackMs in prior demo includes fixture observers; RSS snapshots are process-wide, not peaks/route allocations',
            'No speedup/DB/VM/memory bound/native/all33/deployment claim',
            'Full nested tombstone/mixed inherited votes/opposite sender preferences and continuation/empty work remain coverage gaps'])
    env = {key: os.environ[key] for key in ['HOME', 'USER', 'LOGNAME', 'SHELL'] if key in os.environ}
    env.update(PATH=str(NODE.parent) + ':/opt/homebrew/bin:/usr/bin:/bin', TMPDIR=str(owned_tmp), CI='true', NO_COLOR='1', TERM='dumb', LANG='en_US.UTF-8',
        BRE457_QUERY_STAGE='candidate', BRE457_IMPORTANCE_STAGE='extension', BRE457_IMPORTANCE_SCRATCH=str(owned_tmp / 'importance'),
        NODE_OPTIONS='--require=' + str(observer), BRE457_FULL_TSC=str(TSC.resolve()), BRE457_FULL_VITE=str(VITE.resolve()), BRE457_FULL_EVENTS=str(events_path))
    child = None
    owned = {}
    groups = set()
    phase = 'idle'
    pending = None
    began = time.monotonic()
    deadline = began + GLOBAL_WORK_SECONDS

    def save():
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    def track():
        rows = processes()
        known = {pid for pid, record in owned.items() if rows.get(pid, {}).get('birth') == record['birth'] and rows.get(pid, {}).get('commandSHA256') == record['commandSHA256']}
        active_groups = {rows[pid]['pgid'] for pid in known}
        if child:
            active_groups.add(child.pid)
        groups.intersection_update(active_groups)
        if child:
            known.add(child.pid)
        known.update(pid for pid, row in rows.items() if row['pgid'] in groups)
        while True:
            more = {pid for pid, row in rows.items() if row['ppid'] in known}
            if more <= known:
                break
            known |= more
        for pid in known:
            if pid in rows:
                owned[pid] = rows[pid]
                groups.add(rows[pid]['pgid'])
        return {pid: row for pid, row in rows.items() if pid in owned and row['birth'] == owned[pid]['birth'] and row['commandSHA256'] == owned[pid]['commandSHA256']}

    def cleanup():
        nonlocal phase
        phase = 'cleanup'
        for sig, grace in [(signal.SIGTERM, 2), (signal.SIGKILL, .5)]:
            live = track()
            if not live:
                break
            for group in list(groups):
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
            raise InterruptedError(f'Owned full gate interrupted by {pending}')

    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, stop)

    def owned_command(name, command, cap, bucket, extra=None):
        nonlocal child, phase
        if pending is not None:
            raise InterruptedError('Interruption pending before next command')
        if time.monotonic() >= deadline:
            raise TimeoutError('Global work cap reached; no further stage started')
        start = time.monotonic()
        limit = min(deadline, start + cap)
        log = out / (name + '.log')
        record = dict(name=name, command=command, cwd=str(ROOT), hardCapSeconds=cap, effectiveHardCapSeconds=limit-start, rawExit=None, checkedExit=2, startedAt=time.time())
        bucket.append(record)
        save()
        failure = None
        code = None
        print(f'BRE457 full START {name}; cap={cap}s', flush=True)
        try:
            with log.open('wb') as output:
                phase = 'starting'
                child = subprocess.Popen(command, cwd=ROOT, env={**env, 'BRE457_FULL_STAGE': name, **(extra or {})}, stdout=output, stderr=subprocess.STDOUT, start_new_session=True, pass_fds=tuple(inherited))
                groups.add(child.pid)
                record['ownedPidAndPgid'] = child.pid
                phase = 'waiting'
                track()
                if pending is not None:
                    raise InterruptedError('Interruption during process start')
                next_progress = start + 15
                while child.poll() is None:
                    track()
                    now = time.monotonic()
                    if now >= limit:
                        raise TimeoutError(f'{name} hard cap reached; timeout is not a pass')
                    if now >= next_progress:
                        print(f'BRE457 full {name} elapsed={now-start:.1f}s ownedPid={child.pid}', flush=True)
                        next_progress = now + 15
                    time.sleep(.2)
                code = child.returncode
        except BaseException as error:
            failure = error
            record['executionFailure'] = dict(type=type(error).__name__, message=str(error))
        finally:
            remaining = cleanup()
            record.update(rawExit=code, childReturnAfterCleanup=child.returncode if child else None,
                elapsedSeconds=time.monotonic()-start, ownedRemaining=list(remaining.values()), logSHA256=sha(log) if log.exists() else None)
            if remaining:
                record['cleanupFailure'] = True
            save()
        if failure is not None:
            raise failure
        if remaining:
            raise RuntimeError('Owned descendants remain after ' + name)
        return record, log.read_text(errors='backslashreplace')

    def compile_proof(name):
        events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
        proof = []
        for workspace in workspaces:
            if name not in workspace['scripts']:
                continue
            project = str(ROOT / workspace['path'] / 'tsconfig.json')
            starts = [row for row in events if row.get('stage') == name and row.get('event') == 'start' and row.get('entry') == str(TSC.resolve()) and row.get('execPath') == str(NODE.resolve()) and row.get('project') == project]
            exits = [row for row in events if row.get('stage') == name and row.get('event') == 'exit' and row.get('exitCode') == 0 and any(row.get('pid') == start['pid'] for start in starts)]
            proof.append(dict(workspace=workspace['name'], script=workspace['scripts'][name], project=project, starts=starts, successfulExits=exits))
            if len(starts) != 1 or len(exits) != 1:
                raise RuntimeError('Actual successful pinned project compiler witness absent/ambiguous: ' + workspace['name'])
        if not proof:
            raise RuntimeError('No compiler execution witnesses')
        return proof

    try:
        save()
        for name, command, expected in [('bun-version', [str(BUN), '--version'], '1.3.14'), ('node-version', [str(NODE), '--version'], 'v24.22.1')]:
            record, text = owned_command(name, command, 10, manifest['metadataCommands'])
            if record['rawExit'] != 0 or text.strip() != expected:
                raise RuntimeError('Pinned runtime version check failed: ' + name)
            record['checkedExit'] = 0
            manifest[name] = text.strip()
        compiler_package = ROOT / 'node_modules/typescript/package.json'
        manifest['compiler'] = dict(version=json.loads(compiler_package.read_text())['version'], entry=str(TSC.resolve()), entrySHA256=sha(TSC), implementationSHA256=sha(TSC.parent.parent / 'lib/_tsc.js'))
        if manifest['compiler']['version'] != '5.9.3':
            raise RuntimeError('TypeScript version mismatch')
        for name, cap in PHASES:
            source_snapshot(approved)
            command = [str(BUN), 'run', '--sequential', '--elide-lines=0', '--filter', '*', '--no-install', '--no-env-file', name]
            extra = {'BRE457_IMPORTANCE_RECEIPTS': str(out / 'full-importance-receipts.jsonl'), 'BRE457_RECEIPTS': str(out / 'full-saved-query-receipts.jsonl')} if name == 'test' else None
            record, text = owned_command(name, command, cap, manifest['stages'], extra)
            problems = []
            checked = record['rawExit'] if record['rawExit'] is not None else 2
            try:
                record['usageDetected'] = bool(USAGE.search(ANSI.sub('', text)))
                if record['rawExit'] != 0:
                    raise RuntimeError('Actual stage exit nonzero')
                if name in ['lint', 'typecheck', 'build']:
                    if record['usageDetected']:
                        raise RuntimeError('Usage-only compiler/Bun output rejected even with raw0')
                    record['compilerWitnesses'] = compile_proof(name)
                else:
                    record['workspaceTestSummaries'] = workspace_summaries(text, workspaces)
                    manifest['actualWorkspaceTestCounts'] = dict(passed=sum(row['passed'] for row in record['workspaceTestSummaries']), failed=sum(row['failed'] for row in record['workspaceTestSummaries']), expectCalls=sum(row['expectCalls'] for row in record['workspaceTestSummaries']))
                    manifest['sourceEstimateDelta'] = manifest['actualWorkspaceTestCounts']['passed'] - 2404
                if name == 'build':
                    events = [json.loads(line) for line in events_path.read_text().splitlines()]
                    starts = [row for row in events if row.get('stage') == name and row.get('event') == 'start' and row.get('entry') == str(VITE.resolve()) and row.get('execPath') == str(NODE.resolve()) and row.get('args') == ['build'] and row.get('cwd') == str(ROOT / 'apps/web')]
                    exits = [row for row in events if row.get('stage') == name and row.get('event') == 'exit' and row.get('exitCode') == 0 and any(row.get('pid') == start['pid'] for start in starts)]
                    if len(starts) != 1 or len(exits) != 1 or not (ROOT / 'apps/web/dist/index.html').is_file():
                        raise RuntimeError('Actual successful Vite build/artifact witness absent')
                    record['viteWitnesses'] = dict(starts=starts, successfulExits=exits)
                    record['buildArtifacts'] = [dict(path=str(path.relative_to(ROOT)), bytes=path.stat().st_size, sha256=sha(path)) for path in sorted((ROOT / 'apps/web/dist').rglob('*')) if path.is_file()]
                source_snapshot(approved)
            except BaseException as error:
                problems.append(dict(type=type(error).__name__, message=str(error)))
                if checked == 0:
                    checked = 2
            record.update(checkedExit=checked, proofProblems=problems)
            save()
            print(f'BRE457 full END {name}; raw={record["rawExit"]} checked={checked} actualSeconds={record["elapsedSeconds"]:.3f}', flush=True)
            if checked != 0:
                raise RuntimeError('Stop first stage failure: ' + name)
        manifest['overallExit'] = 0
    except BaseException as error:
        manifest['error'] = dict(type=type(error).__name__, message=str(error))
    finally:
        try:
            remaining = cleanup()
            manifest['ownedRemaining'] = list(remaining.values())
            if remaining:
                manifest['overallExit'] = 2
        except BaseException as error:
            manifest.update(overallExit=2, ownedRemaining='UNOBSERVED', processCleanupError=repr(error))
        manifest['ownedProcesses'] = list(owned.values())
        try:
            shutil.rmtree(owned_tmp)
            manifest['ownedTmpRemoved'] = not owned_tmp.exists()
        except OSError as error:
            manifest.update(overallExit=2, ownedTmpRemoved=False, tempCleanupError=str(error))
        try:
            end_inputs = source_snapshot(approved)
            (out / 'inputs-end.json').write_text(json.dumps(end_inputs, indent=2) + '\n')
            manifest.update(endSHA=end_inputs['head'], endStatus=end_inputs['status'], allTrackedInputHashesEqual=True)
        except BaseException as error:
            manifest.update(overallExit=2, endStateError=repr(error), allTrackedInputHashesEqual=False)
            try:
                manifest.update(endSHA=git_text('rev-parse', 'HEAD'), endStatus=git_text('status', '--porcelain'))
            except BaseException as git_error:
                manifest.update(endSHA=None, endStatus='UNOBSERVED', endGitError=repr(git_error))
        if pending is not None:
            manifest['overallExit'] = 128 + pending
        manifest.update(finishedAt=time.time(), elapsedSeconds=time.monotonic()-began,
            notStarted=[name for name, _ in PHASES if name not in [row['name'] for row in manifest['stages']]])
        manifest['artifacts'] = [dict(path=str(path.relative_to(out)), bytes=path.stat().st_size, sha256=sha(path)) for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'manifest.json']
        save()
        print(json.dumps(dict(state='TERMINAL', exit=manifest['overallExit'], head=manifest.get('endSHA'), dirty=manifest.get('endStatus'), ownedRemaining=manifest.get('ownedRemaining'), out=str(out))), flush=True)
    return manifest['overallExit']


if __name__ == '__main__':
    raise SystemExit(main())
