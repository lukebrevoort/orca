"""Exercise the real runner exit boundary, without compiling or editing source.

Only stage commands and the final Git observation are controlled. These are
runner regressions, not evidence that the API or TypeScript checks passed.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("candidate_gate", Path(__file__).with_name("run-candidate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class FinalSourceBoundary(unittest.TestCase):
    def run_gate(self, *, changed_head=False, dirty=False, stage_failure=False):
        original_git = gate.git
        head = original_git("rev-parse", "HEAD")
        calls = {"head": 0, "status": 0}

        def observed_git(*args):
            if args == ("rev-parse", "HEAD"):
                calls["head"] += 1
                if changed_head and calls["head"] > 1:
                    return gate.BASELINE
            if args == ("status", "--porcelain"):
                calls["status"] += 1
                if dirty and calls["status"] > 1:
                    return " M apps/api/src/mailbox/read.ts"
            return original_git(*args)

        with tempfile.TemporaryDirectory(prefix="bre457-runner-boundary-") as temporary:
            evidence = Path(temporary) / "evidence"
            command = "/usr/bin/false" if stage_failure else "/usr/bin/true"
            with patch.object(gate, "git", observed_git), patch.object(gate, "typecheck_command", return_value=[command]), patch.object(sys, "argv", [str(spec.origin), str(evidence), head, "--types-only"]):
                try:
                    code = gate.main()
                except SystemExit as error:
                    code = error.code
            manifest = json.loads((evidence / "manifest.json").read_text())
            return code, manifest

    def test_clean_source_preserves_success(self):
        code, manifest = self.run_gate()
        self.assertEqual(code, 0)
        self.assertEqual(manifest["finalHead"], manifest["testedHead"])
        self.assertEqual(manifest["finalStatus"], "")

    def test_changed_head_rejects_success(self):
        code, manifest = self.run_gate(changed_head=True)
        self.assertNotEqual(manifest["finalHead"], manifest["testedHead"])
        self.assertEqual(code, 2)

    def test_dirty_source_rejects_success(self):
        code, manifest = self.run_gate(dirty=True)
        self.assertTrue(manifest["finalStatus"])
        self.assertEqual(code, 2)

    def test_clean_source_preserves_stage_failure(self):
        code, manifest = self.run_gate(stage_failure=True)
        self.assertEqual(code, 1)
        self.assertEqual(manifest["stages"][0]["exitCode"], 1)


if __name__ == "__main__":
    unittest.main()
