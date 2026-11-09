#!/usr/bin/env python3
"""Exercise the real runner's phase orchestration with mock executables, not Xcode."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

RUNNER = Path(__file__).resolve().parents[2] / 'apps/ios/OrcaUITests/run-fixture-tests.sh'


@unittest.skipUnless(shutil.which('zsh'), 'zsh is required for the native fixture runner')
class AppearancePhasesTests(unittest.TestCase):
    def run_phases(self, scope, light, dark):
        # Execute the actual phase block, including set -e, rather than duplicating it.
        tail = RUNNER.read_text().split('light_exit=0\n', 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock = root / 'xcodebuild'
            mock.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
args = sys.argv[1:]
bundle = pathlib.Path(args[args.index('-resultBundlePath') + 1])
bundle.mkdir()
phase = 'dark' if bundle.name == 'OrcaDark.xcresult' else 'light'
with open(os.environ['MOCK_CALLS'], 'a') as handle:
    handle.write(json.dumps({'phase': phase, 'args': args}) + '\\n')
raise SystemExit(int(os.environ['MOCK_' + phase.upper()]))
''')
            mock.chmod(0o755)
            xcrun = root / 'xcrun'
            xcrun.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_APPEARANCES"\n')
            xcrun.chmod(0o755)
            harness = root / 'phases.zsh'
            harness.write_text('''set -euo pipefail
progress() { print -r -- "phase=$1"; }
result_dir=$MOCK_ROOT
result_bundle="$result_dir/Orca.xcresult"
injected_xctestrun=synthetic.xctestrun
simulator_udid=owned-synthetic-simulator
light_tests=(-only-testing:synthetic-light)
dark_tests=(-only-testing:synthetic-dark)
light_exit=0
''' + tail)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}',
                       MOCK_ROOT=str(root), MOCK_CALLS=str(root / 'calls'),
                       MOCK_APPEARANCES=str(root / 'appearances'),
                       MOCK_LIGHT=str(light), MOCK_DARK=str(dark), ORCA_UI_TEST_SCOPE=scope)
            result = subprocess.run(['zsh', str(harness)], env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
            expected_phases = ['light'] if light and scope != 'mailbox' else ['light', 'dark']
            self.assertEqual([call['phase'] for call in calls], expected_phases)
            self.assertEqual(result.returncode, light or dark, result.stdout + result.stderr)
            self.assertTrue((root / 'Orca.xcresult').is_dir())
            self.assertEqual((root / 'OrcaDark.xcresult').is_dir(), 'dark' in expected_phases)
            self.assertEqual((root / 'appearances').exists(), 'dark' in expected_phases)
            for call in calls:
                self.assertIn('-only-testing:synthetic-' + call['phase'], call['args'])
                self.assertIn('-parallel-testing-enabled', call['args'])
            if scope == 'mailbox':
                self.assertIn(f'light={light} dark={dark}', result.stdout)

    def test_mailbox_preserves_both_bundles_and_any_failure(self):
        for light, dark in [(0, 0), (65, 0), (0, 66), (65, 66)]:
            with self.subTest(light=light, dark=dark):
                self.run_phases('mailbox', light, dark)

    def test_other_scopes_remain_fail_fast(self):
        for scope in ['all', 'images', 'compose', 'overscroll', 'actions', 'views', 'reading', 'notifications']:
            for light, dark in [(0, 0), (65, 0), (0, 66), (65, 66)]:
                with self.subTest(scope=scope, light=light, dark=dark):
                    self.run_phases(scope, light, dark)


if __name__ == '__main__':
    unittest.main()
