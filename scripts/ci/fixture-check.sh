#!/usr/bin/env bash
# Run only disposable synthetic fixtures. Never use a developer's simulator/data.
set -euo pipefail
mode=${1:?usage: fixture-check.sh browser|ios}
case "$mode" in browser|ios) ;; *) exit 64 ;; esac
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
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  # Export before stopping the fixture (which removes its connection metadata).
  python3 scripts/ci/export-evidence.py "$work" "$evidence" "$connection" "$status"
  export_status=$?
  if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null; wait "$fixture_pid" 2>/dev/null; fi
  if [[ -n "$simulator" ]]; then
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1
    xcrun simctl delete "$simulator" >/dev/null 2>&1
  fi
  rm -rf "$work"
  if [[ "$export_status" != 0 ]]; then
    # Fail closed: do not leave partially sanitized evidence to upload.
    rm -rf "$evidence"
    echo 'Evidence export failed; no artifacts will be uploaded.' >&2
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
  xcrun simctl boot "$simulator"
  xcrun simctl bootstatus "$simulator" -b
fi
TMPDIR="$work" bun --no-env-file "apps/api/scripts/$fixture" > "$work/fixture.log" 2>&1 &
fixture_pid=$!
for ((attempt=0; attempt<60; attempt++)); do
  connection=$(find "$work" -name connection.json -type f -print -quit)
  [[ -n "$connection" ]] && break
  if ! kill -0 "$fixture_pid" 2>/dev/null; then echo 'Synthetic fixture exited before readiness.' >&2; exit 1; fi
  sleep 1
done
[[ -n "$connection" ]] || { echo 'Synthetic fixture readiness timed out.' >&2; exit 1; }
# Metadata is private; never print it or include it in an artifact.
if [[ "$mode" == browser ]]; then
  node apps/web/scripts/compose-fixture-e2e.mjs "$connection" "$work/browser" > "$work/checks.log" 2>&1
  node apps/web/scripts/reader-fixture-e2e.mjs "$connection" "$work/reader" >> "$work/checks.log" 2>&1
  node apps/web/scripts/search-fixture-e2e.mjs "$connection" "$work/search" >> "$work/checks.log" 2>&1
else
  # Separate host-runtime/search failures from native typing/submission failures.
  # The ephemeral bearer stays in memory; only sanitized scalar evidence prints.
  if node --input-type=module - "$connection" > "$work/checks.log" 2>&1 <<'JS'
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const origin = new URL(fixture.apiURL);
assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.port && origin.href === `${origin.origin}/`);
const headers = { Authorization: `Bearer ${fixture.accessToken}` };
const options = () => ({ headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
const catalogResponse = await fetch(new URL('/v1/destinations', origin), options());
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
const url = new URL('/v1/inbox', origin);
url.search = new URLSearchParams({ accountId: fixture.accountId, view: 'normal', query: 'Jordan confirmed', limit: '30' });
if (catalog.legacyDestinationIds.normal) url.searchParams.set('destinationId', catalog.legacyDestinationIds.normal);
const probes = [];
for (let attempt = 1; attempt <= 3; attempt++) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, options());
    const result = await response.json();
    probes.push({ attempt, status: response.status, errorCode: result.error?.code, ids: result.messages?.map(message => message.id), serverTiming: response.headers.get('server-timing') });
  } catch (error) {
    probes.push({ attempt, status: null, errorName: error.name });
  }
  console.log(JSON.stringify({ syntheticSearchPreflight: true, ...probes.at(-1), elapsedMs: Math.round(performance.now() - startedAt) }));
}
for (const probe of probes) {
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.ids, ['ios-fixture-message-2']);
  assert.match(probe.serverTiming ?? '', /orca-search-process;dur=/);
}
JS
  then
    :
  else
    # A longer diagnostic-only budget measures failure cause; it cannot turn a
    # failed real two-second HTTP gate green or change production behavior.
    bun --no-env-file apps/api/scripts/mobile-search-diagnostic.ts "$connection" >> "$work/checks.log" 2>&1 || true
    exit 1
  fi
  ORCA_UI_TEST_SCOPE=compose ORCA_UI_RESULT_DIRECTORY="$work/results" \
    zsh apps/ios/OrcaUITests/run-fixture-tests.sh "$connection" "$simulator" "$work/DerivedData" >> "$work/checks.log" 2>&1
fi
