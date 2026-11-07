#!/bin/zsh

set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  print -u2 "usage: $0 <connection.json> <simulator-udid> [derived-data-path]"
  exit 64
fi

script_dir=${0:A:h}
ios_dir=${script_dir:h}
connection_file=${1:A}
simulator_udid=$2
derived_data=${3:-"${TMPDIR%/}/OrcaDerivedData"}

# Only the CI wrapper opens descriptor 3 for fixed, nonprivate progress markers.
# Preserve raw output in the private checks.log; never tee launch arguments.
progress() {
  print -r -- "[fixture stage] phase=$1"
  if [[ ${ORCA_CI_PROGRESS:-0} == 1 ]]; then
    print -r -u3 -- "[fixture stage] phase=$1"
  fi
}

if [[ ! -f $connection_file ]]; then
  print -u2 "fixture metadata not found: $connection_file"
  exit 66
fi

# Preserve the runner's wait for a caller-supplied booting simulator, before
# requiring post-boot diagnostics or asking Xcode to build for that device.
progress owned_simulator_recheck_started
xcrun simctl bootstatus "$simulator_udid" -b
progress owned_simulator_recheck_finished
# fixture-check.sh boots this exact CI-owned simulator before invoking us.
# Observe both CoreSimulator and Xcode: bootstatus has reported Finished while
# Xcode could see no concrete destination. Never substitute another device.
mkdir -p "$derived_data"
xcrun simctl list --json > "$derived_data/fixture-simulator-inventory.json"
/usr/bin/python3 - "$derived_data/fixture-simulator-inventory.json" "$simulator_udid" <<'PYDIAGNOSTIC'
import json, sys
inventory = json.load(open(sys.argv[1]))
selected = [(runtime, device) for runtime, devices in inventory.get('devices', {}).items()
            for device in devices if device.get('udid') == sys.argv[2]]
if len(selected) != 1:
    raise SystemExit('Owned simulator is missing or ambiguous in post-boot inventory')
runtime_id, device = selected[0]
runtime = next((r for r in inventory.get('runtimes', []) if r.get('identifier') == runtime_id), {})
print('[simulator readiness] ' + json.dumps({
    'device': {key: device.get(key) for key in ('udid', 'name', 'deviceTypeIdentifier', 'state', 'isAvailable')},
    'runtime': {key: runtime.get(key) for key in ('identifier', 'version', 'buildversion', 'isAvailable')},
}, sort_keys=True))
if device.get('state') != 'Booted' or not device.get('isAvailable') or not runtime.get('isAvailable'):
    raise SystemExit('Owned simulator/runtime is not booted and available; refusing test execution')
PYDIAGNOSTIC
xcrun --find xcodebuild
xcodebuild -version
xcodebuild -showsdks
progress xcode_destination_started
if ! /usr/bin/python3 "$ios_dir/../../scripts/ci/ios-readiness.py" \
  --project "$ios_dir/Orca.xcodeproj" --udid "$simulator_udid" \
  --log "$derived_data/fixture-xcode-destinations.log"; then
  cat "$derived_data/fixture-xcode-destinations.log"
  print -u2 'Xcode destination discovery failed before build; no simulator substitution attempted.'
  exit 70
fi
cat "$derived_data/fixture-xcode-destinations.log"
progress xcode_destination_finished

progress build_for_testing_started
xcodebuild build-for-testing \
  -project "$ios_dir/Orca.xcodeproj" \
  -scheme Orca \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO
progress build_for_testing_finished

