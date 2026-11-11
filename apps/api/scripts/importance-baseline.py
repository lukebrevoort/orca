"""Replay the original six route regressions against an immutable pre-feature archive."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[3]
baseline = '4f7aff92f4e1f93b86a95c6fd5e86e3bf3045da7'
if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 apps/api/scripts/importance-baseline.py <new-output-directory>')
output = Path(sys.argv[1]).resolve()
output.mkdir()
regression = root / 'apps/api/src/importance/routes.test.ts'
pattern = r'BRE-454 (durable conversation|exact sender|sender preview|guarded Undo|authorization|Important retained-mail)'
with tempfile.TemporaryDirectory(prefix='orca-importance-baseline-') as temporary:
    scratch = Path(temporary)
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['git', '-C', str(root), 'archive', baseline], stdout=archive, check=True)
        archive.seek(0)
        subprocess.run(['tar', '-xf', '-', '-C', str(scratch)], stdin=archive, check=True)
    assert (scratch / 'bun.lock').read_bytes() == (root / 'bun.lock').read_bytes(), 'Baseline lockfile differs'
    # Existing dependency tree only. Preserve relative workspace links inside the archive.
    subprocess.run(['cp', '-cR', str(root / 'node_modules'), str(scratch / 'node_modules')], check=True)
    for name, target in (('api', 'apps/api'), ('shared', 'packages/shared'), ('web', 'apps/web')):
        assert (scratch / 'node_modules/@orca' / name).resolve() == scratch / target
    destination = scratch / 'apps/api/src/importance/routes.test.ts'
    destination.parent.mkdir()
    shutil.copyfile(regression, destination)
    command = ['bun', 'test', 'apps/api/src/importance/routes.test.ts', '--test-name-pattern', pattern]
    result = subprocess.run(command, cwd=scratch, capture_output=True, text=True)
    log = result.stdout + result.stderr
    (output / 'baseline-red.log').write_text(log)
    if result.returncode != 1 or '6 fail' not in log or '0 pass' not in log or log.count('Received: 404') != 6:
        raise SystemExit('Baseline did not produce the expected six real absent-route regressions; inspect log')
    (output / 'baseline.json').write_text(json.dumps({
        'baseline': baseline, 'status': 'red', 'command': command, 'result': '0 pass, 6 fail; six actual HTTP 404 responses where HTTP 200 is required',
        'regressionSha256': hashlib.sha256(regression.read_bytes()).hexdigest(),
        'dependencyLockSha256': hashlib.sha256((scratch / 'bun.lock').read_bytes()).hexdigest(),
        'source': 'clean git archive of immutable baseline, with only the current synthetic test overlaid; no implementation/migration/schema overlay',
        'dependencies': 'copy of existing frozen dependencies, no install; workspace links verified inside scratch',
        'scope': 'first six original product regressions; later failure-injection/migration cases require the implemented tables and are intentionally excluded',
        'cleanup': 'only owned temporary archive/database removed in finally; evidence retained',
    }, indent=2) + '\n')
print(json.dumps({'baseline': baseline, 'failures': 6, 'actual404': 6, 'output': str(output), 'cleanup': 'owned temporary archive removed'}))
