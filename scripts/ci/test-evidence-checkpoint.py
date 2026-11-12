#!/usr/bin/env python3
"""Real phase/export code with synthetic commands; never launch Apple tools."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
EXPORTER = ROOT / 'scripts/ci/export-evidence.py'
RUNNER = ROOT / 'apps/ios/OrcaUITests/run-fixture-tests.sh'
SECRET = 'checkpoint-disposable-bearer'


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orca-checkpoint-control-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'private'; self.work.mkdir()
        self.evidence = self.root / 'public'; self.evidence.mkdir()
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.connection = self.work / 'connection.json'
        self.connection.write_text(json.dumps({'accessToken': SECRET}))
        (self.work / 'identity.log').write_text('tested_sha=synthetic-owned-source\n')
        (self.work / 'checks.log').write_text('synthetic ' + SECRET + ' Bearer other-secret\n')
        (self.work / 'fixture.log').write_text('orca_session=cookie-secret;\n')
        self.results = self.work / 'results'; self.results.mkdir()
        (self.results / 'Orca.xcresult').mkdir()
        mock = self.bin / 'xcrun'
        mock.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
a = sys.argv[1:]; work = pathlib.Path(os.environ['MOCK_WORK'])
if a[:2] == ['xcresulttool', 'get']:
    bundle = pathlib.Path(a[a.index('--path') + 1])
    if bundle.name == 'OrcaDark.xcresult' and (work/'fail-dark-export').exists():
        raise SystemExit(65)
    print(json.dumps({'result':'Failed','failedTests':1,'passedTests':0,'testNodes':[]}))
elif a[:3] == ['xcresulttool', 'export', 'attachments']:
    out = pathlib.Path(a[a.index('--output-path') + 1]); out.mkdir(exist_ok=True)
    if (work/'inject-secret-image').exists():
        (out/'synthetic.png').write_bytes(b'synthetic-image:' + os.environ['MOCK_SECRET'].encode())
''')
        mock.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                        MOCK_WORK=str(self.work), MOCK_SECRET=SECRET)
        self.env.pop('GITHUB_ACTIONS', None); self.env.pop('RUNNER_ENVIRONMENT', None)

    def export(self, checkpoint=False):
        args = [sys.executable, str(EXPORTER), str(self.work), str(self.evidence),
                str(self.connection), '65', '']
        if checkpoint: args.append('suite_light_finished')
        return subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=8)

    def assert_private_bytes_absent(self):
        for p in self.evidence.rglob('*'):
            if p.is_file():
                for secret in [SECRET, 'other-secret', 'cookie-secret']:
                    self.assertNotIn(secret.encode(), p.read_bytes(), str(p))

    def test_checkpoint_is_incomplete_and_redacted(self):
        result = self.export(checkpoint=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        checkpoint = self.evidence / 'checkpoints/suite_light_finished'
        self.assertTrue((checkpoint/'outcome.json').is_file())
        outcome = json.loads((checkpoint/'outcome.json').read_text())
        self.assertIsNone(outcome['exitCode'])
        self.assertFalse(outcome['complete'])
        self.assertEqual(outcome['checkpointPhase'], 'suite_light_finished')
        self.assertEqual(json.loads((checkpoint/'Orca-summary.json').read_text())['failedTests'], 1)
        self.assertFalse((self.evidence/'outcome.json').exists())
        self.assert_private_bytes_absent()

    def test_failed_final_export_preserves_checkpoint_without_pass_outcome(self):
        self.assertEqual(self.export(checkpoint=True).returncode, 0)
        checkpoint = self.evidence / 'checkpoints/suite_light_finished'
        self.assertTrue(checkpoint.is_dir())
        before = {p.name:p.read_bytes() for p in checkpoint.iterdir() if p.is_file()}
        (self.results/'OrcaDark.xcresult').mkdir()
        (self.work/'fail-dark-export').touch()
        result = self.export()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {p.name:p.read_bytes() for p in checkpoint.iterdir() if p.is_file()})
        self.assertFalse((self.evidence/'outcome.json').exists())
        self.assert_private_bytes_absent()

    def test_secret_image_is_never_published(self):
        (self.work/'inject-secret-image').touch()
        result = self.export(checkpoint=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([p for p in self.evidence.rglob('*') if p.is_file()], [])

    def test_unknown_phase_is_rejected_without_publication(self):
        args = [sys.executable, str(EXPORTER), str(self.work), str(self.evidence),
                str(self.connection), '65', '', '../unowned']
        result = subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([p for p in self.evidence.rglob('*') if p.is_file()], [])

    @unittest.skipUnless(shutil.which('zsh'), 'real runner phase syntax requires zsh')
    def test_outer_kill_during_dark_keeps_light_checkpoint(self):
        source = RUNNER.read_text()
        progress = source.split('progress() {', 1)[1].split('\n}\n', 1)[0]
        phases = source.split('light_exit=0\n', 1)[1]
        mock = self.bin/'xcodebuild'
        mock.write_text(f'#!{sys.executable}\n' + '''import os, pathlib, sys, time
a = sys.argv[1:]; work = pathlib.Path(os.environ['MOCK_WORK'])
bundle = pathlib.Path(a[a.index('-resultBundlePath') + 1]); bundle.mkdir(exist_ok=True)
if bundle.name == 'OrcaDark.xcresult':
    (work/'dark-started').touch(); time.sleep(60)
raise SystemExit(65)
'''); mock.chmod(0o755)
        harness = self.work/'phases.zsh'
        harness.write_text('''set -euo pipefail
script_dir=$MOCK_REPO/apps/ios/OrcaUITests
ios_dir=$MOCK_REPO/apps/ios
connection_file=$MOCK_CONNECTION
simulator_udid=owned-synthetic-device
result_dir=$MOCK_WORK/results
result_bundle=$result_dir/Orca.xcresult
injected_xctestrun=synthetic.xctestrun
light_tests=(-only-testing:synthetic-light)
dark_tests=(-only-testing:synthetic-dark)
progress() {''' + progress + '\n}\nlight_exit=0\n' + phases)
        env = dict(self.env, MOCK_REPO=str(ROOT), MOCK_CONNECTION=str(self.connection),
                   ORCA_UI_TEST_SCOPE='mailbox', ORCA_CI_PROGRESS='0',
                   ORCA_CI_CHECKPOINT_WORK=str(self.work), ORCA_CI_CHECKPOINT_EVIDENCE=str(self.evidence))
        with (self.work/'checks.log').open('a') as log:
            proc = subprocess.Popen(['zsh', str(harness)], env=env, stdout=log,
                                    stderr=subprocess.STDOUT, start_new_session=True)
            try:
                deadline = time.monotonic() + 8
                while not (self.work/'dark-started').exists() and proc.poll() is None and time.monotonic()<deadline:
                    time.sleep(.02)
                self.assertTrue((self.work/'dark-started').is_file(), 'Real phase block must reach held Dark')
            finally:
                if proc.poll() is None: os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=2)
        self.assertNotEqual(proc.returncode, 0)
        checkpoint = self.evidence/'checkpoints/suite_light_finished'
        self.assertTrue((checkpoint/'Orca-summary.json').is_file(), 'Completed Light evidence must survive without EXIT cleanup')
        outcome = json.loads((checkpoint/'outcome.json').read_text())
        self.assertIsNone(outcome['exitCode']); self.assertFalse(outcome['complete'])
        self.assertFalse((self.evidence/'outcome.json').exists())
        self.assert_private_bytes_absent()


if __name__ == '__main__': unittest.main()
