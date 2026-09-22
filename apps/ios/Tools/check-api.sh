#!/bin/bash
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo 'Usage: bash apps/ios/Tools/check-api.sh /path/to/fixture/connection.json' >&2
  exit 2
fi
orca_ios_root="$(cd "$(dirname "$0")/.." && pwd)"
orca_wire_temp="$(mktemp -d "${TMPDIR:-/tmp}/orca-wire.XXXXXX")"
trap 'rm -rf "$orca_wire_temp"' EXIT
xcrun swiftc -swift-version 5 \
  "$orca_ios_root/Orca/Core/Models.swift" \
  "$orca_ios_root/Orca/Core/APIClient.swift" \
  "$orca_ios_root/Tools/APIContractSmoke.swift" \
  -o "$orca_wire_temp/check"
"$orca_wire_temp/check" "$1"
