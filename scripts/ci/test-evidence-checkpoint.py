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
    # Model an exporter that refuses an already-existing output directory.
    out = pathlib.Path(a[a.index('--output-path') + 1]); out.mkdir()
    if (work/'inject-secret-image').exists():
        (out/'synthetic.png').write_bytes(b'synthetic-image:' + os.environ['MOCK_SECRET'].encode())
''')
        mock.chmod(0o755)
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                        MOCK_WORK=str(self.work), MOCK_SECRET=SECRET)
        self.env.pop('GITHUB_ACTIONS', None); self.env.pop('RUNNER_ENVIRONMENT', None)
        self.env.pop('ORCA_UI_TEST_APPEARANCE', None)

    def export(self, checkpoint=False, status=65):
        args = [sys.executable, str(EXPORTER), str(self.work), str(self.evidence),
                str(self.connection), str(status), '']
        if checkpoint: args.append('suite_light_finished' if checkpoint is True else checkpoint)
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
        source = (ROOT/'scripts/ci/fixture-check.sh').read_text()
        cleanup = source.split('cleanup() {', 1)[1].split('\n}\n', 1)[0]
        harness = self.root/'cleanup.bash'
        harness.write_text('''set +e
work=$MOCK_WORK
evidence=$MOCK_EVIDENCE
connection=$MOCK_CONNECTION
fixture_pid=
simulator=
progress() { printf 'phase=%s\\n' "$1"; }
cleanup() {''' + cleanup + '\n}\nfalse\ncleanup\n')
        result = subprocess.run(['bash', str(harness)], cwd=ROOT,
                                env=dict(self.env, MOCK_EVIDENCE=str(self.evidence), MOCK_CONNECTION=str(self.connection)),
                                capture_output=True, text=True, timeout=8)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {p.name:p.read_bytes() for p in checkpoint.iterdir() if p.is_file()})
        self.assertFalse((self.evidence/'outcome.json').exists())
        self.assert_private_bytes_absent()

    def test_final_export_keeps_legacy_layout_and_actual_status(self):
        self.assertEqual(self.export(checkpoint=True).returncode, 0)
        for status in (0, 65):
            result = self.export(status=status)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('sanitized evidence: ' + str(self.evidence), result.stdout)
            self.assertNotIn('validated-export-', result.stdout)
            self.assertEqual(json.loads((self.evidence/'outcome.json').read_text())['exitCode'], status)
            self.assertTrue((self.evidence/'identity.log').is_file())
            self.assertTrue((self.evidence/'Orca-summary.json').is_file())
            self.assertTrue((self.evidence/'checkpoints/suite_light_finished/outcome.json').is_file())
            self.assert_private_bytes_absent()

    def test_secret_image_is_never_published(self):
        (self.work/'inject-secret-image').touch()
        result = self.export(checkpoint=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([p for p in self.evidence.rglob('*') if p.is_file()], [])

    def test_final_preserves_browser_reader_layout_and_scans_all_bytes(self):
        browser = self.work/'browser'; browser.mkdir()
        reader = self.work/'reader'; reader.mkdir()
        for directory in (browser, reader):
            (directory/'results.json').write_text(json.dumps({'synthetic': True, 'redact': SECRET}))
            (directory/'private-connection.json').write_text(SECRET)
            (directory/'frame.png').write_bytes(b'synthetic-safe-image-bytes')
        (reader/'head-results.json').write_text('{"synthetic":true}')
        result = self.export(status=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ('browser-results.json', 'reader-results.json', 'reader-catchup-results.json'):
            self.assertTrue(json.loads((self.evidence/name).read_text())['synthetic'])
        for name in ('frame.png', 'reader-frame.png'):
            self.assertEqual((self.evidence/'screenshots'/name).read_bytes(), b'synthetic-safe-image-bytes')
        self.assertFalse(any(p.name == 'private-connection.json' for p in self.evidence.rglob('*')))
        self.assertEqual(json.loads((self.evidence/'outcome.json').read_text())['exitCode'], 0)
        self.assert_private_bytes_absent()

    def test_dark_checkpoint_is_incomplete_redacted_and_has_no_light_bundle(self):
        (self.results / 'Orca.xcresult').rmdir()
        (self.results / 'OrcaDark.xcresult').mkdir()
        result = self.export(checkpoint='suite_dark_finished')
        self.assertEqual(result.returncode, 0, result.stderr)
        checkpoint = self.evidence / 'checkpoints/suite_dark_finished'
        outcome = json.loads((checkpoint / 'outcome.json').read_text())
        self.assertIsNone(outcome['exitCode']); self.assertFalse(outcome['complete'])
        self.assertEqual(outcome['checkpointPhase'], 'suite_dark_finished')
        self.assertEqual(json.loads((checkpoint / 'OrcaDark-summary.json').read_text())['failedTests'], 1)
        self.assertFalse((checkpoint / 'Orca-summary.json').exists())
        self.assertFalse((self.evidence / 'outcome.json').exists())
        self.assertIn('phase=suite_dark_finished complete=false', result.stdout)
        self.assert_private_bytes_absent()

    def test_dark_secret_attachment_is_never_published(self):
        (self.results / 'OrcaDark.xcresult').mkdir()
        (self.work / 'inject-secret-image').touch()
        result = self.export(checkpoint='suite_dark_finished')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([p for p in self.evidence.rglob('*') if p.is_file()], [])

    def test_failed_final_export_preserves_dark_checkpoint_without_pass_outcome(self):
        (self.results / 'OrcaDark.xcresult').mkdir()
        self.assertEqual(self.export(checkpoint='suite_dark_finished').returncode, 0)
        checkpoint = self.evidence / 'checkpoints/suite_dark_finished'
        before = {str(p.relative_to(checkpoint)): p.read_bytes() for p in checkpoint.rglob('*') if p.is_file()}
        (self.work / 'fail-dark-export').touch()
        result = self.export(status=65)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, {str(p.relative_to(checkpoint)): p.read_bytes() for p in checkpoint.rglob('*') if p.is_file()})
        self.assertFalse((self.evidence / 'outcome.json').exists())
        self.assert_private_bytes_absent()

    @unittest.skipUnless(shutil.which('zsh'), 'real runner phase syntax requires zsh')
    def test_actual_dark_only_phase_publishes_dark_checkpoint_and_selected_failure(self):
        (self.results / 'Orca.xcresult').rmdir()
        source = RUNNER.read_text()
        progress = source.split('progress() {', 1)[1].split('\n}\n', 1)[0]
        phases = source.split('light_exit=0\n', 1)[1]
        mock = self.bin / 'xcodebuild'
        mock.write_text(f'#!{sys.executable}\n' + """import pathlib, sys
a = sys.argv[1:]; pathlib.Path(a[a.index('-resultBundlePath') + 1]).mkdir()
raise SystemExit(65)
""")
        mock.chmod(0o755)
        harness = self.work / 'dark.zsh'
        harness.write_text("""set -euo pipefail
ios_dir=$MOCK_REPO/apps/ios
connection_file=$MOCK_CONNECTION
simulator_udid=owned-synthetic-device
result_dir=$MOCK_WORK/results
result_bundle=$result_dir/Orca.xcresult
injected_xctestrun=synthetic.xctestrun
light_tests=(-only-testing:synthetic-light)
dark_tests=(-only-testing:synthetic-dark)
progress() {""" + progress + '\n}\nlight_exit=0\n' + phases)
        env = dict(self.env, MOCK_REPO=str(ROOT), MOCK_CONNECTION=str(self.connection),
                   ORCA_UI_TEST_SCOPE='mailbox', ORCA_UI_TEST_APPEARANCE='dark', ORCA_CI_PROGRESS='0',
                   ORCA_CI_CHECKPOINT_WORK=str(self.work), ORCA_CI_CHECKPOINT_EVIDENCE=str(self.evidence))
        result = subprocess.run(['zsh', str(harness)], env=env, capture_output=True, text=True, timeout=8)
        self.assertEqual(result.returncode, 65, result.stdout + result.stderr)
        self.assertFalse((self.results / 'Orca.xcresult').exists())
        self.assertFalse((self.evidence / 'checkpoints/suite_light_finished').exists())
        checkpoint = self.evidence / 'checkpoints/suite_dark_finished'
        self.assertTrue((checkpoint / 'OrcaDark-summary.json').is_file())
        outcome = json.loads((checkpoint / 'outcome.json').read_text())
        self.assertIsNone(outcome['exitCode']); self.assertFalse(outcome['complete'])
        self.assert_private_bytes_absent()

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
