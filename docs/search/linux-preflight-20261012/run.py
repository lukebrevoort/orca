#!/usr/bin/env python3
"""Preparatory Linux check only; installed frozen dependencies, synthetic local DBs.
Usage: run.py BUN BASE_CHECKOUT CANDIDATE_CHECKOUT NEW_OUTPUT_DIRECTORY
No network, infrastructure, real mail or durability-setting writes.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

bun, base, head, output = sys.argv[1:]
base, head, output = map(lambda p: Path(p).resolve(), (base, head, output))
assert not output.exists(), 'Refusing to overwrite evidence'
assert subprocess.check_output([bun, '--version'], text=True).strip() == '1.3.14'
assert (base / 'bun.lock').read_bytes() == (head / 'bun.lock').read_bytes()
revisions = {'base': '6ac83d1ae1bed08dd5d380774667b03d5dffe55b',
             'head': '3ba1f61'}
for mode, root in [('base', base), ('head', head)]:
    revision = subprocess.check_output(['git', 'rev-parse', revisions[mode]], cwd=root, text=True).strip()
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == revision
    assert not subprocess.check_output(['git', 'diff', 'HEAD', '--', 'apps', 'packages', 'bun.lock'], cwd=root)
    revisions[mode] = revision
harness = head / 'apps/api/benchmarks/search-stage.ts'
output.mkdir(parents=True)
start = time.monotonic()
runs = []
for size, order in [(1000, ['base', 'head']), (5000, ['head', 'base'])]:
    pair = {}
    for mode in order:
        assert time.monotonic() - start < 270, 'Scheduling budget exhausted'
        root = base if mode == 'base' else head
        path = output / f'{size}-{mode}.json'
        command = [bun, str(harness), f'--root={root}', f'--revision={revisions[mode]}',
                   f'--mode={mode}', f'--size={size}', '--samples=5', f'--output={path}']
        print(f'{size} {mode}', flush=True)
        subprocess.run(command, cwd=root, check=True, timeout=90)
        pair[mode] = json.loads(path.read_text())
        assert pair[mode]['passed'] and pair[mode]['host']['platform'] == 'linux'
        assert pair[mode]['synchronous'] == {'synchronous': 2}
        runs.append({'size': size, 'mode': mode, 'file': path.name})
    assert pair['base']['signatures'] == pair['head']['signatures']
    for stage in ['seededDisk', 'checkpointedDisk']:
        assert pair['base']['disk'][stage] == pair['head']['disk'][stage]
(output / 'manifest.json').write_text(json.dumps({
    'purpose': 'Preparatory Linux correctness/portability only; not representative Railway validation',
    'revisions': revisions, 'harnessSha256': hashlib.sha256(harness.read_bytes()).hexdigest(),
    'samplesPerWorkload': 5, 'warmups': 3, 'sizes': [1000, 5000], 'runs': runs,
    'childTimeoutSeconds': 90, 'schedulingBudgetSeconds': 270, 'maximumTotalSeconds': 360,
    'elapsedSeconds': time.monotonic() - start,
    'allSignaturesAndSeededFinalSizesEqual': True,
}, indent=2) + '\n')
print('All four checks passed', flush=True)
