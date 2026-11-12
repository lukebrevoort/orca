#!/usr/bin/env bash
# Run only disposable synthetic fixtures. Never use a developer's simulator/data.
set -euo pipefail
mode=${1:?usage: fixture-check.sh browser|ios}
case "$mode" in browser|ios) ;; *) exit 64 ;; esac
# Validate before any Xcode command, owned fixture or evidence directory starts.
case ${ORCA_CI_UI_TEST_APPEARANCE-both} in
  light|dark|both) ;;
  *) echo 'Invalid native UI appearance; expected light, dark or both.' >&2; exit 64 ;;
esac
if [[ ${ORCA_CI_UI_TEST_APPEARANCE-both} != both && ( "$mode" != ios || ${ORCA_CI_UI_TEST_SCOPE:-compose} != mailbox ) ]]; then
  echo 'A single native UI appearance is supported only for iOS mailbox scope.' >&2
  exit 64
fi
cd "$(dirname "$0")/../.."
# Do not allow Bun to discover a developer's credentials in this checkout.
if find . -name node_modules -prune -o -name '.env*' ! -name '.env.example' -type f -print | grep -q .; then
  echo 'Use a clean checkout without local .env files.' >&2
  exit 1
fi
umask 077
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/orca-${mode}-ci.XXXXXX")
evidence=${ORCA_CI_EVIDENCE_DIR:-${RUNNER_TEMP:-/tmp}/orca-ci-evidence}
# Refuse to mix this run's artifacts with any existing data.
mkdir "$evidence"
fixture_pid= connection= simulator=
# Fixed stage names only: command output and fixture credentials stay in the
# private logs until the existing sanitizer exports them. These markers survive
# an outer runner timeout that kills the shell before its EXIT trap can export.
progress() { printf '[fixture stage] phase=%s\n' "$1"; }
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  progress evidence_export_started
  # Export before stopping the fixture (which removes its connection metadata).
  python3 scripts/ci/export-evidence.py "$work" "$evidence" "$connection" "$status" "$simulator"
  export_status=$?
  progress evidence_export_finished
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null; wait "$fixture_pid" 2>/dev/null; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1
    xcrun simctl delete "$simulator" >/dev/null 2>&1
  fi
  rm -rf "$work"
  if [[ "$export_status" != 0 ]]; then
    # The exporter stages and scans privately. Earlier validated checkpoints
    # survive a corrupt/incomplete later bundle; no final pass marker is written.
    echo 'Final evidence export failed; only validated partial evidence may remain.' >&2
    exit 1
  fi
  if [[ "$status" != 0 ]]; then tail -n 80 "$evidence/checks.log" 2>/dev/null; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
{
  echo "mode=$mode"
  if [[ "$mode" == ios ]]; then echo "ui_test_appearance=${ORCA_CI_UI_TEST_APPEARANCE-both}"; fi
  echo "tested_sha=$(git rev-parse HEAD)"
  echo "event_sha=${GITHUB_SHA:-local}"
  echo "head_sha=${ORCA_CI_HEAD_SHA:-not-provided}"
  echo "runner_os=${RUNNER_OS:-$(uname -s)} runner_arch=${RUNNER_ARCH:-$(uname -m)}"
  echo "image=${ImageOS:-local} image_version=${ImageVersion:-local}"
  echo "bun=$(bun --version)"
  echo "node=$(node --version)"
} > "$work/identity.log"

if [[ "$mode" == browser ]]; then
  fixture=compose-fixture.ts
else
  fixture=mobile-fixture.ts
  xcodebuild -version >> "$work/identity.log"
  progress xcode_preflight_started
  python3 scripts/ci/test-ios-readiness.py >> "$work/checks.log" 2>&1
  python3 scripts/ci/ios-readiness.py --first-launch >> "$work/checks.log" 2>&1
  progress xcode_preflight_finished
  # Discover a compatible available iPhone/runtime, then create our own device.
  xcrun simctl list --json > "$work/simulators.json"
  python3 - "$work/simulators.json" "$work/destination.json" <<'PY'
import json, sys
inventory = json.load(open(sys.argv[1]))
runtimes = {r['identifier']: r for r in inventory['runtimes']
            if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-26-4')}
for runtime in sorted(runtimes, reverse=True):
    phones = [d for d in inventory['devices'].get(runtime, [])
              if d.get('isAvailable') and d['name'].startswith('iPhone') and d.get('deviceTypeIdentifier')]
    if phones:
        phone = sorted(phones, key=lambda d: d['name'])[0]
        json.dump({'runtime': runtime, 'deviceType': phone['deviceTypeIdentifier'],
                   'name': phone['name']}, open(sys.argv[2], 'w'))
        break
else:
    raise SystemExit('No available iPhone on the pinned iOS 26.4 runtime; inspect runner inventory.')
PY
  runtime=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime"])' "$work/destination.json")
  device_type=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["deviceType"])' "$work/destination.json")
  simulator=$(xcrun simctl create "Orca CI ${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}" "$device_type" "$runtime")
  cat "$work/destination.json" >> "$work/identity.log"
  echo >> "$work/identity.log"
  echo "simulator=$simulator" >> "$work/identity.log"
  progress simulator_boot_started
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
  progress simulator_boot_finished
fi
progress fixture_starting
TMPDIR="$work" bun --no-env-file "apps/api/scripts/$fixture" > "$work/fixture.log" 2>&1 &
fixture_pid=$!
for ((attempt=0; attempt<60; attempt++)); do
  connection=$(find "$work" -name connection.json -type f -print -quit)
  [[ -n "$connection" ]] && break
  if ! kill -0 "$fixture_pid" 2>/dev/null; then echo 'Synthetic fixture exited before readiness.' >&2; exit 1; fi
  sleep 1
done
[[ -n "$connection" ]] || { echo 'Synthetic fixture readiness timed out.' >&2; exit 1; }
progress fixture_ready
# Metadata is private; never print it or include it in an artifact.
if [[ "$mode" == browser ]]; then
  node apps/web/scripts/compose-fixture-e2e.mjs "$connection" "$work/browser" > "$work/checks.log" 2>&1
  node apps/web/scripts/reader-fixture-e2e.mjs "$connection" "$work/reader" >> "$work/checks.log" 2>&1
  node apps/web/scripts/catchup-fixture-e2e.mjs "$connection" "$work/reader" head >> "$work/checks.log" 2>&1
else
  # Exercise the production Swift client against this same isolated API before UI tests.
  progress swift_contract_started
  bash apps/ios/Tools/check-api.sh "$connection" >> "$work/checks.log" 2>&1
  progress swift_contract_finished
  progress ios_suite_started
  ORCA_CI_PROGRESS=1 ORCA_CI_CHECKPOINT_WORK="$work" ORCA_CI_CHECKPOINT_EVIDENCE="$evidence" \
    ORCA_UI_TEST_SCOPE=${ORCA_CI_UI_TEST_SCOPE:-compose} ORCA_UI_TEST_APPEARANCE=${ORCA_CI_UI_TEST_APPEARANCE-both} ORCA_UI_RESULT_DIRECTORY="$work/results" \
    zsh apps/ios/OrcaUITests/run-fixture-tests.sh "$connection" "$simulator" "$work/DerivedData" 3>&1 >> "$work/checks.log" 2>&1
  progress ios_suite_finished
fi

