#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('export-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def test_redacts_known_bearer_and_cookie(self):
        result = evidence.redact('token a+b/c Bearer other-secret orca_session=session-value; rest', ['a+b/c'])
        self.assertEqual(result, 'token [REDACTED] Bearer [REDACTED] orca_session=[REDACTED]; rest')
        self.assertEqual(evidence.redact('a%2Bb%2Fc', ['a+b/c']), '[REDACTED]')

    def test_allowlist_excludes_database_connection_and_raw_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'private'
            out = Path(directory) / 'public'
            work.mkdir(); out.mkdir()
            connection = work / 'connection.json'
            connection.write_text(json.dumps({'accessToken': 'private-credential'}))
            (work / 'checks.log').write_text('Bearer private-credential')
            (work / 'mail.sqlite').write_text('private-credential')
            evidence.export(work, out, str(connection), 1)
            self.assertEqual({p.name for p in out.iterdir()}, {'checks.log', 'outcome.json'})
            self.assertNotIn('private-credential', (out / 'checks.log').read_text())
            self.assertEqual(json.loads((out / 'outcome.json').read_text())['exitCode'], 1)

    def test_rejects_connection_outside_owned_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir(); (root / 'public').mkdir()
            with self.assertRaises(ValueError):
                evidence.export(root / 'private', root / 'public', str(root / 'connection.json'), 0)


if __name__ == '__main__':
    unittest.main()
