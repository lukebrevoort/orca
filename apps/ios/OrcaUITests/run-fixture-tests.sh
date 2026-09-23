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

if [[ ! -f $connection_file ]]; then
  print -u2 "fixture metadata not found: $connection_file"
  exit 66
fi

xcodebuild build-for-testing \
  -project "$ios_dir/Orca.xcodeproj" \
  -scheme Orca \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -derivedDataPath "$derived_data"

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

connection_path, xctestrun_path = sys.argv[1:]
with open(connection_path, encoding="utf-8") as handle:
    connection = json.load(handle)
with open(xctestrun_path, "rb") as handle:
    xctestrun = plistlib.load(handle)

environment = xctestrun["OrcaUITests"].setdefault("EnvironmentVariables", {})
environment["ORCA_FIXTURE_API_URL"] = connection["apiURL"]
environment["ORCA_FIXTURE_ACCESS_TOKEN"] = connection["accessToken"]
environment["ORCA_FIXTURE_READ_ONLY"] = "1" if connection.get("readOnly", False) else "0"

with open(xctestrun_path, "wb") as handle:
    plistlib.dump(xctestrun, handle)
PY

xcrun simctl uninstall "$simulator_udid" com.orca.mail >/dev/null 2>&1 || true
result_dir=$(mktemp -d "${TMPDIR%/}/orca-ios-tests-XXXXXX")
result_bundle="$result_dir/Orca.xcresult"
# AppleInterfaceStyle launch defaults do not reliably change simulator appearance.
trap 'xcrun simctl ui "$simulator_udid" appearance light >/dev/null 2>&1 || true' EXIT
xcrun simctl ui "$simulator_udid" appearance light

read_only=$(/usr/bin/python3 -c 'import json,sys; print("1" if json.load(open(sys.argv[1])).get("readOnly",False) else "0")' "$connection_file")
if [[ $read_only == 1 ]]; then
  light_tests=(-only-testing:OrcaTests -only-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
else
  light_tests=(-skip-testing:OrcaUITests/OrcaUITests/test02SettingsRenderInDarkMode -skip-testing:OrcaUITests/OrcaUITests/test05ReadOnlyAccountKeepsDraftEditable)
  dark_tests=(-only-testing:OrcaUITests/OrcaUITests/test02SettingsRenderInDarkMode -only-testing:OrcaUITests/OrcaUITests/test03VisualControlStates -only-testing:OrcaUITests/OrcaUITests/test04StyledHTMLUsesReadableCanvas)
fi

xcodebuild test-without-building \
  -xctestrun "$injected_xctestrun" \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -resultBundlePath "$result_bundle" \
  "${light_tests[@]}"

xcrun simctl ui "$simulator_udid" appearance dark
xcodebuild test-without-building \
  -xctestrun "$injected_xctestrun" \
  -destination "platform=iOS Simulator,id=$simulator_udid" \
  -resultBundlePath "$result_dir/OrcaDark.xcresult" \
  "${dark_tests[@]}"

print "Result bundle: $result_bundle"