products_dir="$derived_data/Build/Products"
base_xctestrun=($products_dir/Orca_iphonesimulator*.xctestrun(N[1]))
if (( ${#base_xctestrun} == 0 )); then
  print -u2 "no Orca simulator xctestrun found in $products_dir"
  exit 70
fi

injected_xctestrun="$products_dir/Orca_FixtureInjected.xctestrun"
cp "$base_xctestrun[1]" "$injected_xctestrun"

# Keep the synthetic bearer out of shell output and source control. The test
# runner receives it only through the copied xctestrun environment.
/usr/bin/python3 - "$connection_file" "$injected_xctestrun" <<'PY'
import json
import plistlib
import sys
from datetime import datetime, timezone

connection_path, xctestrun_path = sys.argv[1:]
with open(connection_path, encoding="utf-8") as handle:
    connection = json.load(handle)
with open(xctestrun_path, "rb") as handle:
    xctestrun = plistlib.load(handle)

environment = xctestrun["OrcaUITests"].setdefault("EnvironmentVariables", {})
environment["ORCA_FIXTURE_API_URL"] = connection["apiURL"]
environment["ORCA_FIXTURE_ACCESS_TOKEN"] = connection["accessToken"]
environment["ORCA_FIXTURE_IMAGES"] = "1" if connection.get("imageFixture", False) else "0"
environment["ORCA_FIXTURE_READ_ONLY"] = "1" if connection.get("readOnly", False) else "0"
environment["ORCA_FIXTURE_MEDIA_DAY"] = datetime.now(timezone.utc).strftime("%B %d")

with open(xctestrun_path, "wb") as handle:
    plistlib.dump(xctestrun, handle)
PY

# Seed only a generated, nonprivate image for the system Photos picker test.
if [[ ${ORCA_UI_TEST_SCOPE:-all} == compose || ${ORCA_UI_TEST_SCOPE:-all} == all ]]; then
  /usr/bin/python3 - "$derived_data/feedback-synthetic.png" <<'PYMEDIA'
import base64, sys
with open(sys.argv[1], "wb") as file:
    file.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQ6FlAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULALhwEEy5eilwAAAAAElFTkSuQmCC"))
PYMEDIA
  xcrun simctl addmedia "$simulator_udid" "$derived_data/feedback-synthetic.png" "$ios_dir/../web/scripts/fixtures/feedback-media/synthetic.mp4"
fi

xcrun simctl uninstall "$simulator_udid" com.orca.mail >/dev/null 2>&1 || true
result_dir=${ORCA_UI_RESULT_DIRECTORY:-$(mktemp -d "${TMPDIR%/}/orca-ios-tests-XXXXXX")}
mkdir -p "$result_dir"
result_bundle="$result_dir/Orca.xcresult"
# AppleInterfaceStyle launch defaults do not reliably change simulator appearance.
trap 'xcrun simctl ui "$simulator_udid" appearance light >/dev/null 2>&1 || true' EXIT
xcrun simctl ui "$simulator_udid" appearance light

read_only=$(/usr/bin/python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("readOnly",False) else "0")' "$connection_file")
if [[ ${ORCA_UI_TEST_SCOPE:-all} == images ]]; then
  light_tests=(-only-testing:OrcaUITests/ReaderUITests/testImagesRequireExplicitLoadingAndResetOnReopen -only-testing:OrcaUITests/ReaderUITests/testOversizedImageSnapshotRefreshOffersReadOnlyRecovery)
  dark_tests=("${light_tests[@]}")
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == compose ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test01InboxSearchReplyDraftSurvivesReopenAndSendsOnceInLightMode -only-testing:OrcaUITests/OrcaUITests/test14SendingAccessRefreshPreservesWritingThroughFailureAndUpgrade -only-testing:OrcaUITests/OrcaUITests/test15ServerDraftDeliveryCanBeCheckedWithoutSendingAgain -only-testing:OrcaUITests/OrcaUITests/test16AttachmentRemovalPersistsAndOnlyRemainingFileIsSent -only-testing:OrcaUITests/OrcaUITests/test17ForegroundRefreshUnlocksSendingWithoutRelaunch -only-testing:OrcaUITests/OrcaUITests/test18ConflictCopyKeepsLatestWritingAndRemovedAttachmentAfterTermination -only-testing:OrcaUITests/OrcaUITests/test30BackAndReopenDuringFirstCreateDoesNotDeliverTwice -only-testing:OrcaUITests/OrcaUITests/test31SentServerDraftDoesNotRemainAnEditableLocalCopy -only-testing:OrcaUITests/OrcaUITests/test32SentServerPreservesUnsentLocalEditsUntilExplicitCopy -only-testing:OrcaUITests/OrcaUITests/test33RichDraftRequiresConfirmationAndCancelPreservesHTML -only-testing:OrcaUITests/OrcaUITests/test34RichDraftExplicitConversionPersistsAfterReopen -only-testing:OrcaUITests/OrcaUITests/test35RichDraftConversionAtAccessibilitySize -only-testing:OrcaUITests/OrcaUITests/test36SentRecoveryStatusAtAccessibilitySize -only-testing:OrcaUITests/OrcaUITests/test20EmptyInboxCanRefreshIntoMail -only-testing:OrcaUITests/OrcaUITests/test21MoveCatalogLoadCanBeCancelledAndReopened -only-testing:OrcaUITests/OrcaUITests/test22SenderViewCatalogLoadCanBeSwipedAway)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test01InboxSearchReplyDraftSurvivesReopenAndSendsOnceInLightMode -only-testing:OrcaUITests/OrcaUITests/test14SendingAccessRefreshPreservesWritingThroughFailureAndUpgrade -only-testing:OrcaUITests/OrcaUITests/test15ServerDraftDeliveryCanBeCheckedWithoutSendingAgain -only-testing:OrcaUITests/OrcaUITests/test16AttachmentRemovalPersistsAndOnlyRemainingFileIsSent -only-testing:OrcaUITests/OrcaUITests/test17ForegroundRefreshUnlocksSendingWithoutRelaunch -only-testing:OrcaUITests/OrcaUITests/test18ConflictCopyKeepsLatestWritingAndRemovedAttachmentAfterTermination -only-testing:OrcaUITests/OrcaUITests/test30BackAndReopenDuringFirstCreateDoesNotDeliverTwice -only-testing:OrcaUITests/OrcaUITests/test31SentServerDraftDoesNotRemainAnEditableLocalCopy -only-testing:OrcaUITests/OrcaUITests/test32SentServerPreservesUnsentLocalEditsUntilExplicitCopy -only-testing:OrcaUITests/OrcaUITests/test33RichDraftRequiresConfirmationAndCancelPreservesHTML -only-testing:OrcaUITests/OrcaUITests/test34RichDraftExplicitConversionPersistsAfterReopen -only-testing:OrcaUITests/OrcaUITests/test35RichDraftConversionAtAccessibilitySize -only-testing:OrcaUITests/OrcaUITests/test36SentRecoveryStatusAtAccessibilitySize -only-testing:OrcaUITests/OrcaUITests/test20EmptyInboxCanRefreshIntoMail -only-testing:OrcaUITests/OrcaUITests/test21MoveCatalogLoadCanBeCancelledAndReopened -only-testing:OrcaUITests/OrcaUITests/test22SenderViewCatalogLoadCanBeSwipedAway -only-testing:OrcaUITests/OrcaUITests/test38FeedbackCornerCreatesLinearTicket -only-testing:OrcaUITests/OrcaUITests/test39FeedbackCapturesCurrentOrcaScreen)
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == overscroll ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test12InboxIntroductionScrollsWithMailAndRefreshSettles -only-testing:OrcaUITests/OrcaUITests/test13MailboxControlsRemainVisibleWhileRefreshing)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test12InboxIntroductionScrollsWithMailAndRefreshSettles -only-testing:OrcaUITests/OrcaUITests/test13MailboxControlsRemainVisibleWhileRefreshing)
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == actions ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test10NativeLongPressMovesConversationAndBuildsSenderView -only-testing:OrcaUITests/OrcaUITests/test11NativeSenderMoveRetainsBothConversationsInAllMail)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test10NativeLongPressMovesConversationAndBuildsSenderView -only-testing:OrcaUITests/OrcaUITests/test11NativeSenderMoveRetainsBothConversationsInAllMail)
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == views ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test07ConversationOpensAtLatestMessage -only-testing:OrcaUITests/OrcaUITests/test08VisibleViewsAreIndependentAndPersist -only-testing:OrcaUITests/OrcaUITests/test09EmptySavedViewKeepsMailboxMenuAvailable)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test08VisibleViewsAreIndependentAndPersist -only-testing:OrcaUITests/OrcaUITests/test09EmptySavedViewKeepsMailboxMenuAvailable)
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == reading ]]; then
  light_tests=(-only-testing:OrcaUITests/OrcaUITests/test37LongConversationOffersOffscreenUnreadAndLatestJumps -only-testing:OrcaUITests/ReaderUITests -only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test04StyledHTMLUsesReadableCanvas -only-testing:OrcaUITests/OrcaUITests/test07ConversationOpensAtLatestMessage)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test37LongConversationOffersOffscreenUnreadAndLatestJumps -only-testing:OrcaUITests/ReaderUITests -only-testing:OrcaUITests/OrcaUITests/test04StyledHTMLUsesReadableCanvas -only-testing:OrcaUITests/OrcaUITests/test07ConversationOpensAtLatestMessage)
