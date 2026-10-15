#!/usr/bin/env bash
# Explicit, user-owned provisioning; source the output of `env` to activate.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ -d /workspace && -w /workspace ]]; then
  DEFAULT_TOOLS=/workspace/.orca-pstack-tools
else
  DEFAULT_TOOLS=${XDG_CACHE_HOME:-${HOME}/.cache}/orca-pstack
fi
TOOLS=${ORCA_PSTACK_TOOLS:-$DEFAULT_TOOLS}
[[ "$TOOLS" = /* ]] || { echo 'ORCA_PSTACK_TOOLS must be an absolute path' >&2; exit 1; }
BUN_VERSION=1.3.14

select_bun() {
  local candidate
  for candidate in "${ORCA_PSTACK_BUN:-}" "$(command -v bun || true)" "$TOOLS/node_modules/.bin/bun" /workspace/.orca-tools/node_modules/.bin/bun; do
    if [[ -n "$candidate" && -x "$candidate" ]] && [[ "$("$candidate" --version)" = "$BUN_VERSION" ]]; then
      BUN=$candidate
      return 0
    fi
  done
  return 1
}

activate() {
  select_bun || { echo "Bun $BUN_VERSION missing; run bash scripts/pstack/cloud.sh setup" >&2; return 1; }
  export PATH="$(dirname -- "$BUN"):$PATH"
  export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$TOOLS/browsers}
}

check_host() {
  command -v git >/dev/null
  command -v python3 >/dev/null
  command -v node >/dev/null
  [[ "$(node --version)" = v24.* ]] || { echo 'Node 24 required; provision it in the saved cloud image.' >&2; return 1; }
  python3 -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12+ required"'
}

browser_doctor() {
  # A real launch detects missing OS libraries that an executable-path check misses.
  node --input-type=module <<'JS'
import { chromium } from 'playwright';
const browser = await chromium.launch({headless: true,
  executablePath: process.env.ORCA_CHROMIUM_EXECUTABLE || undefined});
try {
  const page = await browser.newPage();
  await page.setContent('<title>Orca synthetic preflight</title>');
  if (await page.title() !== 'Orca synthetic preflight') throw new Error('Browser preflight failed');
  console.log('Chromium launch and synthetic page: passed');
} finally { await browser.close(); }
JS
}

cd -- "$ROOT"
case "${1:-help}" in
  setup)
    check_host
    if ! select_bun; then
      command -v npm >/dev/null
      mkdir -p -- "$TOOLS"
      # Exact version, isolated prefix; no global install or shell profile changes.
      npm install --prefix "$TOOLS" --cache "$TOOLS/npm-cache" --no-audit --no-fund --save-exact "bun@$BUN_VERSION"
    fi
    activate
    bun install --frozen-lockfile
    if [[ -z "${ORCA_CHROMIUM_EXECUTABLE:-}" ]]; then
      node node_modules/playwright/cli.js install chromium
    fi
    python3 scripts/pstack/verify.py doctor
    browser_doctor
    echo 'Setup passed. Activate in each shell: eval "$(bash scripts/pstack/cloud.sh env)"'
    if [[ -n "${ORCA_CHROMIUM_EXECUTABLE:-}" ]]; then
      printf 'Keep the browser override in each shell: export ORCA_CHROMIUM_EXECUTABLE=%q\n' "$ORCA_CHROMIUM_EXECUTABLE"
    fi
    ;;
  env)
    activate
    printf 'export PATH=%q\nexport PLAYWRIGHT_BROWSERS_PATH=%q\n' "$PATH" "$PLAYWRIGHT_BROWSERS_PATH"
    if [[ -n "${ORCA_CHROMIUM_EXECUTABLE:-}" ]]; then
      printf 'export ORCA_CHROMIUM_EXECUTABLE=%q\n' "$ORCA_CHROMIUM_EXECUTABLE"
    fi
    ;;
  doctor)
    check_host
    activate
    python3 scripts/pstack/verify.py doctor
    browser_doctor
    ;;
  help|--help|-h)
    cat <<'HELP'
Usage: bash scripts/pstack/cloud.sh {setup|env|doctor}
  setup   Explicitly install pinned Bun if absent, frozen workspace deps and Chromium.
  env     Print shell-quoted exports for eval; no installation or profile changes.
  doctor  Check runtimes, dependencies, browser executable and actual browser launch.
Optional: ORCA_PSTACK_TOOLS (absolute user-writable cache), ORCA_PSTACK_BUN
(existing Bun 1.3.14), PLAYWRIGHT_BROWSERS_PATH, ORCA_CHROMIUM_EXECUTABLE.
OS packages are never installed. Missing OS libraries require cloud-image provisioning.
HELP
    ;;
  *) echo 'Unknown command; use --help' >&2; exit 2 ;;
esac
