# Paired 240-message interaction measurements

Baseline `9844aca646feabbc843980ecdba1bf5e5fe34b14`; final runtime `933155e140aff258e478040e6a532f24dc6dfeba`. Three sequential pairs, orders baseline/head, head/baseline, baseline/head. Fresh browser/context per run; two warmup cycles, then ten samples per operation (30 per revision/operation). Identical 240-message fully read synthetic payload, 15 paragraphs plus trailing quote and attachment metadata per message, light theme, compact density, 1440×900. Both revisions reveal earlier history, then expand/collapse the first card and alternate scroll offsets 500/900px. No builds or test suites overlapped the timed runs.

Linux x86_64 cloud container, four-core CPU quota, Bun 1.3.14, Node 24.19.0, Chromium 154.0.8037.57. No CPU throttling. Timings start inside page evaluation, apply the same DOM click/scroll operation and await two animation frames; Playwright round trips are outside elapsed timing. CDP cumulative Task/Script/Layout/Style metrics bracket each command and include browser task overhead. Geometry counts wrap getBoundingClientRect/getClientRects, so instrumentation itself has cost. These are paired functional operations, not equal pixel layouts: compact rows put more rows in the viewport.

| Operation | Elapsed median base → head (ms) | P95 base → head | Task median base → head | Script median base → head | Geometry calls median base → head |
|---|---:|---:|---:|---:|---:|
| expand | 117.15 → 117.95 | 150.70 → 133.10 | 120.32 → 125.27 | 105.62 → 105.17 | 3.00 → 11.00 |
| collapse | 106.10 → 115.90 | 128.90 → 144.60 | 106.95 → 126.01 | 99.32 → 106.61 | 3.00 → 11.00 |
| scroll | 7.80 → 22.25 | 17.20 → 30.10 | 1.79 → 6.14 | 0.23 → 0.59 | 2.00 → 12.00 |

Per-pair elapsed medians (baseline → head, ms):
- expand: 125.40 → 123.95, 104.95 → 112.00, 113.95 → 118.60
- collapse: 121.55 → 117.40, 101.70 → 110.70, 105.50 → 119.45
- scroll: 11.55 → 22.60, 6.75 → 23.15, 7.75 → 18.05

There is **no speedup claim**. The final run retains additional geometry work for reading-position capture and a different paint workload from compact rows. Frame scheduling and shared-host noise affect elapsed values; see min/max and all samples in [summary.json](bench/summary.json) and the six paired raw files. DOM descendants are 14,042 baseline vs 14,282 head with the first card collapsed: the extra 240 nodes are accessible full-date descriptions. Body DOM remains mounted in both.

An initial measurement of runtime `a17b14b32cc8681516d6b113dabaf928990bdf69` exposed repeated full-date formatting in the new accessible descriptions. Its median expand/collapse elapsed was 137.80/133.55ms versus its paired baseline 115.75/112.45ms. The focused fix caches only those new descriptions by message payload. Original raw measurements and summary remain in [bench/initial](bench/initial/); final numbers above come from new paired runs, not a comparison across unrelated trials.

Scope limits: warm local browser, no provider/API latency in timed interaction samples, no cold cache, throttled mobile hardware, power/energy, sustained stress, or production-capacity claim. Restoration was verified separately for correctness; these timings do not measure resume latency. Exact body layout on restored sessions can add work relative to the deferred-layout path. The harness retains its synthetic assertions; it is not a microbenchmark of React alone.
