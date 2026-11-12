#!/usr/bin/env python3
"""Publish an allowlist of synthetic evidence, never raw fixture/xcresult data."""
import json
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from urllib.parse import quote


def redact(text, tokens):
    for token in sorted(tokens, key=len, reverse=True):
        text = text.replace(token, '[REDACTED]').replace(quote(token, safe=''), '[REDACTED]')
    text = re.sub(r'(?i)(Bearer\s+)[^\s"\'<>]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)(orca_session=)[^\s;"\'<>]+', r'\1[REDACTED]', text)
    return text


def failure_excerpt(text):
    """Keep early XCTest assertions visible even when later tests fill the tail."""
    lines = text.splitlines()
    # Prefer actionable test/compiler failures to simulator noise and successful
    # summaries such as "0 failures". Full sanitized logs remain in the artifact.
    primary = [index for index, line in enumerate(lines)
               if re.search(r'(?i)(:\d+(?::\d+)?: error:|Test Case .+ failed|'
                            r'XCTAssert\w*.*failed|Asynchronous wait failed|'
                            r'Testing failed:|\*\* TEST.*FAILED)', line)]
    matches = [index for index, line in enumerate(lines)
               if re.search(r'(?i)\b(error:|failed\b|failure\b|XCTAssert\w*)', line)]
    matches = primary + [index for index in matches if index not in primary]
    if not matches:
        return 'No failure marker found; inspect the sanitized log tail/artifact.'
    selected = set()
    for index in matches[:20]:
        selected.update(range(max(0, index - 1), min(len(lines), index + 2)))
    result = [f'{index + 1}: {lines[index][:1000]}' for index in sorted(selected)]
    if len(matches) > 20:
        result.append(f'Additional failure markers omitted: {len(matches) - 20}; inspect artifact.')
    return '\n'.join(result)



def feedback_test_summary(text):
    """Emit only known test identities and numeric outcomes, never log payloads."""
    known = {
        ('OrcaTests.FeedbackTicketTests', 'testLostResponseRetainsExactSubmissionUntilConfirmedTicket'),
        ('OrcaTests.FeedbackTicketTests', 'testAvailabilityFailsClosedAndBlocksOtherAccounts'),
        ('OrcaTests.FeedbackTicketTests', 'testChangingOwnerClearsDraftAndRejectsOldScopeActions'),
        ('OrcaTests.FeedbackTicketTests', 'testFeedbackValidationUsesWireLengthAndRequiresText'),
        ('OrcaTests.FeedbackTicketTests', 'testTicketLinkAcceptsOnlyHTTPSLinearURLs'),
        ('OrcaTests.FeedbackTicketTests', 'testMalformedReceiptNeverReportsSuccessOrDropsDraft'),
        ('OrcaTests.FeedbackTicketTests', 'testMediaRequiresReviewAndCleansUpOnOwnerChange'),
        ('OrcaTests.FeedbackTicketTests', 'testMediaRetryFreezesBytesAndSuccessRemovesPreview'),
        ('OrcaTests.FeedbackTicketTests', 'testMediaBoundsRemovalAndRejectedImportDoNotLoseDraft'),
        ('OrcaTests.FeedbackTicketTests', 'testImagePreparationStripsMetadataAndBoundsDecodedDimensions'),
        ('OrcaTests.FeedbackTicketTests', 'testScreenCaptureRequiresForegroundOriginatingScene'),
        ('OrcaTests.FeedbackTicketTests', 'testScreenRecordingReturnsUnreviewedMediaAndStopsAtLimit'),
        ('OrcaTests.FeedbackTicketTests', 'testScreenRecordingCancellationFencesLatePermissionAndAccountChange'),
        ('OrcaTests.FeedbackTicketTests', 'testScreenRecordingUnavailableAndOversizedResultsNeverAttach'),
        ('OrcaTests.FeedbackTicketTests', 'testScreenRecordingWriterProducesSilentBoundedVideo'),
        ('OrcaUITests.OrcaUITests', 'test38FeedbackCornerCreatesLinearTicket'),
        ('OrcaUITests.OrcaUITests', 'test39FeedbackCapturesCurrentOrcaScreen'),
    }
    pattern = re.compile(r"Test Case '-\[([A-Za-z.]+) ([A-Za-z0-9]+)\]' (passed|failed) \(([0-9]{1,6}(?:\.[0-9]{1,6})?) seconds\)\.")
    summaries = []
    for line in text.splitlines():
        match = pattern.fullmatch(line.strip())
        if match and (match[1], match[2]) in known:
            summaries.append(f'{match[1]}.{match[2]} {match[3]} ({match[4]} seconds)')
    return summaries[-20:]



