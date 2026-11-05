#!/usr/bin/env bash
# Build the clean selected commit and verify the full app against loopback-only fixture data.
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
output="${1:?A new evidence directory is required}"
if [[ -e "$output" ]]; then printf '%s\n' 'Evidence directory must not exist.' >&2; exit 1; fi
if [[ -n "$(git status --porcelain)" ]]; then printf '%s\n' 'A clean checkout is required.' >&2; exit 1; fi
tested_sha="$(git rev-parse HEAD)"
scratch="$(mktemp -d /tmp/orca-web-image-demo-XXXXXX)"
fixture_pid=""
cleanup() {
  if [[ -n "$fixture_pid" ]]; then kill -TERM "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
bun run build >"$scratch/build.log" 2>&1
node --input-type=module - "$tested_sha" >"$scratch/build-proof.json" <<'JS'
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const htmlPath='apps/web/dist/index.html';const html=readFileSync(htmlPath);
const match=html.toString('utf8').match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
if(!match)throw new Error('Built entry bundle missing');
const files={};for(const path of [htmlPath,'apps/web/dist'+match[1]])files[path]=createHash('sha256').update(readFileSync(path)).digest('hex');
console.log(JSON.stringify({commit:process.argv[2],files}));
JS
bun apps/api/scripts/compose-fixture.ts --images >"$scratch/fixture.log" 2>&1 &
fixture_pid=$!
for _ in {1..100}; do
  if [[ -s "$scratch/fixture.log" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat "$scratch/fixture.log" >&2; exit 1; fi
  sleep 0.1
done
connection="$(head -n 1 "$scratch/fixture.log")"
if [[ ! -f "$connection" ]]; then printf '%s\n' 'Synthetic fixture did not start.' >&2; exit 1; fi
ORCA_IMAGE_BUILD_PROOF="$scratch/build-proof.json" node apps/web/scripts/image-fixture-e2e.mjs "$connection" "$output" "$tested_sha"
cp "$scratch/build.log" "$output/build.log"
cp "$scratch/build-proof.json" "$output/build-proof.json"
