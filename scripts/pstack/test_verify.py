"""Behavioral checks for evidence rejection, subprocess cleanup and isolation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('verify', Path(__file__).with_name('verify.py'))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class VerificationTests(unittest.TestCase):
    def test_inventory_detects_mutation_and_includes_nested_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'checks.log').write_text('proof')
            (directory / 'nested').mkdir()
            (directory / 'nested/manifest.json').write_text('{}')
            before = verify.inventory(directory)
            self.assertIn('nested/manifest.json', before)
            (directory / 'checks.log').write_text('changed')
            self.assertNotEqual(before, verify.inventory(directory))

    def test_inventory_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'escape').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError, 'symlinks'):
                verify.inventory(directory)

    def test_wrong_commit_rejected_before_git_or_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / 'manifest.json').write_text(json.dumps({'testedCommit': 'a' * 40}))
            with self.assertRaisesRegex(ValueError, 'exact commit'):
                verify.validate(directory, 'b' * 40)

    def test_owned_process_stops(self):
        process = subprocess.Popen(['python3', '-c', 'import time; time.sleep(60)'], start_new_session=True)
        verify.stop(process)
        self.assertIsNotNone(process.poll())

    def test_command_timeout_stops_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / 'pid'
            with (Path(tmp) / 'log').open('w') as log:
                with self.assertRaises(subprocess.TimeoutExpired):
                    verify.run(['python3', '-c', 'import os,time; open("pid","w").write(str(os.getpid())); time.sleep(60)'], tmp, {'PATH': '/usr/bin:/bin'}, log, timeout=.2)
            import os
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pidfile.read_text()), 0)

    def test_doctor_does_not_install_missing_runtime(self):
        with patch.object(verify.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'Missing bun'):
                verify.doctor()


if __name__ == '__main__':
    unittest.main()
