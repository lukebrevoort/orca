#!/usr/bin/env python3
"""Serialize this goal's local heavy commands without blocking other agents."""
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path

if len(sys.argv) < 2:
    raise SystemExit("Usage: python3 /tmp/orca-ui-heavy-slot.py <command> [args...]")
slot = open('/tmp/orca-ui-heavy-slot.lock', 'a+')
try:
    fcntl.flock(slot, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('Orca heavy slot is busy; command was NOT started. Continue source work and report slot contention; do not spin.', file=sys.stderr)
    raise SystemExit(75)

def snapshot(stage, child_pid=None, exit_code=None):
    resource = subprocess.run(['ps', '-Ao', 'pid,pcpu,rss,comm', '-r'], text=True, capture_output=True, timeout=5)
    pressure = subprocess.run(['memory_pressure'], text=True, capture_output=True, timeout=5)
    free = next((line for line in pressure.stdout.splitlines() if 'System-wide memory free percentage:' in line), 'memory unavailable')
    record = {'time': time.time(), 'stage': stage, 'ownerPid': os.getpid(), 'childPid': child_pid, 'command': Path(sys.argv[1]).name, 'exitCode': exit_code, 'cpuRssTop': resource.stdout.splitlines()[:7], 'memory': free}
    with open('/tmp/orca-ui-heavy-resources.jsonl', 'a') as output:
        output.write(json.dumps(record) + '\n')
    print('[Orca resources] ' + json.dumps(record), file=sys.stderr, flush=True)

os.nice(10)
snapshot('before')
# The child retains the open lock descriptor if its coordinator is interrupted.
child = subprocess.Popen(sys.argv[1:], pass_fds=(slot.fileno(),))
last_sample = time.monotonic()
while True:
    try:
        result = child.wait(timeout=15)
        break
    except subprocess.TimeoutExpired:
        snapshot('running', child.pid)
        last_sample = time.monotonic()
snapshot('after', child.pid, result)
raise SystemExit(result)