def feedback_picker_excerpt(text):
    """Bound synthetic picker diagnostics from an already-redacted log."""
    output = []
    remaining = 8192
    for line in text.splitlines():
        marker = line.find('[feedback picker]')
        if marker < 0:
            continue
        line = ''.join(char for char in line[marker:] if ord(char) >= 32 and ord(char) != 127)
        line = line.replace('::', ': :').replace('##[', '# #[')[:512]
        # Bound UTF-8 bytes, including the printed newline, without splitting a character.
        line = line.encode('utf-8')[:remaining - 1].decode('utf-8', errors='ignore')
        if not line:
            break
        output.append(line)
        remaining -= len(line.encode('utf-8')) + 1
        if len(output) >= 40 or remaining <= 1:
            break
    return output


def native_diagnostic_excerpt(text):
    phases = 'sheet_dismissed|layout_begin|layout_end|render_begin|render_end|png_ready|attachment_begin|attachment_end|composer_reopen'
    patterns = [r'\[feedback capture\] phase=(?:' + phases + r')',
                r'\[simulator readiness\] attempt=\d{1,3} (?:exit=-?\d{1,3}|command_timeout=true) owned_destination=(?:True|False)',
                r'\[simulator readiness\] first_launch_status=\d{1,3}',
                r'\[simulator readiness\] deadline exceeded; owned simulator absent from Xcode available destinations']
    output = []
    for line in text.splitlines():
        # XCTest prefixes app stdout with a timestamp; accept only the entire
        # known static marker suffix, never append arbitrary app text.
        for pattern in patterns:
            match = re.search(pattern + r'$', line)
            if match:
                output.append(match[0]); break
    return output[-100:]


def crash_summary(text):
    """Strict JSON crash fields only; never publish raw reports, paths or values."""
    decoder = json.JSONDecoder()
    try:
        first, offset = decoder.raw_decode(text.lstrip())
        remaining = text.lstrip()[offset:].strip()
        report = json.loads(remaining) if remaining else first
    except (ValueError, TypeError):
        return []
    if not isinstance(report, dict) or report.get('procName') != 'Orca':
        return []
    bundle = report.get('bundleInfo')
    if not isinstance(bundle, dict) or bundle.get('CFBundleIdentifier') != 'com.orca.mail':
        return []
    output = []
    for group, keys in [('exception', ('type', 'signal')), ('termination', ('namespace', 'code'))]:
        values = report.get(group)
        if not isinstance(values, dict):
            continue
        for key in keys:
            value = str(values.get(key, ''))
            if re.fullmatch(r'[A-Za-z0-9_ -]{1,100}', value):
                output.append(f'[feedback crash] {group}.{key}={value}')
    frames = report.get('lastExceptionBacktrace', [])
    if not frames:
        threads = report.get('threads', [])
        frames = next((t.get('frames', []) for t in threads if isinstance(t, dict) and t.get('triggered')), []) if isinstance(threads, list) else []
    if not isinstance(frames, list):
        frames = []
    for frame in frames[:20]:
        if not isinstance(frame, dict):
            continue
        symbol = frame.get('symbol', '')
        # Symbols contain code identities, not crash addresses, argv or memory.
        if isinstance(symbol, str) and re.fullmatch(r'[A-Za-z_$+\-][A-Za-z0-9_$ .:+\-()<>?,*\[\]]{0,240}', symbol):
            output.append('[feedback crash] frame=' + symbol.replace('::', ': :'))
    return output[:24]


def read_capture_phases(container, owned_root):
    container = Path(container)
    if not container.resolve().is_relative_to(Path(owned_root).resolve()):
        return []
    path = container / 'Library/Caches/orca-fixture-capture-phases.log'
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(container.resolve()) or path.stat().st_size > 8192:
        return []
    phases = {'sheet_dismissed', 'layout_begin', 'layout_end', 'render_begin', 'render_end',
              'png_ready', 'attachment_begin', 'attachment_end', 'composer_reopen'}
    return ['[feedback capture] phase=' + line for line in path.read_text(errors='replace').splitlines()[-32:] if line in phases]


def owned_capture_phases(simulator):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or not re.fullmatch(r'[0-9A-Fa-f-]{36}', simulator):
        return []
    try:
        result = subprocess.run(['xcrun', 'simctl', 'get_app_container', simulator, 'com.orca.mail', 'data'],
                                capture_output=True, text=True, timeout=10, check=False)
        if result.returncode != 0:
            return []
        root = Path.home() / 'Library/Developer/CoreSimulator/Devices' / simulator / 'data/Containers/Data/Application'
        return read_capture_phases(result.stdout.strip(), root)
    except (OSError, subprocess.TimeoutExpired):
        return []


