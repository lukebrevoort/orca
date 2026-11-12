#!/usr/bin/env python3
"""Actual preflight/adoption/forwarding/aggregate code with synthetic tools only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / 'apps/ios/OrcaUITests/run-fixture-tests.sh'
FIXTURE = ROOT / 'scripts/ci/fixture-check.sh'
WORKFLOW = ROOT / '.github/workflows/native-mailbox.yml'


@unittest.skipUnless(shutil.which('zsh'), 'zsh required for actual native phase syntax')
class MailboxShardContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='orca-mailbox-shard-control-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                        MOCK_ROOT=str(self.root), RUNNER_TEMP=str(self.root),
                        ORCA_CI_EVIDENCE_DIR=str(self.root / 'public'))
        self.env.pop('ORCA_UI_TEST_APPEARANCE', None)
        self.env.pop('ORCA_CI_UI_TEST_APPEARANCE', None)

    def reject_before_ingress(self, script, args, changes):
        marker = self.root / 'unexpected-ingress'
        for name in ('xcodebuild', 'xcrun', 'bun', 'node'):
            p = self.bin / name
            p.write_text('#!/bin/sh\ntouch "$MOCK_ROOT/unexpected-ingress"\nexit 93\n')
            p.chmod(0o755)
        result = subprocess.run([script, *args], cwd=ROOT, env=dict(self.env, **changes),
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 64, result.stdout + result.stderr)
        self.assertFalse(marker.exists(), 'Validation must precede Apple/fixture commands')
        self.assertFalse((self.root / 'public').exists())

    def test_direct_runner_rejects_invalid_or_nonmailbox_before_apple(self):
        for appearance in ('', 'blue', 'light dark', '../light'):
            with self.subTest(appearance=appearance):
                self.reject_before_ingress('zsh', [str(RUNNER), '/missing-connection', 'owned'],
                                           {'ORCA_UI_TEST_SCOPE': 'mailbox', 'ORCA_UI_TEST_APPEARANCE': appearance})
        self.reject_before_ingress('zsh', [str(RUNNER), '/missing-connection', 'owned'],
                                   {'ORCA_UI_TEST_SCOPE': 'reading', 'ORCA_UI_TEST_APPEARANCE': 'light'})

    def test_fixture_wrapper_rejects_invalid_or_wrong_mode_before_startup(self):
        for appearance in ('', 'blue', 'light dark', '../dark'):
            with self.subTest(appearance=appearance):
                self.reject_before_ingress('bash', [str(FIXTURE), 'ios'],
                                           {'ORCA_CI_UI_TEST_SCOPE': 'mailbox', 'ORCA_CI_UI_TEST_APPEARANCE': appearance})
        for mode, scope in (('ios', 'compose'), ('browser', 'mailbox')):
            self.reject_before_ingress('bash', [str(FIXTURE), mode],
                                       {'ORCA_CI_UI_TEST_SCOPE': scope, 'ORCA_CI_UI_TEST_APPEARANCE': 'dark'})

    def test_actual_fixture_forwarding_and_identity_keep_requested_appearance(self):
        source = FIXTURE.read_text()
        forwarding = source.split('  progress ios_suite_started\n', 1)[1].split('\n  progress ios_suite_finished', 1)[0]
        identity = '{\n  echo "mode=$mode"' + source.split('{\n  echo "mode=$mode"', 1)[1].split('} > "$work/identity.log"', 1)[0] + '} > "$work/identity.log"\n'
        mock = self.bin / 'zsh'
        mock.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib
pathlib.Path(os.environ['MOCK_ROOT'], 'forwarded.json').write_text(json.dumps({
    'scope': os.environ.get('ORCA_UI_TEST_SCOPE'),
    'appearance': os.environ.get('ORCA_UI_TEST_APPEARANCE')}))
'''); mock.chmod(0o755)
        for name in ('bun', 'node'):
            p = self.bin / name; p.write_text('#!/bin/sh\nprintf "synthetic-version\\n"\n'); p.chmod(0o755)
        harness = self.root / 'forward.bash'
        harness.write_text('set -euo pipefail\nmode=ios\nwork=$MOCK_ROOT\nevidence=$MOCK_ROOT/public\nconnection=synthetic-connection\nsimulator=owned-synthetic\n' + identity + forwarding)
        for appearance in ('both', 'light', 'dark', None):
            env = dict(self.env, ORCA_CI_UI_TEST_SCOPE='mailbox')
            if appearance is not None: env['ORCA_CI_UI_TEST_APPEARANCE'] = appearance
            expected = appearance or 'both'
            result = subprocess.run(['bash', str(harness)], cwd=ROOT,
                                    env=env,
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads((self.root / 'forwarded.json').read_text()), {'scope': 'mailbox', 'appearance': expected})
            self.assertIn('ui_test_appearance=' + expected, (self.root / 'identity.log').read_text().splitlines())

    def test_actual_adoption_block_runs_only_requested_installation_and_retains_failure(self):
        source = RUNNER.read_text().split('# BEGIN isolated_adoption_phases\n', 1)[1].split('# END isolated_adoption_phases', 1)[0]
        mock = self.bin / 'xcodebuild'
        mock.write_text(f'#!{sys.executable}\n' + '''import json, os, pathlib, sys
a = sys.argv[1:]; bundle = pathlib.Path(a[a.index('-resultBundlePath') + 1]); bundle.mkdir()
with open(pathlib.Path(os.environ['MOCK_ROOT'], 'calls'), 'a') as f:
    f.write(json.dumps({'bundle': bundle.name, 'selection': [x for x in a if x.startswith('-only-testing:')]}) + '\\n')
raise SystemExit(int(os.environ['MOCK_EXIT']))
'''); mock.chmod(0o755)
        xcrun = self.bin / 'xcrun'; xcrun.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK_ROOT/apple-calls"\n'); xcrun.chmod(0o755)
        harness = self.root / 'adoption.zsh'
        harness.write_text('set -euo pipefail\nread_only=${MOCK_READ_ONLY:-0}\nsimulator_udid=owned-synthetic\nresult_dir=$MOCK_RESULTS\ninjected_xctestrun=synthetic.xctestrun\nprogress() { print -r -- "phase=$1"; }\n' + source + '\nexit "$adoption_exit"\n')
        for index, (appearance, status, read_only) in enumerate([('both', 65, '0'), ('light', 65, '0'), ('dark', 65, '0'), ('light', 0, '0'), ('dark', 0, '0'), ('dark', 0, '1')]):
            calls = self.root / 'calls'; calls.unlink(missing_ok=True)
            apple = self.root / 'apple-calls'; apple.unlink(missing_ok=True)
            results = self.root / str(index); results.mkdir()
            result = subprocess.run(['zsh', str(harness)], cwd=ROOT,
                                    env=dict(self.env, ORCA_UI_TEST_SCOPE='mailbox', ORCA_UI_TEST_APPEARANCE=appearance,
                                             MOCK_EXIT=str(status), MOCK_READ_ONLY=read_only, MOCK_RESULTS=str(results)),
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, status, result.stdout + result.stderr)
            observed = [json.loads(x) for x in calls.read_text().splitlines()] if calls.exists() else []
            expected = [] if read_only == '1' else (['light', 'dark'] if appearance == 'both' else [appearance])
            self.assertEqual([x['bundle'] for x in observed], ['Adoption' + x + '.xcresult' for x in expected])
            self.assertEqual(sorted(p.name for p in results.iterdir()), sorted('Adoption' + x + '.xcresult' for x in expected))
            for call in observed:
                self.assertEqual(call['selection'], ['-only-testing:OrcaUITests/OrcaUITests/test48ImportantNotificationAdoptionIsExplicitAccountScopedAndNotDeliveryProof'])
            commands = apple.read_text().splitlines() if apple.exists() else []
            self.assertEqual(sum(' uninstall ' in x for x in commands), len(expected) + (1 if expected else 0))
            for actual in ('light', 'dark'):
                self.assertEqual(any(x.endswith('appearance ' + actual) for x in commands), actual in expected)

    def test_all_existing_selection_arrays_are_byte_preserved_with_units_only_light(self):
        source = RUNNER.read_text()
        arrays = source.split('if [[ ${ORCA_UI_TEST_SCOPE:-all} == images ]]; then', 1)[1].split('# BRE-468 adoption', 1)[0]
        complete = 'if [[ ${ORCA_UI_TEST_SCOPE:-all} == images ]]; then' + arrays
        self.assertEqual(hashlib.sha256(complete.encode()).hexdigest(), 'eb23fbd7f067fcd0e7abf297fc59867d0a7756faa179e120f9c14dcef9a87d74')
        mailbox = source.split('elif [[ ${ORCA_UI_TEST_SCOPE:-all} == mailbox ]]; then', 1)[1].split('elif [[', 1)[0]
        light = next(x for x in mailbox.splitlines() if x.strip().startswith('light_tests='))
        dark = next(x for x in mailbox.splitlines() if x.strip().startswith('dark_tests='))
        self.assertIn('-only-testing:OrcaTests ', light)
        self.assertNotIn('-only-testing:OrcaTests', dark)

    def test_fixed_matrix_artifact_identity_and_actual_required_aggregate(self):
        source = WORKFLOW.read_text()
        self.assertIn('fail-fast: false\n      matrix:\n        appearance: [light, dark]', source)
        self.assertIn('timeout-minutes: 50', source)
        self.assertIn('timeout-minutes: 45', source)
        self.assertIn('ORCA_CI_UI_TEST_APPEARANCE: ${{ matrix.appearance }}', source)
        self.assertIn('name: native-mailbox-${{ matrix.appearance }}-${{ github.run_id }}-${{ github.run_attempt }}', source)
        self.assertEqual(source.count('name: Native mailbox light/dark UI\n'), 1)
        aggregate = source.split('  mailbox-required:\n', 1)[1]
        self.assertIn('runs-on: ubuntu-latest', aggregate)
        self.assertIn('needs: mailbox', aggregate)
        self.assertIn('if: ${{ always() }}', aggregate)
        self.assertIn('MATRIX_RESULT: ${{ needs.mailbox.result }}', aggregate)
        command = textwrap.dedent(aggregate.split('        run: |\n', 1)[1])
        for status in ('success', 'failure', 'cancelled', 'skipped', ''):
            result = subprocess.run(['bash', '-e', '-c', command], env=dict(self.env, MATRIX_RESULT=status),
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode == 0, status == 'success')


if __name__ == '__main__': unittest.main()
