#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
evidence_dir="$repo_root/apps/web/public/docs/evidence"
browser_bin="/opt/homebrew/bin/agent-browser"
browser_session="$($browser_bin session id --scope worktree --prefix bre-377)"
server_log="/tmp/orca-bre-377-server.log"
vite_log="/tmp/orca-bre-377-vite.log"

mkdir -p "$evidence_dir"
"$browser_bin" skills get core --full >/dev/null

cleanup() {
  "$browser_bin" --session "$browser_session" close >/dev/null 2>&1 || true
  if [[ -n "${vite_pid:-}" ]]; then kill "$vite_pid" >/dev/null 2>&1 || true; fi
  if [[ -n "${server_pid:-}" ]]; then kill "$server_pid" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

bun "$repo_root/apps/web/scripts/bre-377-reader-refresh-server.ts" >"$server_log" 2>&1 &
server_pid=$!
(cd "$repo_root/apps/web" && bun run dev -- --host 127.0.0.1) >"$vite_log" 2>&1 &
vite_pid=$!

for _ in {1..80}; do
  if curl --fail --silent http://127.0.0.1:3000/health >/dev/null && curl --fail --silent http://127.0.0.1:5173/ >/dev/null; then break; fi
  sleep 0.1
done

reader_url="http://127.0.0.1:5173/?destination=inbox&thread=thread_local_1&accountId=acct_local_gmail"
requested_mode="${1:-all}"

verify_reader() {
  local label="$1"
  local theme="$2"
  local motion="$3"
  local screenshot="$evidence_dir/bre-377-${label}.png"
  local timing="$evidence_dir/bre-377-${label}-timing.json"
  local timing_tmp="/tmp/orca-bre-377-${label}-timing.json"

  "$browser_bin" --session "$browser_session" open http://127.0.0.1:5173/login >/dev/null
  "$browser_bin" --session "$browser_session" eval "localStorage.setItem('orca-reader-preferences', JSON.stringify({theme:'$theme',textSize:'standard',density:'calm',motion:'$motion',composeZenByDefault:false,notifyByDefault:false})); true" >/dev/null
  "$browser_bin" --session "$browser_session" network requests --clear >/dev/null
  "$browser_bin" --session "$browser_session" open "$reader_url" >/dev/null
  "$browser_bin" --session "$browser_session" wait ".reader-document:not(.reader-loading)" >/dev/null
  "$browser_bin" --session "$browser_session" eval --stdin >/dev/null <<'JAVASCRIPT'
(async () => {
  const reader = document.querySelector('.reader-document:not(.reader-loading)');
  const workspace = document.querySelector('.desktop-workspace');
  if (!reader || !workspace) throw new Error('Reader did not become ready');
  window.scrollTo(0, 0);
  workspace.scrollTop = Math.min(1100, workspace.scrollHeight - workspace.clientHeight);
  const state = {
    reader,
    scrollBefore: workspace.scrollTop,
    loadingSeen: false,
    readerRemoved: false,
    entranceAnimations: [],
    detailRequestsBefore: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/v1/threads/')).length,
    refreshGenerationBefore: null,
    refreshGenerationAfter: null,
    refreshedUnrelatedSubject: null,
    startedAt: performance.now(),
  };
  new MutationObserver((records) => {
    state.loadingSeen ||= Boolean(document.querySelector('.reader-loading'));
    state.readerRemoved ||= records.some((record) => Array.from(record.removedNodes).some((node) => node === reader || (node instanceof Element && node.contains(reader))));
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('animationstart', (event) => {
    if (event.animationName === 'reader-enter') state.entranceAnimations.push(Math.round(performance.now() - state.startedAt));
  }, true);
  window.__bre377ReaderState = state;
  const metrics = await fetch('/v1/__bre377/metrics').then((response) => response.json());
  if (!Number.isInteger(metrics.refreshGeneration)) throw new Error(`Missing refresh generation baseline: ${JSON.stringify(metrics)}`);
  state.refreshGenerationBefore = metrics.refreshGeneration;
  return { scrollBefore: state.scrollBefore, refreshGenerationBefore: state.refreshGenerationBefore };
})()
JAVASCRIPT
  "$browser_bin" --session "$browser_session" eval --stdin >/dev/null <<'JAVASCRIPT'
(async () => {
  const state = window.__bre377ReaderState;
  if (!state || !Number.isInteger(state.refreshGenerationBefore)) throw new Error('Reader observers were not armed with a refresh baseline');
  const deadline = performance.now() + 9000;
  while (performance.now() < deadline) {
    const metrics = await fetch('/v1/__bre377/metrics').then((response) => response.json());
    if (metrics.refreshGeneration > state.refreshGenerationBefore) {
      state.refreshGenerationAfter = metrics.refreshGeneration;
      const inbox = await fetch('/v1/inbox?view=all&classification=all&limit=100').then((response) => response.json());
      state.refreshedUnrelatedSubject = inbox.messages.find((message) => message.id === 'msg_bre377_unrelated')?.subject ?? null;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        refreshGenerationBefore: state.refreshGenerationBefore,
        refreshGenerationAfter: state.refreshGenerationAfter,
        refreshedUnrelatedSubject: state.refreshedUnrelatedSubject,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for provider refresh after observers armed at generation ${state.refreshGenerationBefore}`);
})()
JAVASCRIPT
  "$browser_bin" --session "$browser_session" eval --stdin --json >"$timing_tmp" <<'JAVASCRIPT'
(() => {
  const state = window.__bre377ReaderState;
  const workspace = document.querySelector('.desktop-workspace');
  const reader = document.querySelector('.reader-document:not(.reader-loading)');
  if (!state || !workspace || !reader) throw new Error('Reader verification state disappeared');
  const result = {
    elapsedMs: Math.round(performance.now() - state.startedAt),
    theme: document.documentElement.dataset.theme,
    motion: document.documentElement.dataset.motion,
    detailRequestsBefore: state.detailRequestsBefore,
    detailRequestsAfter: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/v1/threads/')).length,
    refreshGenerationBefore: state.refreshGenerationBefore,
    refreshGenerationAfter: state.refreshGenerationAfter,
    refreshedUnrelatedSubject: state.refreshedUnrelatedSubject,
    scrollBefore: state.scrollBefore,
    scrollAfter: workspace.scrollTop,
    sameReaderDocument: reader === state.reader,
    loadingSeen: state.loadingSeen,
    readerRemoved: state.readerRemoved,
    entranceAnimationStartMs: state.entranceAnimations,
    delayedEntranceAnimationCount: state.entranceAnimations.filter((milliseconds) => milliseconds >= 3500).length,
    computedAnimationName: getComputedStyle(reader).animationName,
  };
  if (result.refreshGenerationAfter <= result.refreshGenerationBefore || result.refreshedUnrelatedSubject !== 'Unrelated mailbox row — refreshed' || result.detailRequestsBefore < 1 || result.detailRequestsAfter !== result.detailRequestsBefore || result.scrollBefore < 500 || result.scrollAfter !== result.scrollBefore || !result.sameReaderDocument || result.loadingSeen || result.readerRemoved || result.delayedEntranceAnimationCount !== 0) {
    throw new Error(`BRE-377 verification failed: ${JSON.stringify(result)}`);
  }
  return result;
})()
JAVASCRIPT
  "$browser_bin" --session "$browser_session" screenshot "$screenshot" >/dev/null
  mv -f "$timing_tmp" "$timing"
  echo "verified $label: $timing"
}

if [[ "$requested_mode" == "all" || "$requested_mode" == "light" ]]; then verify_reader "light" "light" "full"; fi
if [[ "$requested_mode" == "all" || "$requested_mode" == "orca-black" ]]; then verify_reader "orca-black" "dark" "full"; fi
if [[ "$requested_mode" == "all" || "$requested_mode" == "reduced-motion" ]]; then verify_reader "reduced-motion" "dark" "reduced"; fi

echo "BRE-377 real-Chromium verification passed for $requested_mode."