def hosted_crash_summaries(work, simulator=""):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        return []
    identity = work / 'identity.log'
    if not identity.is_file():
        return []
    started = identity.stat().st_mtime
    directories = [Path.home() / 'Library/Logs/DiagnosticReports']
    if re.fullmatch(r'[0-9A-Fa-f-]{36}', simulator):
        directories.append(Path.home() / 'Library/Developer/CoreSimulator/Devices' / simulator / 'data/Library/Logs/CrashReporter')
    candidates = [path for directory in directories for path in directory.glob('Orca-*.ips')]
    output = []
    for path in sorted(candidates)[-10:]:
        if path.is_symlink() or not path.is_file() or path.stat().st_mtime < started or path.stat().st_size > 5_000_000:
            continue
        output.extend(crash_summary(path.read_text(errors='replace')))
        if len(output) >= 72:
            break
    return output[:72]


def export(work, evidence, connection, status, simulator="", attachments_root=None):
    tokens = []
    if connection:
        connection_path = Path(connection).resolve()
        if not connection_path.is_relative_to(work.resolve()):
            raise ValueError('Connection metadata must belong to this run')
        metadata = json.loads(connection_path.read_text())
        tokens = [metadata[key] for key in ('token', 'accessToken') if metadata.get(key)]
    def write(name, text):
        (evidence / name).write_text(redact(text, tokens))
    for name in ('identity.log', 'checks.log', 'fixture.log'):
        if (work / name).is_file():
            write(name, (work / name).read_text(errors='replace'))
    write('outcome.json', json.dumps({'exitCode': int(status), 'syntheticOnly': True,
          'rawXcresultUploaded': False}, indent=2) + '\n')
    # The browser harness uses a new profile and blocks every external origin.
    screenshots = evidence / 'screenshots'
    for suite in ('browser', 'reader'):
        source_directory = work / suite
        if (source_directory / 'results.json').is_file():
            write(f'{suite}-results.json', (source_directory / 'results.json').read_text())
        if (source_directory / 'head-results.json').is_file():
            write(f'{suite}-catchup-results.json', (source_directory / 'head-results.json').read_text())
        if (source_directory / 'failure-dom.txt').is_file():
            write(f'{suite}-failure-dom.txt', (source_directory / 'failure-dom.txt').read_text())
        for source in sorted(source_directory.glob('*.png')):
            if source.is_symlink():
                raise ValueError('Screenshot symlinks are not allowed')
            screenshots.mkdir(exist_ok=True)
            name = source.name if suite == 'browser' else f'reader-{source.name}'
            shutil.copyfile(source, screenshots / name)
    # Raw bundles can contain XCTest launch arguments (a fixture bearer).
    # Export readable summaries and image attachments only, then redact text.
    for bundle in sorted((work / 'results').glob('*.xcresult')):
        for kind in ('summary', 'tests'):
            result = subprocess.run(['xcrun', 'xcresulttool', 'get', 'test-results', kind,
                                     '--path', str(bundle)], capture_output=True, text=True, check=True)
            json.loads(result.stdout)  # fail closed on a malformed export
            write(f'{bundle.stem}-{kind}.json', result.stdout)
        attachments = (attachments_root or work) / f'{bundle.stem}-attachments'
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(bundle),
                        '--output-path', str(attachments)], capture_output=True, check=True)
        for index, source in enumerate(sorted(attachments.rglob('*'))):
            if source.is_file() and source.suffix.lower() in ('.png', '.jpg', '.jpeg'):
                if source.is_symlink():
                    raise ValueError('Attachment symlinks are not allowed')
                screenshots.mkdir(exist_ok=True)
                shutil.copyfile(source, screenshots / f'{bundle.stem}-{index}{source.suffix.lower()}')
    phases = owned_capture_phases(simulator)
    if phases:
        checks_path = evidence / 'checks.log'
        write('checks.log', (checks_path.read_text() if checks_path.is_file() else '') + '\n' + '\n'.join(phases) + '\n')
    crash_lines = hosted_crash_summaries(work, simulator) if int(status) != 0 else []
    if crash_lines:
        write('native-crash-summary.log', '\n'.join(crash_lines) + '\n')
    # Verify the exact ephemeral credentials never appear in any published bytes.
    for path in evidence.rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            if any(token.encode() in data or quote(token, safe='').encode() in data for token in tokens):
                raise ValueError('Credential detected in evidence; refusing publication')
    # Print only after the complete export passed its credential scan. Prefix
    # every line so synthetic log content cannot become a workflow command.
    checks = evidence / 'checks.log'
    if checks.is_file():
        for summary in feedback_test_summary(checks.read_text()):
            print(f'[feedback test] {summary}')
        for line in feedback_picker_excerpt(checks.read_text()):
            print(line)
        for line in native_diagnostic_excerpt(checks.read_text()):
            print(line)
    crash_log = evidence / 'native-crash-summary.log'
    if crash_log.is_file():
        print(crash_log.read_text(), end='')
    native_times = re.findall(r'\[counter-native\] epoch_ms=(\d+)', checks.read_text() if checks.is_file() else '')
    # xcresult export can finish minutes after the assertion. Anchor server
    # liveness to the final native observation, not the later cleanup time.
    heartbeat_cutoff = int(native_times[-1]) + 10000 if native_times else None
    for name in ('checks.log', 'fixture.log'):
        path = evidence / name
        if not path.is_file():
            continue
        lines = path.read_text().splitlines()
        events = [line for line in lines if any(marker in line for marker in
                  ('[counter-native]', '[counter-server]', '[search-fixture]', '[search-fixture-server]'))]
        heartbeats = [line for line in lines if '[counter-heartbeat]' in line]
        if heartbeat_cutoff is not None:
            heartbeats = [line for line in heartbeats
                          if (match := re.search(r'epoch_ms=(\d+)', line))
                          and int(match[1]) <= heartbeat_cutoff]
        # Keep the last minute of server liveness and latest80 request events.
        # Also print on success so a non-reproduction still yields usable data.
        for line in events[-80:] + heartbeats[-60:]:
            line = line[:1000].replace('::', ': :').replace('##[', '# #[')
            print(f'[fixture telemetry] {name}: {line}')
    if int(status) != 0 and (evidence / 'checks.log').is_file():
        print('Sanitized failure context (bounded; full log remains in artifact):')
        for line in failure_excerpt((evidence / 'checks.log').read_text()).splitlines():
            line = line.replace('::', ': :').replace('##[', '# #[')
            print(f'[fixture failure] {line}')
    print(f'Synthetic checks exit code: {status}; sanitized evidence: {evidence}')


