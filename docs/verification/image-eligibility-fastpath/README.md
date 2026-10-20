# Image eligibility negative fast path

The thread-detail API computed image availability by sanitizing provider HTML and building a DOM for every returned message, including HTML with no image tag. This change first tests for the case-insensitive `<im` prefix shared by `img` and legacy `image`. Only definite absence returns false early; all possible matches retain the existing sanitizer, DOM selection, dimensions and URL checks. The inbound renderer and explicit image-load path are unchanged. No cache, persisted eligibility, network request or consent change is introduced.

## Immutable revisions and dependencies

Baseline: e9f928258479aa7b46f7489c6e3e100c254a064f.
Product/test implementation: a909fa009bf10dac2dbe6e528b7bd0768b87404c.
Measured executable: a2c7940b987df63d944d2218d5fcb7333b9dadac (benchmark-only follow-ups add a type annotation and deterministic synthetic fallback IDs).

Remote main was rechecked and remained the baseline. PR235 search/Railway, PR252/253 and merge-owner final-main CI/integration fixes remain separate. No merge, deployment, infrastructure operation or manual CI run is part of this work.

Bun 1.3.14; Linux x86_64 cloud, AMD EPYC 7763, five exposed logical CPUs. Fresh frozen-lockfile installation reused the saved cache; no package/lockfile change. Both the helper and sanitizer resolve htmlparser2 12.0.0; every benchmark process asserts those versions, clean tracked/index state and expected commit, and records lock/harness hashes. Both worktrees use identical installed dependency content with their own workspace links. Existing baseline main browser/API and native compose success was reused from run [39159075394](https://github.com/lukebrevoort/orca/actions/runs/39159075394); the merge owner also reported all 1,534 baseline unit tests/typechecks green. No integration fix or baseline refresh was needed.

The earlier 84-sample exploratory review used saved dependencies whose helper resolved htmlparser2 10.1.0 while sanitize-html used 12.0.0. Those preliminary timings are not used as the baseline for any improvement claim here. Workload construction is retained, but both revisions were freshly measured under the corrected same locked layout.

## Correctness and independent review

An early `<img`-only proposal failed for legacy `<image>`, caught by independent review and retained in the failed-test log. The corrected broader prefix includes that alias. A match never grants eligibility and never bypasses sanitizer/URL checks. Current htmlparser2 takes contiguous raw tag names (not entity-decoded); provider policy transforms only links, so it does not synthesize image tags from unrelated markup. Future tag-producing transforms/parser changes must re-evaluate this assumption.

Four new tests have 1,436 assertions: explicit positive/negative cases (including aliases, entities, URL schemes and declared tracker dimensions), 952 malformed/context combinations plus additional deep/long cases against the frozen old algorithm, actual avoided-sanitizer work, and a 50-message API fixture with populated foreign-account/thread controls, repeated reads, inert body HTML and zero image downloads. The same new tests on baseline pass all behavior checks and fail only the work-count expectation (four sanitizer calls versus zero).

Independent reviewer /root/measurement_review approved the corrected implementation and type-only follow-up. Its independent actual-helper comparison covered 5,280 cases, including 142 eligible cases, with zero differences from the old algorithm. The corpus and reviewer record are retained. This is finite equivalence evidence, not an exhaustive proof; same-model independent agent, no model diversity claim.

Focused final behavior: 25 tests passed, zero failed, 1,558 assertions. All workspace typechecks and standalone benchmark typecheck passed. Full local suite: 1,537 passed and one MCP cost-budget test failed (500 instead of 429 at mcp-cost-budgets.test.ts:182); identical targeted file passed 9/9 on both baseline and candidate. This does not establish a full local-suite pass or prove the failed suite scenario is fixed/pre-existing. No MCP/integration code was changed. Existing automatic hosted checks remain authoritative for their own tested revision.

## Measurement

Four sequential fresh processes in baseline/candidate/candidate/baseline order; two pairs with reversed revision order. Each process uses the original seven deterministic synthetic workloads, one discarded warm-up pair and six recorded two-request pairs per workload: 84 recorded requests/process, 336 overall, 24 observations per revision/workload. A/B labels inside raw files are same-code repeats, not revision identities. The two paired process comparisons match workload, repeat and A/B slot. These are bookkeeping matches across separate processes, not simultaneous environmental pairs. Random default-destination IDs initially broke cross-process response equality; that first four-process set at f5569ab is retained under rejected-random-destinations and excluded from improvement claims. The accepted harness seeds a deterministic fixture-inbox lane before inserting threads, without normalizing the API response.

Real createApp, session middleware and disposable migrated SQLite are exercised in-process, without HTTP sockets or live mail. All messages and sessions are synthetic. Request timing spans dispatch through response.text(); fixture seeding and assertions are outside. Wrapped real helper and provider sanitizer expose calls, input byte lengths and helper wall time. Timing includes instrumentation, including provider byte counting only when the provider sanitizer actually runs; this is an instrumented comparison, not a production endpoint benchmark. The observed reduction combines sanitizer/DOM removal and the small removed instrumentation cost.

Every request verifies response status, message/account counts, availability flags and inert HTML. Per-workload serialized response hashes are identical across all four processes. Populated foreign-account/thread, unauthenticated and absent-thread controls invoke zero helper/sanitizer calls. The image-download hook remains at zero. DB page counts are unchanged (not proof of zero writes). Each successful process closes/removes its owned fixture.

Median/range wall time, process CPU, helper time, actual provider calls, provider input bytes and RSS endpoints are in summary.json; every sample is retained in the four raw JSON files. Input bytes are not parser traversal counts. RSS endpoints are not peak memory, per-request allocation or a leak metric. Fixed workload order, process-wide GC/allocator carryover, two process pairs and a shared host limit statistical inference. No concurrency, cold-cache, socket latency, native rendering, representative Railway or production-capacity claim.

The change targets image-free HTML. Potential-tag inputs continue full work and incur a prefix scan; even `<impossible>` conservatively takes the old path. The image-bearing workloads measured slower in both process orders; these are observed regressions and are not dismissed as host noise. No scanning/size budget or universal parser speedup is introduced.


## Accepted results and tradeoffs

| Workload | Median API ms base → candidate | Change | Provider calls | Median CPU ms base → candidate |
|---|---:|---:|---:|---:|
| null-250 | 18.95 → 16.44 | -13.22% | 250 → 0 | 28.29 → 29.18 |
| 4KiB-250-noimg | 178.16 → 90.38 | -49.27% | 250 → 0 | 197.37 → 97.51 |
| 100KiB-1-noimg | 26.08 → 18.67 | -28.39% | 1 → 0 | 27.08 → 20.09 |
| 100KiB-50-noimg | 713.01 → 379.34 | -46.80% | 50 → 0 | 775.47 → 422.16 |
| 100KiB-50-tailimg | 692.66 → 728.14 | +5.12% | 50 → 50 | 736.49 → 803.60 |
| 1MiB-1-noimg | 152.67 → 84.14 | -44.88% | 1 → 0 | 155.06 → 86.23 |
| 1MiB-10-tailimg | 1386.85 → 1518.85 | +9.52% | 10 → 10 | 1447.78 → 1719.46 |

The supported win is large image-free HTML: 50 × 100 KiB improves 46.80% in pooled median request time, while actual eligibility-provider sanitizer calls fall 50→0 and sanitizer input bytes fall 5,120,000→0. Helper invocations remain 50, and inbound body sanitization remains unchanged. The two process-order median candidate/base ratios for this workload are 0.537 and 0.547, supporting the result beyond minor same-code timing variation. The null-body process-order ratios disagree (1.111 and 0.824), so no dependable null-body latency improvement is claimed.

**Known tradeoff:** 50 × 100 KiB with a trailing image regresses 5.12%, and 10 × 1 MiB with a trailing image regresses 9.52% in pooled median API time. Their sanitizer calls/input bytes are unchanged, but both process-order ratios exceed 1. These observations are part of the result, not discarded outliers. The draft exposes this tradeoff for review; it does not establish a universal win or production rollout readiness.

A bounded follow-up diagnostic alternates the real baseline/candidate helpers in one process on the positive-tail fixtures (8 recorded pairs × 5 calls after one warm-up pair), then separately times 200 prefix checks. Prefix-only means were 0.0276 ms/100 KiB and 0.2806 ms/1 MiB; helper medians were 6.82→7.09 ms and 68.60→76.12 ms. Thus standalone prefix cost does not explain the entire observed positive-input difference. The cause beyond the extra scan remains unresolved; runtime/allocator/JIT effects are hypotheses, not established explanations. That diagnostic does not invalidate the end-to-end regressions.

RSS endpoints ranged 207–1,809 MiB on baseline and 215–1,551 MiB on candidate across the fixed workload sequence. These are process endpoints, not peaks or guaranteed memory savings. Raw process CPU, helper time, ranges and ratios are in accepted/summary.json; independent review recomputed all 336 observations and seven response identities.

## Draft and hosted verification

Product/equivalence/evidence review is complete. Existing automatic PR unit/typecheck, browser/API, native reader/images and unsigned compose checks are pending publication; no manual dispatch or rerun. The final PR description will record exact published/merge SHAs and terminal outcomes without a documentation-only CI push. A completed hosted run does not erase the retained local MCP suite failure or the positive-input performance tradeoff.

## Reproduction

Prepare clean baseline and candidate worktrees at the recorded SHAs with Bun 1.3.14 and frozen-lockfile dependencies; do not copy .env, mail or browser state. Copy the candidate's `apps/api/benchmarks/image-eligibility.ts` into the same path in the baseline (untracked file). Set IMAGE_BENCH_SHA to the worktree's full SHA and IMAGE_BENCH_ROLE to baseline/candidate; run from the worktree root:

`bun apps/api/benchmarks/image-eligibility.ts /new/output/raw.json`

The retained accepted/run.py shows the exact four-process invocation/order, paths and 180-second per-process timeout used here. Use fresh output directories; raw output uses exclusive creation. The harness covers DB setup/execution cleanup, but an exception in createApp construction before the try block could leave the newly created empty fixture directory. Existing successful run cleanup was verified.

Run `python3 accepted/summarize.py` from this evidence directory to verify signatures/version/workload equality and recompute summary.json. Re-run the independent corpus with `bun independent-equivalence.ts /absolute/candidate/root` from this evidence directory. The supplemental prefix-diagnostic.ts hardcodes its original checkout/output paths and recorded SHA labels; adjust those paths and independently verify checkout commits before reproducing it. Unlike the main harness, the diagnostic does not assert its SHA labels at runtime. Existing image POST/sanitizer tests cover explicit-load policy; no UI layout changed. Hosted reader/images/compose checks run only through existing automatic PR workflows, without dispatch/retry.
