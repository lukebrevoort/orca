#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('readiness', Path(__file__).with_name('ios-readiness.py'))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)
UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
AVAILABLE = 'Available destinations for Orca:\n{ platform:iOS Simulator, arch:arm64, id:' + UDID + ', name:Owned }\n'


class Clock:
    def __init__(self): self.now = 0; self.pauses = []
    def time(self): return self.now
    def pause(self, seconds): self.pauses.append(seconds); self.now += seconds


class ReadinessTests(unittest.TestCase):
    def test_real_probe_subprocess_success_and_timeout(self):
        result = readiness.command([sys.executable, '-c', 'print("ready")'], 2)
        self.assertEqual(result.returncode, 0); self.assertEqual(result.stdout.strip(), 'ready')
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / 'child.pid'
            child = 'import os,pathlib,signal,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); signal.pause()'
            with self.assertRaises(subprocess.TimeoutExpired):
                readiness.command([sys.executable, '-c', child, str(pidfile)], 0.2)
            self.assertTrue(pidfile.exists(), 'Owned child started before timeout')
            import os
            with self.assertRaises(ProcessLookupError): os.kill(int(pidfile.read_text()), 0)

    def discover(self, outputs, deadline=5):
        clock = Clock(); calls = []
        def run(args, timeout):
            calls.append((args, timeout))
            value = outputs[min(len(calls) - 1, len(outputs) - 1)]
            if value == 'timeout':
                clock.now += timeout
                raise subprocess.TimeoutExpired(args, timeout)
            code, text = value
            return subprocess.CompletedProcess(args, code, text, '')
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'attempts.log'
            result = readiness.discover('Orca.xcodeproj', UDID, log, run=run, clock=clock.time,
                                        pause=clock.pause, deadline_seconds=deadline, command_seconds=3)
            return result, calls, clock, log.read_text()

    def test_immediate_success_does_not_wait_or_retry(self):
        result, calls, clock, _ = self.discover([(0, AVAILABLE)])
        self.assertTrue(result); self.assertEqual(len(calls), 1); self.assertEqual(clock.pauses, [])

    def test_delayed_registration_succeeds_and_preserves_attempts(self):
        result, calls, clock, log = self.discover([(0, 'Available destinations:\n'), (0, AVAILABLE)])
        self.assertTrue(result); self.assertEqual(len(calls), 2); self.assertEqual(clock.pauses, [2])
        self.assertIn('attempt=1', log); self.assertIn('attempt=2', log)

    def test_wrong_generic_or_ineligible_device_never_passes(self):
        for text in (AVAILABLE.replace(UDID, UDID + 'F'),
                     'Available destinations:\n{ platform:iOS Simulator, id:generic, name:Any iOS Simulator }',
                     'Available destinations:\nIneligible destinations:\n' + AVAILABLE.split('\n', 1)[1],
                     'Ineligible destinations:\n' + AVAILABLE.split('\n', 1)[1]):
            with self.subTest(text=text):
                result, calls, clock, _ = self.discover([(0, text)])
                self.assertFalse(result); self.assertEqual(clock.now, 5); self.assertEqual(len(calls), 3)

    def test_command_error_cannot_pass_even_with_available_output(self):
        self.assertFalse(self.discover([(65, AVAILABLE)])[0])

    def test_command_timeout_is_bounded_by_remaining_deadline(self):
        result, calls, clock, log = self.discover(['timeout'])
        self.assertFalse(result); self.assertEqual(clock.now, 5)
        self.assertEqual(calls[0][1], 3); self.assertIn('command_timeout=true', log)
        result, calls, clock, _ = self.discover(['timeout'], deadline=2)
        self.assertFalse(result); self.assertEqual(calls[0][1], 2); self.assertEqual(clock.now, 2)

    def test_error_then_registration_success(self):
        self.assertTrue(self.discover([(1, ''), (0, AVAILABLE)])[0])

    def test_first_launch_never_modifies_developer_machine(self):
        def forbidden(*args): self.fail('Command must not run outside disposable hosted CI')
        self.assertTrue(readiness.first_launch(run=forbidden, environment={}))
        self.assertTrue(readiness.first_launch(run=forbidden, environment={'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'self-hosted'}))

    def first_launch(self, codes):
        calls = []
        def run(args, timeout):
            calls.append((args, timeout))
            code = codes[len(calls)-1]
            return subprocess.CompletedProcess(args, code, '-checkFirstLaunchStatus' if '-help' in args else '', '')
        env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
               'DEVELOPER_DIR': '/Applications/Xcode_26.4.1.app/Contents/Developer'}
        with patch.object(Path, 'is_file', return_value=True):
            result = readiness.first_launch(run=run, environment=env)
        return result, calls

    def test_first_launch_already_ready_does_not_install(self):
        result, calls = self.first_launch([0, 0])
        self.assertTrue(result); self.assertEqual(len(calls), 2)

    def test_first_launch_required_installs_once_and_rechecks(self):
        result, calls = self.first_launch([0, 1, 0, 0])
        self.assertTrue(result); self.assertEqual(len(calls), 4)
        self.assertEqual(calls[2][0][-1], '-runFirstLaunch'); self.assertEqual(calls[2][1], 120)
        self.assertNotIn('sudo', calls[2][0])

    def test_first_launch_failure_never_continues(self):
        with self.assertRaises(RuntimeError): self.first_launch([0, 1, 1])
        with self.assertRaises(RuntimeError): self.first_launch([0, 64])
        self.assertFalse(self.first_launch([0, 1, 0, 1])[0])


if __name__ == '__main__': unittest.main(buffer=True)
