# Fixed local controls and baseline admission guard

The retained 10k failure (common p95 210.896 → 370.967ms, 1.759×) remains a failure. Four predeclared local children, 20 samples each, completed in 306.67 seconds with 90-second child / 420-second diagnostic ceilings. No Railway compute or application changes were involved. These are preparatory Linux controls, not representative Railway validation.

## What the controls establish

1. Candidate then main: every shared legacy and persistence relative gate passed. Common p95 was 212.907ms main versus 219.802ms candidate (1.032×). Reversing order did not reproduce the retained regression.
2. Candidate versus the identical candidate, both in baseline mode: exact source, fixture, settings, signatures and disk measurements matched, but several p95 values differed substantially. This reproduces non-code measurement instability.

| Identical-source workload | First p95 ms | Second p95 ms | Symmetric spread |
| --- | ---: | ---: | ---: |
| Common | 219.699 | 222.358 | 1.012× |
| Selective | 188.062 | 80.892 | 2.325× |
| Absent | 139.498 | 24.256 | 5.751× |
| Body only | 41.061 | 24.262 | 1.692× |
| Account A | 66.625 | 51.761 | 1.287× |
| Focus | 164.175 | 128.835 | 1.274× |
| Persist 25 new | 16.266 | 18.396 | 1.131× |

The separate EXPLAIN-only controls produced equal workloads, query plans, IDs and counts: eight common account-page plans, four default Inbox and four Focus plans per revision. The earlier failed comparison also had matching logical work. Parent-cgroup `nr_throttled` did not increase during the four controls; this excludes newly recorded throttling at that observed level only. Timing tails occur within SQL count/page work. These observations do not identify GC, scheduling, storage, or another specific root cause, and do not prove a code regression impossible.

## Narrow harness correction

Protocol `railway-replacement-v2-self-comparison` adds exactly one baseline repeat before the first 10k candidate. All shared legacy and persistence workloads must have symmetric p95 spread <=1.25 and identical source/settings/signatures/storage. An unstable pair stops before that candidate with `failureKind: unstable_baseline`. The original baseline remains the comparator. There is no selection of favorable results, averaging, retry, threshold change, or durability change.

The extra child raises the maximum to 11 × 90 seconds = 990 seconds within the unchanged 20-minute runtime and 45-minute externally enforced lifecycle envelope. Passing this check screens one interval, not all later measurements. Quick smoke runs skip this 10k guard.

`test-controls.py` uses the retained real A/A evidence to verify rejection in both directions and that the candidate callback never starts. Tests also cover the exact 1.25 boundary, values beyond it, mismatched identity/settings/storage, missing workloads, strict candidate gates, and surviving process-group termination. These checks pass. No speculative application performance fix is supported.

## Recommendation and remaining decision

Use the revised immutable harness for one bounded target attempt only after the parent confirms this protocol and service-preserving operator cancellation, including queued state. Keep the already approved $1 additional usage / 45-minute lifecycle / 20-minute runtime limits; no renewal is implied here. Abort on instability or any failed gate; no retry until pass. Combined network-fetching Docker build, representative Railway latency/storage/mixed-load results, and queued cancellation remain unverified. Retain service and volume. Storage continues accruing cost while retained.

Raw JSON is losslessly retained as deterministic gzip files. `run_controls.py` defines the fixed sequence; `plans.ts` defines EXPLAIN-only fixture controls. `controls.json.gz` records limits and observed cgroup counters; the four run reports preserve all samples, settings and signatures. `independent-v3-localization.json.gz` preserves independent SQL timing localization of the original failed run. The separate MCP fixture diagnosis is in the parent directory and does not alter this performance conclusion.
