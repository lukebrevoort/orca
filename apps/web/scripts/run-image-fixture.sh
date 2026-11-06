#!/usr/bin/env bash
# Build the clean selected commit and verify the full app against loopback-only fixture data.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
output="${1:?A new evidence directory is required}"
mode="${2:-flow}"
if [[ "$mode" != flow && "$mode" != latency ]]; then printf '%s\n' 'Unknown image fixture mode.' >&2; exit 1; fi
if [[ -e "$output" ]]; then printf '%s\n' 'Evidence directory must not exist.' >&2; exit 1; fi
if [[ -n "$(git status --porcelain)" ]]; then printf '%s\n' 'A clean checkout is required.' >&2; exit 1; fi
tested_sha="$(git rev-parse HEAD)"
scratch="$(mktemp -d /tmp/orca-web-image-demo-XXXXXX)"
fixture_pid=""
cleanup() {
  local result=$?
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  if [[ "$result" -ne 0 ]]; then
    local failure_dir="${output}.failed-$(basename "$scratch")"
    if mkdir "$failure_dir" 2>/dev/null; then
      [[ ! -f "$scratch/build.log" ]] || cp "$scratch/build.log" "$failure_dir/build.log"
      [[ ! -f "$scratch/fixture.log" ]] || cp "$scratch/fixture.log" "$failure_dir/fixture.log"
      printf 'Synthetic fixture failed; logs retained at %s\n' "$failure_dir" >&2
    fi
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
bun run build >"$scratch/build.log" 2>&1
node --input-type=module - "$tested_sha" >"$scratch/build-proof.json" <<'JS'
import {readFileSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';
function walk(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error('Built output contains a symlink');const path=`${directory}/${entry.name}`;if(entry.isDirectory())return walk(path);if(entry.isFile())return [path];throw new Error('Unexpected built output');});}
const files={};for(const path of walk('apps/web/dist').sort())files[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
if(!files['apps/web/dist/index.html'])throw new Error('Built index missing');
console.log(JSON.stringify({commit:process.argv[2],files}));
JS
fixture_flag="--images"
[[ "$mode" != latency ]] || fixture_flag="--image-latency"
bun apps/api/scripts/compose-fixture.ts "$fixture_flag" >"$scratch/fixture.log" 2>&1 &
fixture_pid=$!
for _ in {1..100}; do
  if [[ -s "$scratch/fixture.log" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$scratch/fixture.log" >&2; exit 1; fi
  sleep 0.1
done
connection="$(head -n 1 "$scratch/fixture.log")"
if [[ ! -f "$connection" ]]; then printf '%s\n' 'Synthetic fixture did not start.' >&2; exit 1; fi
browser_script="apps/web/scripts/image-fixture-e2e.mjs"
[[ "$mode" != latency ]] || browser_script="apps/web/scripts/image-latency-e2e.mjs"
ORCA_IMAGE_BUILD_PROOF="$scratch/build-proof.json" node "$browser_script" "$connection" "$output" "$tested_sha"
cp "$scratch/build.log" "$output/build.log"
cp "$scratch/build-proof.json" "$output/build-proof.json"
