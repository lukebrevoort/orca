#!/usr/bin/env python3
"""Run Orca's existing compose proof from committed source in disposable storage."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def doctor():
    versions = {}
    for tool in ('bun', 'node', 'git'):
        if not shutil.which(tool):
            raise ValueError(f'Missing {tool}; see docs/pstack/README.md prerequisites')
        versions[tool] = subprocess.check_output([tool, '--version'], text=True).strip()
    if versions['bun'] != '1.3.14' or not versions['node'].startswith('v24.'):
        raise ValueError('Requires Bun 1.3.14 and Node 24; no runtime is installed automatically')
    for relative in ('node_modules/playwright/package.json', 'node_modules/.bin/vite'):
        if not (ROOT / relative).exists():
            raise ValueError('Missing locked dependencies; run bun install --frozen-lockfile separately')
    if json.loads((ROOT / 'node_modules/playwright/package.json').read_text())['version'] != '1.62.1':
        raise ValueError('Expected locked Playwright 1.62.1')
    browser = os.environ.get('ORCA_CHROMIUM_EXECUTABLE')
    if not browser:
        browser = subprocess.check_output(['node', '--input-type=module', '-e',
            'import {chromium} from "playwright"; console.log(chromium.executablePath())'], cwd=ROOT, text=True).strip()
    browser = str(Path(browser).resolve())
    if not os.access(browser, os.X_OK):
        raise ValueError('Chromium missing; install the locked Playwright browser separately or set ORCA_CHROMIUM_EXECUTABLE')
    versions.update(chromiumExecutable=browser, testedCommit=git('rev-parse', 'HEAD'),
                    lockSha256=digest(ROOT / 'bun.lock'), python=sys.version.split()[0])
    return versions


def stop(process):
    if process is not None:
        # Every child owns a new session. Never kill by name or a caller-supplied PID.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)


def run(command, cwd, env, log, timeout=240):
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=timeout)
        if code:
            raise ValueError(f'{command[0]} command failed with exit code {code}; see checks.log')
    finally:
        stop(process)


def snapshot(destination):
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['git', '-C', str(ROOT), 'archive', 'HEAD'], stdout=archive, check=True)
        archive.seek(0)
        subprocess.run(['tar', '-xf', '-', '-C', str(destination)], stdin=archive, check=True)
    # Copy the installed dependency tree, preserving relative workspace links so
    # @orca/shared resolves to the archived source, never the author's checkout.
    for relative in ('node_modules', 'apps/web/node_modules'):
        source = ROOT / relative
        if source.exists():
            shutil.copytree(source, destination / relative, symlinks=True)
    for path in destination.rglob('.env*'):
        if path.name != '.env.example' and 'node_modules' not in path.parts:
            raise ValueError('Committed local environment file is forbidden in the fixture archive')
    for name, target in (('api', 'apps/api'), ('web', 'apps/web'), ('shared', 'packages/shared')):
        link = destination / 'node_modules/@orca' / name
        if not link.is_symlink() or link.resolve() != destination / target:
            raise ValueError(f'Workspace dependency {name} does not resolve to the tested archive')


def instance_doctor(connection, process):
    metadata = json.loads(connection.read_text())
    from urllib.parse import urlparse
    origin = urlparse(metadata['url'])
    if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or not origin.port or origin.path:
        raise ValueError('Fixture must bind literal loopback on its own port')
    if process.poll() is not None:
        raise ValueError('Owned fixture exited')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for path in ('/health', '/v1/me'):
        request = urllib.request.Request(metadata['url'] + path,
            headers={'Cookie': 'orca_session=' + metadata['token']})
        with opener.open(request, timeout=5) as response:
            body = json.load(response)
            if path == '/v1/me' and body.get('id') != 'compose-fixture-user':
                raise ValueError('Authenticated synthetic identity mismatch')
    return metadata


def inventory(directory):
    files = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Evidence symlinks are forbidden')
        if path.is_file() and path != directory / 'manifest.json':
            files[str(path.relative_to(directory))] = digest(path)
    return files


def validate(directory, commit, expect_failure=False):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if len(commit) != 40 or manifest['testedCommit'] != commit:
        raise ValueError('Evidence does not describe the requested exact commit')
    if git('rev-parse', commit + '^{tree}') != manifest['testedTree']:
        raise ValueError('Tested tree mismatch')
    for key, source in (('driverSha256', 'scripts/pstack/verify.py'), ('dependencyLockSha256', 'bun.lock')):
        expected = hashlib.sha256(subprocess.check_output(['git', '-C', str(ROOT), 'show', commit + ':' + source])).hexdigest()
        if manifest[key] != expected:
            raise ValueError('Evidence source digest mismatch: ' + source)
    if manifest['files'] != inventory(directory):
        raise ValueError('Evidence inventory/hash mismatch')
    if not manifest['cleanupComplete'] or not manifest['syntheticOnly']:
        raise ValueError('Cleanup or synthetic isolation not confirmed')
    outcome = json.loads((directory / 'outcome.json').read_text())
    if (outcome['exitCode'] != 0) != expect_failure or outcome['exitCode'] != manifest['exitCode']:
        raise ValueError('Unexpected trial outcome')
    if not expect_failure:
        results = json.loads((directory / 'browser-results.json').read_text())
        if results['pageErrors'] or not results['syntheticOnly'] or len(results['scenarios']) != 16 or results.get('error') or not results.get('finishedAt') or results.get('providerInvocations') != 8 or any(row['status'] != 'passed' for row in results['scenarios']):
            raise ValueError('Compose journey is incomplete')
        if len(list((directory / 'screenshots').glob('*.png'))) < 14:
            raise ValueError('Compose screenshots are missing')
    return manifest


def trial(output, fail_after):
    versions = doctor()
    commit = versions['testedCommit']
    # The runner itself must be the committed runner, not unrecorded local code.
    if subprocess.check_output(['git', '-C', str(ROOT), 'show', 'HEAD:scripts/pstack/verify.py']) != Path(__file__).read_bytes():
        raise ValueError('Commit the verification runner before trial; trial tests HEAD only')
    output.mkdir(mode=0o700)  # Refuse to overwrite/mix evidence.
    work = Path(tempfile.mkdtemp(prefix='orca-pstack-'))
    source = work / 'source'; source.mkdir()
    raw = work / 'raw'; raw.mkdir()
    fixture = None
    connection = None
    status = 1
    exported = False
    env = {'PATH': os.environ['PATH'], 'HOME': str(work / 'home'), 'TMPDIR': str(raw),
           'ORCA_CHROMIUM_EXECUTABLE': versions['chromiumExecutable'], 'NO_COLOR': '1'}
    Path(env['HOME']).mkdir()
    (raw / 'identity.log').write_text(json.dumps(versions, indent=2) + '\n')
    def checkpoint(name, log):
        print(name, flush=True)
        log.write(name + '\n'); log.flush()
        if fail_after == name:
            raise ValueError(f'Injected failure after {name}')
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'signal {signum}')
    handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        with (raw / 'checks.log').open('w') as log:
            try:
                snapshot(source)
                run(['bun', 'run', 'build'], source, env, log)
                with (raw / 'fixture.log').open('w') as fixture_log:
                    fixture = subprocess.Popen(['bun', '--no-env-file', 'apps/api/scripts/compose-fixture.ts'],
                        cwd=source, env=env, stdout=fixture_log, stderr=subprocess.STDOUT, start_new_session=True)
                for _ in range(300):
                    connections = list(raw.glob('orca-compose-fixture-*/connection.json'))
                    if connections:
                        connection = connections[0]; break
                    if fixture.poll() is not None:
                        raise ValueError('Fixture exited before readiness')
                    time.sleep(.1)
                if connection is None:
                    raise ValueError('Fixture readiness timed out')
                checkpoint('launch', log)
                instance_doctor(connection, fixture)
                checkpoint('doctor', log)
                run(['node', 'apps/web/scripts/compose-fixture-e2e.mjs', str(connection), str(raw / 'browser')], source, env, log)
                checkpoint('drive', log)
                status = 0
            except (Exception, KeyboardInterrupt) as error:
                log.write(f'FAIL: {type(error).__name__}: {error}\n'); log.flush()
    finally:
        try:
            # Reuse the established allowlist/redactor; no connection, database,
            # browser profile or raw trace is ever part of published evidence.
            spec = importlib.util.spec_from_file_location('export_evidence', source / 'scripts/ci/export-evidence.py')
            exporter = importlib.util.module_from_spec(spec); spec.loader.exec_module(exporter)
            exporter.export(raw, output, str(connection) if connection else '', status)
            exported = True
        finally:
            stop(fixture)
            shutil.rmtree(work)
            for sig, handler in handlers.items(): signal.signal(sig, handler)
            if not exported:
                shutil.rmtree(output)
    manifest = {'schemaVersion': 1, 'testedCommit': commit, 'testedTree': git('rev-parse', commit + '^{tree}'),
                'driverSha256': digest(Path(__file__)), 'dependencyLockSha256': versions['lockSha256'],
                'dependencies': 'copy of preinstalled dependencies; no install performed',
                'syntheticOnly': True, 'exitCode': status, 'cleanupComplete': not work.exists(),
                'nativeChecks': 'not run locally; existing hosted Fixture Checks owns iOS',
                'files': inventory(output)}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    validate(output, commit, expect_failure=status != 0)
    print(f'Evidence: {output}; tested commit: {commit}; exit: {status}', flush=True)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('doctor', help='Read-only prerequisites; never installs anything')
    trial_parser = commands.add_parser('trial', help='Archive HEAD; build, launch, doctor, drive, export and clean up')
    trial_parser.add_argument('directory', type=Path, help='New evidence directory; parent must exist')
    trial_parser.add_argument('--fail-after', choices=('launch', 'doctor', 'drive'), help='Exercise owned cleanup and sanitized failure evidence')
    evidence = commands.add_parser('evidence', help='Validate inventory, outcome and exact tested commit')
    evidence.add_argument('directory', type=Path)
    evidence.add_argument('--commit', required=True, help='Full 40-character tested commit SHA')
    evidence.add_argument('--expect-failure', action='store_true')
    args = parser.parse_args()
    try:
        if args.command == 'doctor': print(json.dumps(doctor(), indent=2))
        elif args.command == 'trial': return trial(args.directory.resolve(), args.fail_after)
        else:
            validate(args.directory.resolve(), args.commit, args.expect_failure)
            print('Evidence verified against ' + args.commit)
        return 0
    except (Exception, KeyboardInterrupt) as error:
        print(f'pstack verification failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
