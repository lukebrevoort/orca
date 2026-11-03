#!/usr/bin/env python3
"""Bounded Xcode readiness; never substitutes a device or retries a test suite.

Apple documents required first-launch components:
https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components
Hosted image maintainers describe intermittent registration/warm-up problems:
https://github.com/actions/runner-images/issues/12948
https://github.com/actions/runner-images/issues/12991
These support readiness checks, not a proven diagnosis of our runner failures.
"""
import argparse
import os
from pathlib import Path
import re
import signal
import subprocess
import time


def available_destination(output, udid):
    if 'Available destinations' not in output:
        return False
    section = output.split('Available destinations', 1)[1].split('Ineligible destinations', 1)[0]
    return any(re.search(r'platform:iOS Simulator,.*\bid:\s*' + re.escape(udid) + r'\s*[,}]', line)
               for line in section.splitlines())


def command(args, timeout):
    # Kill only this probe's process group if Xcode's device discovery stalls.
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The probe exited between its deadline and cancellation.
            # An escaped descendant must not hold our output pipes open forever.
            try:
                process.communicate(timeout=1)
            except subprocess.TimeoutExpired:
                process.stdout.close()
                process.stderr.close()
                process.wait(timeout=1)
            raise
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def discover(project, udid, log, *, run=command, clock=time.monotonic, pause=time.sleep,
             deadline_seconds=180, command_seconds=45, interval=2):
    deadline = clock() + deadline_seconds
    attempt = 0
    with Path(log).open('w') as output:
        while clock() < deadline:
            attempt += 1
            remaining = deadline - clock()
            try:
                result = run(['xcodebuild', '-showdestinations', '-project', str(project), '-scheme', 'Orca'],
                             min(command_seconds, remaining))
                ready = result.returncode == 0 and available_destination(result.stdout, udid)
                diagnostic = f'[simulator readiness] attempt={attempt} exit={result.returncode} owned_destination={ready}'
                output.write(diagnostic + '\n' + result.stdout + result.stderr + '\n')
            except subprocess.TimeoutExpired:
                ready = False
                diagnostic = f'[simulator readiness] attempt={attempt} command_timeout=true owned_destination=False'
                output.write(diagnostic + '\n')
            output.flush()
            print(diagnostic, flush=True)
            if ready:
                return True
            remaining = deadline - clock()
            if remaining > 0:
                pause(min(interval, remaining))
    print('[simulator readiness] deadline exceeded; owned simulator absent from Xcode available destinations', flush=True)
    return False


def first_launch(*, run=command, environment=os.environ):
    # Component installation is authorized only on disposable GitHub-hosted CI.
    # A developer invoking the fixture script never gets system modifications.
    if environment.get('GITHUB_ACTIONS') != 'true' or environment.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        print('[simulator readiness] first-launch installation skipped outside hosted CI')
        return True
    developer = environment.get('DEVELOPER_DIR', '')
    binary = Path(developer) / 'usr/bin/xcodebuild'
    if not developer.startswith('/Applications/Xcode_') or not binary.is_file():
        raise RuntimeError('Hosted first-launch check requires the explicitly selected installed Xcode')
    help_result = run([str(binary), '-help'], 45)
    if '-checkFirstLaunchStatus' not in help_result.stdout + help_result.stderr:
        raise RuntimeError('Selected Xcode does not advertise first-launch status checking')
    result = run([str(binary), '-checkFirstLaunchStatus'], 45)
    print(f'[simulator readiness] first_launch_status={result.returncode}', flush=True)
    if result.returncode == 0:
        return True
    if result.returncode != 1:
        raise RuntimeError('Xcode first-launch status check failed')
    # Do not spawn privileged descendants: initialization must work as the
    # disposable runner user, otherwise fail visibly without widening access.
    result = run([str(binary), '-runFirstLaunch'], 120)
    print(result.stdout + result.stderr, flush=True)
    if result.returncode != 0:
        raise RuntimeError('Required Xcode component initialization failed')
    return run([str(binary), '-checkFirstLaunchStatus'], 45).returncode == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--first-launch', action='store_true')
    parser.add_argument('--project')
    parser.add_argument('--udid')
    parser.add_argument('--log')
    args = parser.parse_args()
    if args.first_launch:
        return 0 if first_launch() else 70
    if not all((args.project, args.udid, args.log)):
        parser.error('--project, --udid and --log are required for discovery')
    return 0 if discover(args.project, args.udid, args.log) else 70


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f'[simulator readiness] failed: {error}', flush=True)
        raise SystemExit(70)
