#!/usr/bin/env python3
"""Execute real runner selection/phase code with fake Apple commands.

This tests installation lifecycle orchestration, never SwiftUI or APNs delivery.
The fake server keeps adopted installation rows across uninstalls, as production
does. Only a new app's installation identity creates a distinct policy namespace.
"""
import json, os, pathlib, subprocess, sys, tempfile

runner = pathlib.Path(__file__).resolve().parents[2] / 'OrcaUITests/run-fixture-tests.sh'
source = runner.read_text()
selection = source.split('if [[ ${ORCA_UI_TEST_SCOPE:-all} == images ]]; then', 1)[1].split('\n# BRE-468 adoption', 1)[0].split('\n# Check the recovered writer', 1)[0]
phases = source.split('light_exit=0\n', 1)[1]
adoption = source.split('# BEGIN isolated_adoption_phases\n', 1)[1].split('# END isolated_adoption_phases', 1)[0] if '# BEGIN isolated_adoption_phases' in source else ''
results = []
for scope in ['all', 'notifications', 'mailbox', 'compose']:
    with tempfile.TemporaryDirectory(prefix='bre457-runner-lifecycle-') as directory:
        root = pathlib.Path(directory)
        (root/'state.json').write_text(json.dumps({'installation': 0, 'adopted': [], 'calls': []}))
        mock = root/'mock.py'
        mock.write_text('''import json, os, pathlib, sys
p = pathlib.Path(os.environ['MOCK_ROOT'])/'state.json'; s = json.loads(p.read_text())
args = sys.argv[2:]; tool = sys.argv[1]; failed = False
if tool == 'xcrun' and 'uninstall' in args: s['installation'] += 1
if tool == 'xcodebuild':
    bundle = args[args.index('-resultBundlePath')+1]; pathlib.Path(bundle).mkdir()
    only = [x for x in args if x.startswith('-only-testing:')]
    skip = [x for x in args if x.startswith('-skip-testing:')]
    names = [x.split('/')[-1] for x in only]
    full = not only
    adoption = any(x.startswith('test48') for x in names) or (full and not any('test48' in x for x in skip))
    legacy = full or any(x.startswith(('test03','test06')) for x in names)
    failed = legacy and s['installation'] in s['adopted']
    s['calls'].append({'bundle':pathlib.Path(bundle).name,'installation':s['installation'],'legacy':legacy,'adoption':adoption,'contaminated':failed,'selectedCases':names})
    if adoption: s['adopted'].append(s['installation'])
p.write_text(json.dumps(s)); sys.exit(65 if failed else 0)
''')
        for tool in ['xcrun', 'xcodebuild']:
            path = root/tool; path.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{mock}" {tool} "$@"\n'); path.chmod(0o755)
        harness = root/'phases.zsh'
        harness.write_text('''set -euo pipefail
progress() { print -r -- "phase=$1"; }
result_dir=$MOCK_ROOT
result_bundle="$result_dir/Orca.xcresult"
injected_xctestrun=synthetic.xctestrun
simulator_udid=owned-synthetic-simulator
read_only=0
xcrun simctl uninstall "$simulator_udid" com.orca.mail
if [[ ${ORCA_UI_TEST_SCOPE:-all} == images ]]; then
''' + selection + '\n' + adoption + '\nlight_exit=0\n' + phases)
        run = subprocess.run(['zsh',str(harness)],env=dict(os.environ,PATH=f'{root}:{os.environ["PATH"]}',MOCK_ROOT=str(root),ORCA_UI_TEST_SCOPE=scope),capture_output=True,text=True)
        state = json.loads((root/'state.json').read_text())
        dedicated = [c for c in state['calls'] if c['adoption'] and not c['legacy']]
        ok = run.returncode == 0 and not any(c['contaminated'] for c in state['calls'])
        if scope == 'compose':
            # Compose does not run notification adoption; both actual theme
            # invocations must select the explicit destructive-action journey.
            needed = {'test53ExplicitLocalDiscardKeepsUnfinishedWritingOnCancelThenRemovesOnlyConfirmedCopy'}
            ok = ok and not dedicated and len(state['calls']) == 2 and all(needed.issubset(c['selectedCases']) for c in state['calls'])
        else:
            ok = ok and len(dedicated) == 2 and len({c['installation'] for c in dedicated}) == 2
        if scope == 'mailbox':
            normal = [c for c in state['calls'] if not c['adoption']]
            needed = {'test10NativeLongPressMovesConversationAndBuildsSenderView', 'test50PrimaryMailKeepsSubmittedQueryAcrossReaderRefreshWithUnsubmittedText', 'test51SenderViewShowsActualMatchingRowsAndExplicitSubjectRefinement', 'test52FirstSearchFromSavedViewShowsPendingSearchInsteadOfSavedRows', 'test54NamedSpacesCollectionsAndQueryPinsBrowseHideRestoreAndReturnToSource', 'test55FirstSearchFromCollectionAndQueryPinPreservesSubmittedAndUnfinishedQueries'}
            ok = ok and len(normal) == 2 and all(needed.issubset(c['selectedCases']) for c in normal)
        results.append({'scope':scope,'pass':ok,'exit':run.returncode,'calls':state['calls'],'output':run.stdout+run.stderr})
print(json.dumps({'proof':'real runner phase code with synthetic Apple commands, not native runtime','results':results},indent=2))
sys.exit(0 if all(r['pass'] for r in results) else 1)
