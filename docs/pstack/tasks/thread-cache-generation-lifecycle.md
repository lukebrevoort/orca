# Bound reader generation bookkeeping

- Intent / playbook: perf-issue with bug-fix regression; preserve reader stale-response fencing while retiring metadata for evicted historical threads.
- Acceptance: generation state is retained only for cached details, current pending loads and live consumer leases; late responses cannot become current after pruning/reload; current success/error survives payload eviction until consumer release; account IDs remain part of identity.
- Owner: /root performance lane. Independent reviewer: /root/independent_review (separate agent; model diversity not claimed).
- Status: **running**. Updated: 2026-10-17 UTC.
- Base: 5baf7f3ea9e208001c607a7bc0f5c418fb056d58. Branch: fix/thread-cache-generation-lifecycle. Worktree: /workspace/orca-cache-lifecycle.
- Owned application files: apps/web/src/thread-detail-cache.ts, thread-detail-cache.test.ts, App.tsx (two generation consumers only). Functional owner explicitly excludes cache lifecycle. PR235/252/253/254 unchanged; reader fixture tests owned by252 are not edited.
- Reproduction: four sequential 2CPU/512MiB network-disabled synthetic cache processes, control/stale/stale/control; each20,000 loader calls over10,000 distinct threads. Controls retain0 generations; stale paths retain10,000, while all retain30 payloads and0 pending requests. Raw evidence initially /workspace/perf-20261017. No browser heap, latency or OOM severity claim.
- Design: never-reused generation IDs, explicit consumer leases, pruning on eviction/invalidation/settlement/release. Leases are acquired synchronously after load and released on completion/cancellation. Missing generation never matches an old request. No timers or arbitrary tombstone LRU.
- Privacy: synthetic IDs/payloads only, account-scoped keys preserved. No provider network or real mail.
- Verification/review/hosted checks: pending final immutable revision. No visual rendering/style change; existing reader interaction coverage required, screenshots are not a visual-change acceptance gate.
- Limits:30 is a payload count, not byte limit; actual concurrent requests/live consumers retain their needed identity. Historical browser/API/native performance evidence remains pinned, not a current no-regression claim. PR235 Railway acceptance remains unresolved. No paid infrastructure or production actions authorized.