def export_staged(work, evidence, connection, status, simulator="", checkpoint_phase=None):
    """Never expose an unscanned export; retain completed Light on later failure."""
    if checkpoint_phase not in (None, 'suite_light_finished'):
        raise ValueError('Unknown evidence checkpoint phase')
    if evidence.is_symlink() or not evidence.is_dir():
        raise ValueError('Evidence must be the owned run directory')
    if checkpoint_phase is None:
        # Revoke any earlier final marker before attempting a replacement.
        (evidence / 'outcome.json').unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='validated-export-', dir=work) as directory:
        stage = Path(directory) / 'content'; stage.mkdir()
        attachments = Path(directory) / 'attachments'; attachments.mkdir()
        output = io.StringIO()
        with redirect_stdout(output):
            # A checkpoint has no final exit or crash collection. Its null
            # outcome below, not this internal export argument, is published.
            export(work, stage, connection, 0 if checkpoint_phase else status,
                   '' if checkpoint_phase else simulator, attachments_root=attachments)
        if checkpoint_phase:
            (stage / 'outcome.json').write_text(json.dumps({
                'exitCode': None, 'complete': False, 'checkpointPhase': checkpoint_phase,
                'syntheticOnly': True, 'rawXcresultUploaded': False,
            }, indent=2) + '\n')
            checkpoints = evidence / 'checkpoints'
            if checkpoints.is_symlink():
                raise ValueError('Checkpoint symlinks are not allowed')
            checkpoints.mkdir(exist_ok=True)
            destination = checkpoints / checkpoint_phase
            if destination.exists() or destination.is_symlink():
                raise ValueError('Checkpoint already published')
            os.replace(stage, destination)
            print('[fixture checkpoint] phase=suite_light_finished complete=false')
            return
        # Every byte was already scanned privately. Publish the final outcome
        # last, so interruption during copying cannot advertise a complete gate.
        files = sorted(p for p in stage.rglob('*') if p.is_file())
        files.sort(key=lambda p: p.name == 'outcome.json')
        for source in files:
            destination = evidence / source.relative_to(stage)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.parent.resolve().is_relative_to(evidence.resolve()):
                raise ValueError('Evidence destination escapes the owned directory')
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
                pending = Path(handle.name)
                try:
                    handle.write(source.read_bytes())
                    handle.close()
                    os.replace(pending, destination)
                finally:
                    pending.unlink(missing_ok=True)
        print(output.getvalue(), end='')


if __name__ == '__main__':
    export_staged(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4],
                  sys.argv[5] if len(sys.argv) > 5 else '',
                  sys.argv[6] if len(sys.argv) > 6 else None)
