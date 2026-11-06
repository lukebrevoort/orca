#!/usr/bin/env bash
# Own two synthetic fixture processes, build each clean commit, alternate browser measurements.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
baseline_root="$(realpath "${1:?A clean baseline checkout is required}")"
output="${2:?A new evidence directory is required}"
cd "$repo_root"
if [[ -e "$output" ]]; then printf '%s\n' 'Evidence directory must not exist.' >&2; exit 1; fi
for checkout in "$repo_root" "$baseline_root"; do
  [[ -f "$checkout/apps/api/scripts/compose-fixture.ts" ]] || exit 1
  if [[ -n "$(git -C "$checkout" status --porcelain)" ]]; then printf '%s\n' 'Both checkouts must be clean.' >&2; exit 1; fi
done
scratch="$(mktemp -d /tmp/orca-image-latency-XXXXXX)"
pids=()
cleanup() {
  local result=$?
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  if [[ "$result" -ne 0 ]]; then
    local failure_dir="${output}.failed-$(basename "$scratch")"
    if mkdir "$failure_dir" 2>/dev/null; then
      for phase in baseline candidate; do
        for kind in build fixture; do [[ ! -f "$scratch/$phase-$kind.log" ]] || cp "$scratch/$phase-$kind.log" "$failure_dir/$phase-$kind.log"; done
      done
      printf 'Comparison failed; synthetic logs retained at %s\n' "$failure_dir" >&2
    fi
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
build() {
  local checkout="$1" phase="$2"
  (cd "$checkout" && bun run build) >"$scratch/$phase-build.log" 2>&1
  (cd "$checkout" && node --input-type=module - "$(git -C "$checkout" rev-parse HEAD)" <<'JS'
import {readFileSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';
function walk(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error('Built output contains a symlink');const path=`${directory}/${entry.name}`;if(entry.isDirectory())return walk(path);if(entry.isFile())return [path];throw new Error('Unexpected built output');});}
const files={};for(const path of walk('apps/web/dist').sort())files[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
if(!files['apps/web/dist/index.html'])throw new Error('Built index missing');console.log(JSON.stringify({commit:process.argv[2],files}));
JS
  ) >"$scratch/$phase-proof.json"
}
build "$baseline_root" baseline
build "$repo_root" candidate
(cd "$baseline_root" && ORCA_IMAGE_WEB_PORT=48117 exec bun apps/api/scripts/compose-fixture.ts --image-latency) >"$scratch/baseline-fixture.log" 2>&1 &
pids+=("$!")
(cd "$repo_root" && ORCA_IMAGE_WEB_PORT=48118 exec bun apps/api/scripts/compose-fixture.ts --image-latency) >"$scratch/candidate-fixture.log" 2>&1 &
pids+=("$!")
for phase in baseline candidate; do
  for _ in {1..100}; do
    [[ ! -s "$scratch/$phase-fixture.log" ]] || break
    sleep 0.1
  done
  connection="$(head -n 1 "$scratch/$phase-fixture.log")"
  if [[ ! -f "$connection" ]]; then printf '%s\n' 'Synthetic fixture did not start.' >&2; exit 1; fi
  printf '%s' "$connection" >"$scratch/$phase-connection-path"
done
ORCA_IMAGE_BUILD_PROOF="$scratch/candidate-proof.json" ORCA_IMAGE_BASELINE_PROOF="$scratch/baseline-proof.json" ORCA_IMAGE_BASELINE_ROOT="$baseline_root" node apps/web/scripts/image-latency-e2e.mjs "$(cat "$scratch/candidate-connection-path")" "$output" "$(git rev-parse HEAD)" "$(cat "$scratch/baseline-connection-path")"
for phase in baseline candidate; do cp "$scratch/$phase-proof.json" "$output/$phase-proof.json"; cp "$scratch/$phase-build.log" "$output/$phase-build.log"; done
