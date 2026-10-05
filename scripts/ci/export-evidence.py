#!/usr/bin/env python3
"""Publish an allowlist of synthetic evidence, never raw fixture/xcresult data."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


def redact(text, tokens):
    for token in sorted(tokens, key=len, reverse=True):
        text = text.replace(token, '[REDACTED]').replace(quote(token, safe=''), '[REDACTED]')
    text = re.sub(r'(?i)(Bearer\s+)[^\s"\'<>]+', r'\1[REDACTED]', text)
    text = re.sub(r'(?i)(orca_session=)[^\s;"\'<>]+', r'\1[REDACTED]', text)
    return text


def export(work, evidence, connection, status):
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
    for suite in ('browser', 'reader', 'search'):
        source_directory = work / suite
        if (source_directory / 'results.json').is_file():
            write(f'{suite}-results.json', (source_directory / 'results.json').read_text())
        if (source_directory / 'failure-dom.txt').is_file():
            write(f'{suite}-failure-dom.txt', (source_directory / 'failure-dom.txt').read_text())
        for source in sorted(source_directory.glob('*.png')):
            if source.is_symlink():
                raise ValueError('Screenshot symlinks are not allowed')
            screenshots.mkdir(exist_ok=True)
            name = source.name if suite == 'browser' else f'{suite}-{source.name}'
            shutil.copyfile(source, screenshots / name)
    # Raw bundles can contain XCTest launch arguments (a fixture bearer).
    # Export readable summaries and image attachments only, then redact text.
    for bundle in sorted((work / 'results').glob('*.xcresult')):
        for kind in ('summary', 'tests'):
            result = subprocess.run(['xcrun', 'xcresulttool', 'get', 'test-results', kind,
                                     '--path', str(bundle)], capture_output=True, text=True, check=True)
            json.loads(result.stdout)  # fail closed on a malformed export
            write(f'{bundle.stem}-{kind}.json', result.stdout)
        attachments = work / f'{bundle.stem}-attachments'
        subprocess.run(['xcrun', 'xcresulttool', 'export', 'attachments', '--path', str(bundle),
                        '--output-path', str(attachments)], capture_output=True, check=True)
        for index, source in enumerate(sorted(attachments.rglob('*'))):
            if source.is_file() and source.suffix.lower() in ('.png', '.jpg', '.jpeg'):
                if source.is_symlink():
                    raise ValueError('Attachment symlinks are not allowed')
                screenshots.mkdir(exist_ok=True)
                shutil.copyfile(source, screenshots / f'{bundle.stem}-{index}{source.suffix.lower()}')
    # Verify the exact ephemeral credentials never appear in any published bytes.
    for path in evidence.rglob('*'):
        if path.is_file():
            data = path.read_bytes()
            if any(token.encode() in data or quote(token, safe='').encode() in data for token in tokens):
                raise ValueError('Credential detected in evidence; refusing publication')
    print(f'Synthetic checks exit code: {status}; sanitized evidence: {evidence}')


if __name__ == '__main__':
    export(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4])