elif [[ ${ORCA_UI_TEST_SCOPE:-all} == notifications ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test03VisualControlStates -only-testing:OrcaUITests/OrcaUITests/test06NotificationDestinationsPersist)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test03VisualControlStates -only-testing:OrcaUITests/OrcaUITests/test06NotificationDestinationsPersist)
elif [[ $read_only == 1 ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
else
  light_tests=(-skip-testing:OrcaUITests/OrcaUITests/test02SettingsRenderInDarkMode -skip-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test08VisibleViewsAreIndependentAndPersist -only-testing:OrcaUITests/OrcaUITests/test09EmptySavedViewKeepsMailboxMenuAvailable -only-testing:OrcaUITests/OrcaUITests/test07ConversationOpensAtLatestMessage -only-testing:OrcaUITests/OrcaUITests/test02SettingsRenderInDarkMode -only-testing:OrcaUITests/OrcaUITests/test03VisualControlStates -only-testing:OrcaUITests/OrcaUITests/test04StyledHTMLUsesReadableCanvas -only-testing:OrcaUITests/OrcaUITests/test06NotificationDestinationsPersist)
fi

# Run the changed feedback contract and real Photos picker before the longer
# compose suite. Every other existing test still runs after this gate succeeds.
if [[ ${ORCA_UI_TEST_SCOPE:-all} == compose ]]; then
  progress capture_light_started
  xcodebuild test-without-building \
    -xctestrun "$injected_xctestrun" \
    -destination "platform=iOS Simulator,id=$simulator_udid" \
    -parallel-testing-enabled NO \
    -resultBundlePath "$result_dir/DirectCaptureLight.xcresult" \
    -only-testing:OrcaTests/FeedbackTicketTests \
    -only-testing:OrcaUITests/OrcaUITests/test39FeedbackCapturesCurrentOrcaScreen
  progress capture_light_finished
  # Isolate current-screen capture from any preceding system Photos session.
  # Photos import remains a required independent gate, not a skipped fallback.
  progress feedback_light_started
  xcodebuild test-without-building \
    -xctestrun "$injected_xctestrun" \
    -destination "platform=iOS Simulator,id=$simulator_udid" \
    -parallel-testing-enabled NO \
    -resultBundlePath "$result_dir/FeedbackLight.xcresult" \
    -only-testing:OrcaUITests/OrcaUITests/test38FeedbackCornerCreatesLinearTicket
  progress feedback_light_finished
  light_tests+=(-skip-testing:OrcaTests/FeedbackTicketTests)
fi

progress suite_light_started
xcodebuild test-without-building \
  -xctestrun "$injected_xctestrun" \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$result_bundle" \
  "${light_tests[@]}"
progress suite_light_finished

xcrun simctl ui "$simulator_udid" appearance dark
progress suite_dark_started
xcodebuild test-without-building \
  -xctestrun "$injected_xctestrun" \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$result_dir/OrcaDark.xcresult" \
  "${dark_tests[@]}"
progress suite_dark_finished

print "Result bundle: $result_bundle"
