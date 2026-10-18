# October 17 performance coverage and cache finding

Main refreshed to 5baf7f3ea9e208001c607a7bc0f5c418fb056d58. Open PRs at the sweep's start:235,252,253,254. Their files/branches were not changed. The functional lane subsequently reserved thread-loader generation/cache lifecycle for this performance lane.

| Area | Evidence assessed | Coverage limit |
| --- | --- | --- |
| Web memory/cache lifecycle | New isolated synthetic paired control/stale workload:10,000 distinct refs,20,000 loads,30 retained payloads. Original stale path retains10,000 generation entries; control retains0. | Exact logical state counts, not browser heap/OOM/latency severity. Bun heap readings are inconsistent; UTF-8 encoded key bytes are not physical heap bytes. |
| Web rendering / long threads | Current reader CSS retains body DOM for find/selection/accessibility and skips offscreen layout with content-visibility where supported. Existing240-message browser measurements include immediate and deferred geometry/task work. | Historical measurements are pinned to their recorded runtime and show added scroll/restoration work, not a speedup. No new cold/mobile/browser interaction benchmark in this lane. |
| Startup / navigation | Current source prefetches up to30 recent threads after100ms, concurrency3; cache shares pending loads. Current foreground and silent reader continuations are the two generation-token consumers. | No measured cold-start/navigation timing or provider latency. Payload count is not a byte budget. PR252 owns prefetch fixture isolation and unresolved mobile return-anchor evidence. |
| API / database / large inboxes | Reused PR235's synthetic1k/5k/10k work-count evidence and October16 current-integration80-test pass. Exact counts remain size-dependent; page projections are bounded. WAL/FULL retained. | October16 timing comparison overlapped a regression container and cannot establish a PR-caused regression. Earlier Railway performance acceptance remains failed/unresolved. No repeated search diagnostic. |
| Native paths | Reviewed open PR253/254 recorded hosted native coverage, including scoped reading/images/compose results on their pinned heads. | Those are functional CI records, not native cold-start/energy/memory profiles. No Mac/simulator/native performance execution from this Linux task; original native failure/root cause limitations remain. |

## New reproduced resource issue
ThreadDetailCache generations retains one account/thread key per distinct superseded reference throughout the cache lifetime, even after payload eviction and request completion. This is not growth for every mailbox message or every navigation: it occurs on invalidation/stale refresh or pending-version supersession. Both stale-mode runs retained100/1,000/5,000/10,000 entries; both controls retained0. All four retained30 payloads,0 pending requests and made20,000 loader calls.

A negative control demonstrates that simply deleting generation tombstones permits an old generation-zero response to be cached and accepted again. Independent review confirmed this correctness constraint. Correction uses explicit consumer leases and never-reused IDs; source ownership is limited to cache, cache tests and the two App consumers.

No durability/security setting, credential, infrastructure or real mailbox changed. No paid staging, deployment or cleanup operation. Existing Railway charges were not inspected, and no cost assumption is made.

