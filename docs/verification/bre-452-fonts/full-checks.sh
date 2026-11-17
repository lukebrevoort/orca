#!/bin/bash
set -u
export PATH=/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin
out="$1"
if [ -e "$out" ]; then
  echo "Refusing to mix check runs in $out" >&2
  exit 2
fi
mkdir -p "$out"
git rev-parse HEAD > "$out/revision.txt"
node --version > "$out/node-version.txt"
bun --version > "$out/bun-version.txt"
status=0
for check in lint typecheck test build; do
  bun run "$check" > "$out/$check.log" 2>&1
  code=$?
  printf '%s exit=%s\n' "$check" "$code" | tee -a "$out/checks.txt"
  if [ "$code" -ne 0 ]; then status=1; fi
done
exit "$status"
