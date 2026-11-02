#!/usr/bin/env bash
# Build the web bundle first. Own only this fixture process and its scratch log.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
output=${1:?Pass a new evidence directory}
fixture_log=$(mktemp "${TMPDIR:-/tmp}/orca-feedback-launch.XXXXXX")
fixture_pid=
cleanup() {
  if [[ -n "$fixture_pid" ]]; then
    kill -TERM "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  rm -f "$fixture_log"
}
trap cleanup EXIT
bun apps/api/scripts/feedback-queue-fixture.ts > "$fixture_log" 2>&1 &
fixture_pid=$!
connection=
for _ in $(seq 1 120); do
  connection=$(sed -n '/^\/.*\/connection.json$/p' "$fixture_log" | tail -1)
  if [[ -n "$connection" && -f "$connection" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$fixture_log"; exit 1; fi
  sleep 0.5
done
if [[ -z "$connection" || ! -f "$connection" ]]; then cat "$fixture_log"; echo 'Feedback fixture did not start' >&2; exit 1; fi
node apps/web/scripts/feedback-queue-e2e.mjs "$connection" "$output"
