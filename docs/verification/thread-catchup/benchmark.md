# Paired 240-message interaction measurements

Baseline `9844aca646feabbc843980ecdba1bf5e5fe34b14`; final runtime `65b85b84e32eb64db9ac1de57a3c7a37177099f0`. Three sequential alternating pairs (baseline/head, head/baseline, baseline/head), fresh contexts, two warmup cycles and ten measured samples per operation/run (30 per revision/operation). Identical synthetic 240-message fully read thread, 15 paragraphs, quote and attachment metadata per message, 1440×900 light compact layout. Operations reveal history, expand/collapse the first card and alternate scroll offsets 500/900px. No builds or test suites overlapped these measurements.

Linux cloud container, four-core quota, Bun 1.3.14, Node 24.19.0, Chromium 154.0.8037.57, no CPU throttle. Elapsed time is in-page operation through two animation frames. Immediate CDP task work covers that interval; total CDP Task/Script/Layout/Style and settled geometry also include an additional 180ms quiet window on BOTH revisions. This deliberately includes the 120ms deferred anchor scan. The quiet wait is not counted as elapsed interaction latency. Geometry instrumentation wraps getBoundingClientRect/getClientRects and has overhead. P95 uses nearest rank ceil(.95*n)-1.

| Operation | Elapsed median base → head (ms) | P95 base → head | Immediate task median | Total task median | Immediate geometry median | Settled geometry median |
|---|---:|---:|---:|---:|---:|---:|
| expand | 119.40 → 124.75 | 152.40 → 133.50 | 127.94 → 130.01 | 128.16 → 144.27 | 3.00 → 9.00 | 5.00 → 22.00 |
| collapse | 113.30 → 119.50 | 139.90 → 136.30 | 114.21 → 125.33 | 114.44 → 131.97 | 3.00 → 9.00 | 5.00 → 22.00 |
| scroll | 10.55 → 10.65 | 16.00 → 24.80 | 2.09 → 4.90 | 2.29 → 5.43 | 2.00 → 4.00 | 2.00 → 9.00 |

Per-pair elapsed medians (base → head, ms):
- expand: 122.75 → 126.70, 114.40 → 121.35, 119.65 → 124.60
- collapse: 115.60 → 121.80, 109.75 → 119.05, 116.75 → 116.75
- scroll: 12.40 → 10.80, 7.15 → 10.55, 10.55 → 11.55

An additional independent reviewer repeated three alternating pairs at published head `70c31307fdae14d292bcb1b02a54e1bcf2819ede` (the same `65b85b8` product runtime). It reported scroll elapsed medians **8.65 → 12.30ms**, immediate geometry **2 → 4**, deferred-inclusive geometry **2 → 9**, and total task medians **3.094 → 7.457ms**. The reviewer retains raw evidence in task `01a13c0d-112f-741e-86d5-be874d1ce027`; these are reviewer-reported results, separate from this repository's raw author runs. This variation means the author's near-equal elapsed median is **not a stable latency result**. Both runs show additional deferred work; the optimization reduces repeated capture work but does not remove the usability/performance tradeoff.

**No production speedup claim.** There remains additional main-thread work and a denser painted layout. The optimization refreshes one retained anchor at burst start, uses scroll deltas for subsequent events, and scans after 120ms quiet. It also captures on resize/content-size changes and corrects the sticky-header edge when leaving. This reduces repeated geometry during scrolling, but does not eliminate the restoration cost. Raw samples, min/max and per-pair noise are in [the final summary](bench/burst/summary.json). Body DOM stays mounted; accessible date descriptions add 240 descendants.

The earlier published 933155e results remain unchanged in [the original report](benchmark-before-scroll-optimization.md) and [raw data](bench/summary.json): scroll median 7.80→22.25ms, geometry 2→12. These were two-frame measurements without the extended quiet window, so total-work numbers must not be compared directly across methods. An intermediate optimization at c919186 is preserved in [bench/burst-initial](bench/burst-initial/); its paired scroll medians 10.30→12.35ms, immediate geometry 2→4 and total geometry 2→9 were diagnostic. The final table above is a fresh exact-runtime run. Initial a17 date-formatting measurements remain in [bench/initial](bench/initial/); that historical summary used a lower-rank percentile estimate and is not used for final P95 claims.

Limits: warm synthetic local browser, no provider latency, cold-cache/mobile CPU/energy/capacity claim. Frame scheduling/shared-host variation affects elapsed time; it does not explain away measured extra geometry/task work. Restored sessions use exact body geometry and may cost more than deferred layout. Return correctness is tested separately; this benchmark does not measure resume latency.
