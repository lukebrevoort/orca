#!/usr/bin/env python3
import importlib.util
import json
import io
from contextlib import redirect_stdout
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('export-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def test_picker_diagnostics_are_redacted_before_printing_on_success_and_failure(self):
        for status in (0, 65):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                work = Path(directory) / 'private'; out = Path(directory) / 'public'
                work.mkdir(); out.mkdir()
                connection = work / 'connection.json'
                connection.write_text(json.dumps({'accessToken': 'picker-secret'}))
                (work / 'checks.log').write_text(
                    'timestamp [feedback picker] Button label=Photos picker-secret Bearer hidden-token\n'
                    '[feedback picker] Image id=orca_session=hidden-cookie; ::error::##[warning]\x1b\x00\n'
                    'unrelated private label\n')
                output = io.StringIO()
                with redirect_stdout(output): evidence.export(work, out, str(connection), status)
                text = output.getvalue()
                self.assertIn('[feedback picker] Button label=Photos', text)
                self.assertIn('[REDACTED]', text)
                for forbidden in ('picker-secret', 'hidden-token', 'hidden-cookie', '::', '##['):
                    self.assertNotIn(forbidden, text)
                picker_lines = '\n'.join(line for line in text.splitlines() if line.startswith('[feedback picker]'))
                for forbidden in ('\x1b', '\x00', 'unrelated private label'):
                    self.assertNotIn(forbidden, picker_lines)

    def test_picker_diagnostics_bound_lines_bytes_and_preserve_full_sanitized_log(self):
        self.assertEqual(len(evidence.feedback_picker_excerpt('[feedback picker] Cell\n' * 100)), 40)
        bounded = evidence.feedback_picker_excerpt(('[feedback picker] ' + '界' * 5000 + '\n') * 100)
        self.assertLessEqual(len(('\n'.join(bounded) + '\n').encode('utf-8')), 8192)
        self.assertTrue(all(len(line) <= 512 for line in bounded))
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'private'; out = Path(directory) / 'public'
            work.mkdir(); out.mkdir()
            (work / 'checks.log').write_text('[feedback picker] Cell label=synthetic\n' * 100)
            output = io.StringIO()
            with redirect_stdout(output): evidence.export(work, out, '', 0)
            self.assertEqual(output.getvalue().count('[feedback picker]'), 40)
            self.assertEqual((out / 'checks.log').read_text().count('[feedback picker]'), 100)

    def test_feedback_summary_exposes_only_known_terminal_test_results(self):
        unit = "Test Case '-[OrcaTests.FeedbackTicketTests testTicketLinkAcceptsOnlyHTTPSLinearURLs]' passed (0.004 seconds)."
        ui = "Test Case '-[OrcaUITests.OrcaUITests test38FeedbackCornerCreatesLinearTicket]' failed (52.541 seconds)."
        text = '\n'.join([unit, ui, unit + ' private-payload ::error::',
                         "Test Case '-[OrcaTests.OtherTests privatePayload]' passed (0.1 seconds).",
                         '[feedback-fixture] arbitrary private-payload', unit.replace('passed', 'started')])
        summaries = evidence.feedback_test_summary(text)
        self.assertEqual(len(summaries), 2)
        self.assertIn('passed (0.004 seconds)', summaries[0])
        self.assertIn('failed (52.541 seconds)', summaries[1])
        self.assertNotIn('private', ' '.join(summaries))
        self.assertEqual(len(evidence.feedback_test_summary((unit + '\n') * 100)), 20)

    def test_feedback_summary_is_printed_after_redaction_on_success_and_failure(self):
        for status in (0, 65):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                work = Path(directory) / 'private'; out = Path(directory) / 'public'
                work.mkdir(); out.mkdir()
                connection = work / 'connection.json'
                connection.write_text(json.dumps({'accessToken': 'feedback-secret'}))
                (work / 'checks.log').write_text(
                    "Test Case '-[OrcaTests.FeedbackTicketTests testTicketLinkAcceptsOnlyHTTPSLinearURLs]' passed (0.004 seconds).\n"
                    'noise feedback-secret\n' + 'later output\n' * 200)
                output = io.StringIO()
                with redirect_stdout(output): evidence.export(work, out, str(connection), status)
                self.assertIn('[feedback test] OrcaTests.FeedbackTicketTests.testTicketLinkAcceptsOnlyHTTPSLinearURLs passed (0.004 seconds)', output.getvalue())
                self.assertNotIn('feedback-secret', output.getvalue())

    def test_search_telemetry_is_redacted_bounded_and_keeps_full_log(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'private'; out = Path(directory) / 'public'
            work.mkdir(); out.mkdir()
            connection = work / 'connection.json'
            connection.write_text(json.dumps({'accessToken': 'search-secret'}))
            log = '[search-fixture] submitted-value=Jordan search-secret ::error::\n' * 100
            (work / 'checks.log').write_text(log)
            (work / 'fixture.log').write_text('[search-fixture-server] response_ready status=200\n')
            output = io.StringIO()
            with redirect_stdout(output): evidence.export(work, out, str(connection), 0)
            self.assertEqual(output.getvalue().count('[search-fixture]'), 80)
            self.assertIn('[search-fixture-server]', output.getvalue())
            self.assertNotIn('search-secret', output.getvalue())
            self.assertNotIn('::', output.getvalue())
            self.assertEqual((out / 'checks.log').read_text().count('[search-fixture]'), 100)

    def test_assertion_is_not_hidden_by_passing_summaries_or_runtime_noise(self):
        text = ('Executed 14 tests, with 0 failures (0 unexpected)\n' * 25
                + 'runtime error: process does not exist\n' * 25
                + '/fixture/OrcaUITests.swift:907: error: -[OrcaUITests testSearch] : XCTAssertTrue failed\n'
                + "Test Case '-[OrcaUITests testSearch]' failed (51 seconds).\n")
        excerpt = evidence.failure_excerpt(text)
        self.assertIn('OrcaUITests.swift:907:', excerpt)
        self.assertIn("testSearch]' failed", excerpt)
        self.assertLessEqual(len(excerpt.splitlines()), 61)

    def test_heartbeat_excerpt_is_anchored_before_delayed_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'private'; out = Path(directory) / 'public'
            work.mkdir(); out.mkdir()
            (work / 'checks.log').write_text('[counter-native] epoch_ms=100000 id=x event=created\n')
            (work / 'fixture.log').write_text(''.join(
                f'[counter-heartbeat] epoch_ms={i * 1000}\n' for i in range(200)))
            output = io.StringIO()
            with redirect_stdout(output):
                evidence.export(work, out, '', 65)
            self.assertIn('[counter-heartbeat] epoch_ms=100000', output.getvalue())
            self.assertNotIn('[counter-heartbeat] epoch_ms=199000', output.getvalue())
            self.assertEqual(output.getvalue().count('[counter-heartbeat]'), 60)

    def test_counter_telemetry_survives_long_logs_on_success_and_failure(self):
        for status in (0, 65):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                work = Path(directory) / 'private'; out = Path(directory) / 'public'
                work.mkdir(); out.mkdir()
                connection = work / 'connection.json'
                connection.write_text(json.dumps({'accessToken': 'counter-secret'}))
                (work / 'checks.log').write_text('[counter-native] started counter-secret ::error::\n' + 'noise\n' * 300)
                (work / 'fixture.log').write_text(
                    '[counter-server] received counter-secret\n' +
                    ''.join(f'[counter-heartbeat] epoch_ms={i}\n' for i in range(200)) +
                    '[counter-server] response_ready\n')
                output = io.StringIO()
                with redirect_stdout(output):
                    evidence.export(work, out, str(connection), status)
                text = output.getvalue()
                self.assertIn('[counter-native] started', text)
                self.assertIn('[counter-server] received', text)
                self.assertIn('[counter-server] response_ready', text)
                self.assertIn('[counter-heartbeat] epoch_ms=199', text)
                self.assertNotIn('counter-secret', text)
                self.assertNotIn('::', text)
                self.assertLessEqual(text.count('[counter-heartbeat]'), 60)
                self.assertEqual(json.loads((out / 'outcome.json').read_text())['exitCode'], status)

    def test_counter_events_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory) / 'private'; out = Path(directory) / 'public'
            work.mkdir(); out.mkdir()
            (work / 'checks.log').write_text(('[counter-native] ' + 'x' * 5000 + '\n') * 1000)
            output = io.StringIO()
            with redirect_stdout(output):
                evidence.export(work, out, '', 0)
            self.assertEqual(output.getvalue().count('[fixture telemetry]'), 80)
            self.assertLess(len(output.getvalue()), 85000)

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

    def test_reader_evidence_uses_same_allowlist_redaction_and_distinct_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / 'private'; out = root / 'public'
            work.mkdir(); out.mkdir()
            (work / 'browser').mkdir(); (work / 'reader').mkdir()
            connection = work / 'connection.json'
            connection.write_text(json.dumps({'token': 'ephemeral-test-token'}))
            (work / 'reader' / 'results.json').write_text(json.dumps({'text': 'ephemeral-test-token'}))
            (work / 'reader' / 'failure-dom.txt').write_text('orca_session=ephemeral-test-token;')
            (work / 'reader' / 'connection.json').write_text('must not upload')
            (work / 'browser' / 'light.png').write_bytes(b'synthetic browser screenshot')
            (work / 'reader' / 'light.png').write_bytes(b'synthetic reader screenshot')
            evidence.export(work, out, str(connection), 0)
            self.assertEqual({p.name for p in out.iterdir()}, {
                'outcome.json', 'reader-results.json', 'reader-failure-dom.txt', 'screenshots'})
            self.assertNotIn('ephemeral-test-token', (out / 'reader-results.json').read_text())
            self.assertNotIn('ephemeral-test-token', (out / 'reader-failure-dom.txt').read_text())
            self.assertEqual({p.name for p in (out / 'screenshots').iterdir()}, {'light.png', 'reader-light.png'})

    def test_early_failure_is_visible_redacted_and_cannot_issue_workflow_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work = root / 'private'; out = root / 'public'
            work.mkdir(); out.mkdir()
            connection = work / 'connection.json'
            connection.write_text(json.dumps({'accessToken': 'fixture-secret'}))
            (work / 'checks.log').write_text(
                "Test Case 'testEarly' started.\n"
                "::error::##[add-mask]XCTAssertTrue failed fixture-secret Bearer another-secret orca_session=cookie-secret;\n"
                "Test Case 'testEarly' failed.\n" + "later successful output\n" * 200)
            output = io.StringIO()
            with redirect_stdout(output):
                evidence.export(work, out, str(connection), 65)
            text = output.getvalue()
            self.assertIn("testEarly", text)
            self.assertIn("XCTAssertTrue failed", text)
            for secret in ('fixture-secret', 'another-secret', 'cookie-secret'):
                self.assertNotIn(secret, text)
            self.assertNotIn('::', text)
            self.assertNotIn('##[', text)
            self.assertEqual(json.loads((out / 'outcome.json').read_text())['exitCode'], 65)

    def test_failure_excerpt_is_bounded_and_handles_missing_markers(self):
        output = evidence.failure_excerpt(('error: ' + 'x' * 5000 + '\n') * 1000)
        self.assertLess(len(output), 65000)
        self.assertIn('Additional failure markers omitted: 980', output)
        self.assertIn('No failure marker found', evidence.failure_excerpt('ordinary output'))

    def test_success_does_not_print_failure_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work = root / 'private'; out = root / 'public'
            work.mkdir(); out.mkdir()
            (work / 'checks.log').write_text('expected failure in a passing negative test')
            output = io.StringIO()
            with redirect_stdout(output):
                evidence.export(work, out, '', 0)
            self.assertNotIn('[fixture failure]', output.getvalue())

    def test_credential_scan_failure_does_not_print_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); work = root / 'private'; out = root / 'public'
            work.mkdir(); out.mkdir(); (work / 'browser').mkdir()
            connection = work / 'connection.json'
            connection.write_text(json.dumps({'token': 'private-fixture-secret'}))
            (work / 'checks.log').write_text('error: private-fixture-secret\n[feedback picker] Image private-fixture-secret')
            (work / 'fixture.log').write_text('[counter-server] received private-fixture-secret')
            (work / 'browser' / 'image.png').write_bytes(b'private-fixture-secret')
            output = io.StringIO()
            with redirect_stdout(output), self.assertRaises(ValueError):
                evidence.export(work, out, str(connection), 65)
            self.assertEqual(output.getvalue(), '')

    def test_rejects_connection_outside_owned_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'private').mkdir(); (root / 'public').mkdir()
            with self.assertRaises(ValueError):
                evidence.export(root / 'private', root / 'public', str(root / 'connection.json'), 0)


if __name__ == '__main__':
    unittest.main()
