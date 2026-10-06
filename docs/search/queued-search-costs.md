# Queued search: incremental Railway costs

Updated 5 October 2026. This estimates the queued replacement architecture, not the abandoned PR 224 implementation.

**No extra always-on service is required by this architecture.** This public model uses synthetic local benchmarks and explicitly hypothetical volumes. It contains no production service identifiers, account/billing details, real request counts or observed deployment capacity. The separate private cost analysis retains those operational observations.

An ordinary read child models approximately **$1.512 per million pages** under the measured tiny-fixture assumptions. Added storage, exact counts, permanent API memory and scheduler overhead must be accounted for separately; this is not a total-cost bound, invoice forecast or production capacity approval. The scenario table below makes request and update volumes explicit rather than implying observed usage.

## What runs and what was measured

The [scheduler](../../apps/api/src/search/runtime.ts) lives inside the existing API process, checks persisted activation, and waits **5 seconds after each completed run**. Index work stays disabled until explicitly enabled. The [supervisor](../../apps/api/src/search/indexing/supervisor.ts) starts one short-lived child per attempted job, handles at most 16 jobs per drain, and uses additional children to seal completed account/mode revisions. The derived index is a separate SQLite file on the existing volume. The [read executor](../../apps/api/src/search/executor.ts) starts one child per query and admits at most one active reader per API process, shared by HTTP/MCP.

| Existing local evidence | Observation | Cost implication |
| --- | --- | --- |
| Ordinary pages, 25 raw children and 25 executor calls | Case means 118–121 ms end-to-end; 10–14 ms reader core; mean 0.19268 CPU-seconds and 6.19 MiB-seconds RAM-time per raw child | Use the whole-child CPU/RAM coefficients; core time alone misses startup/import/protocol cost |
| Ordinary child memory | Self-reported high-water RSS 82.25 MiB; external sampler maximum 83.48 MiB | Transient memory, not a monthly resident allocation |
| One broad metadata exact-count query | 19,499 matches, 25 returned; 1,039 ms end-to-end, 927 ms core, 103.2 MiB reported peak; succeeded within unchanged 2-second execution deadline | CPU and RAM-time were **not measured**; do not reuse ordinary-page coefficients |
| Actual supervised write work | 32 obligations for 16 messages plus 2 seal children, 948.9 ms; all acknowledged, none blocked | Confirms process-per-job work; does not measure a full backfill |
| Apply children | Metadata 0.03198 CPU-seconds/27.75 ms; full 0.03118 CPU-seconds/27.44 ms; mean 0.790 MiB-seconds RAM-time; peak 42.74 MiB | Roughly 0.032 CPU-seconds per job for this tiny text |
| Capture triggers, WAL/FULL, no active worker | Added mean wall time: insert 26.4 µs; metadata update 20.1 µs; body update 10.0 µs; read-flag change indistinguishable from noise | Capture remains on the canonical write path, including while workers are paused |

This is warm-cache Linux/Bun 1.3.14 **workspace overlayfs** evidence: one account, 20,000 synthetic messages, maximum body 120 bytes, and 10-result ordinary pages. CPU time can exceed elapsed time because the runtime uses multiple threads. Local elapsed time is not Railway latency. The one exact-count sample is not a percentile or scalability bound; it occupies the sole reader much longer than an ordinary page.

The isolated supervisor harness's 57.2 MiB peak is **not additional permanent API RAM**. Its measured 0.218 CPU-seconds during two drains also includes diagnostic sampling every 2 ms; it is not a production scheduler coefficient. The permanent import/scheduler RAM delta, idle polling CPU and production claim/ack overhead remain unmeasured.

## Rates and arithmetic

Official Railway container rates checked on 5 October 2026: CPU **$20/vCPU-month**, RAM **$10/GB-month**, volume **$0.15/GB-month**, public egress **$0.05/GB**. The model assumes these container rates; confirm the applicable deployment product before estimating a bill. [Railway resource pricing](https://docs.railway.com/pricing/plans#resource-usage-pricing)

Use 30 days = 2,592,000 seconds and decimal GB (1 GB = 1,000,000,000 bytes):

- CPU cost = total CPU-seconds × $20 / 2,592,000
- Transient RAM cost = total GB-seconds × $10 / 2,592,000
- Volume cost = average additional occupied GB × $0.15
- Persistent API RAM cost = additional resident GB × $10

The measured ordinary child therefore costs approximately **$1.512 per million pages** (CPU plus transient RAM). One million apply jobs cost approximately **$0.247**, before seals and API bookkeeping. These are gross new-path costs: no legacy read-path savings have been measured or subtracted. Capture CPU differences were about 26/21/11 µs per insert/metadata/body update, respectively, and are negligible at the table's precision; API serialization and coordination are not covered by the child coefficients.

For writes, let M be inserts or metadata-changing updates and B be body-only updates. The [capture triggers](../../apps/api/drizzle/0051_queued_mail_search.sql) yield approximately **J = 2M + B** apply obligations: metadata changes refresh metadata and full modes; body-only changes refresh full mode. Repeated changes may coalesce; retries, moves, deletes and account cleanup can add work. A combined metadata/body update is not three independently executed jobs when the queued full obligation coalesces.

Seals depend on how accounts and changes group. The scenarios use S = ceil(J/16) for a batch-amortized illustration, through S = J when sparse changes each need a fresh seal. This is not a universal range or minimum: a single large backfill may need only the final two seals, while retries can add attempts. Since seal CPU was not separately profiled, the model assigns one measured mean apply-child cost per seal: **write cost ≈ (J + S) × $0.0000002469**.

## Illustrative monthly scenarios

These are low/medium/high **assumptions**, not observed search traffic. Added storage is an independent occupied-space budget including derived data, queue growth and average WAL occupancy; it is not inferred from message count or body size.

| Per 30 days | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Ordinary pages | 1,000 | 10,000 | 100,000 |
| Exact metadata-count requests | 100 | 1,000 | 10,000 |
| Inserts/metadata changes M | 1,000 | 10,000 | 100,000 |
| Body-only changes B | 1,000 | 10,000 | 100,000 |
| Apply obligations J | 3,000 | 30,000 | 300,000 |
| Average additional occupied storage | 0.1 GB | 1 GB | 4 GB |
| Ordinary reader CPU + transient RAM | $0.0015 | $0.0151 | $0.1512 |
| Writer CPU + transient RAM, including assumed seals | $0.0008–0.0015 | $0.0079–0.0148 | $0.0787–0.1481 |
| Added storage | $0.0150 | $0.1500 | $0.6000 |
| **Subtotal excluding counts and unmeasured API overhead** | **$0.0173–0.0180** | **$0.1730–0.1799** | **$0.8299–0.8993** |
| Exact-count sensitivity described below | $0.0008 | $0.0081 | $0.0815 |
| **Illustration with that count assumption** | **$0.0181–0.0188** | **$0.1811–0.1881** | **$0.9114–0.9808** |

Exact counts must retain their own coefficient. For Q such requests, measured CPU-seconds C and measured RAM GB-seconds R per request would cost **Q × (C × $0.000007716 + R × $0.000003858)**. The sensitivity row assumes **C = 1 CPU-second**, not a measurement, plus **R = 0.1125 GB-seconds**, a proxy obtained by holding the sample's reported peak throughout its 1.039-second elapsed time. That proxy is not a measured RAM integral or production upper bound. Each additional assumed CPU-second per count adds $0.00077/$0.00772/$0.07716 to the three columns. A two-second wall deadline does not imply a two-CPU-second limit.

Add unmeasured permanent API RAM separately: **10 MB = $0.10/month; 50 MB = $0.50; 100 MB = $1.00**. Every additional 0.001 average vCPU adds $0.02/month. Idle five-second polling means about 518,400 checks/month; its CPU cost must be measured rather than treating those checks as free. These persistent effects can outweigh the child cost at personal usage levels.

## One-time backfill and storage headroom

A both-mode baseline needs roughly **2N apply jobs** for N stored messages, plus seals and baseline enqueue. Multiplying measured tiny-job coefficients gives the following **extrapolation**, not a measured end-to-end backfill:

| Messages | Apply jobs | Apply-child CPU | CPU charge | Child active wall time | Approximate wall time with five-second pauses |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20,000 | 40,000 | 1,263 CPU-seconds | $0.0097 | 18.4 min | 3.8 hours |
| 100,000 | 200,000 | 6,316 CPU-seconds | $0.0487 | 92 min | 19 hours |

Paced wall time uses **ceil(J/16) drains**, approximately **0.474 seconds per drain** from the small supervised sample, and **5 × (drains − 1) seconds** waiting. The drain sample included seals; their exact backfill count differs. Baseline enumeration, actual body sizes, parent overhead, contention, failures and verification add uncertainty. The 20,000-message fixture's **12.66-second in-process preparation is not supervised backfill speed**. Operator-driven drains have different pacing; no deployment command or tuning is authorized by this calculation.

The fixture contained **3.77 MiB of indexed source text**. After checkpoint, canonical SQLite occupied **40.83 MiB** and the metadata+full derived file **37.57 MiB**. The derived file alone would cost about **$0.0059/month** if retained at that size. It was about 10 times this unusually small source text; **do not extrapolate that multiplier to real bodies**. Canonical size includes the existing mail store and allocated/free pages, so it cannot all be counted as a new search cost. Queue/schema growth was not isolated at production scale.

Before checkpoint, canonical WAL was **40.26 MiB** and derived WAL was zero; both were zero after TRUNCATE checkpoint. Those are phase-boundary observations, not maximum WAL sizes, and the canonical WAL is not wholly attributable to search. Capacity planning must include canonical data, queue, derived file, both WALs, consistent backups and temporary rebuild copies. Railway charges for **used** volume space, including filesystem overhead, rather than the selected capacity. Unoccupied headroom itself is not a second copy of the storage charge. [Railway volume billing](https://docs.railway.com/volumes/reference#pricing)

## How a bill would change

Actual deployment capacity, resource baselines, workspace usage, plan and credits are not included in this public model. An unchanged invoice cannot be promised from synthetic benchmarks.

For a standard Hobby workspace, the $5 minimum includes $5 of usage; Pro's $20 minimum includes $20. Before other credits, taxes and add-ons, invoice impact follows **max(minimum, existing workspace usage + increment) − max(minimum, existing workspace usage)**. Extra metered usage can leave the bill unchanged while the workspace remains below its included amount. [Railway included usage](https://docs.railway.com/pricing/plans#included-usage)

## What still gates deployment

The [worker limits](../../apps/api/src/search/indexing/queue.ts) admit only 32 KiB metadata text or 256 KiB total full-search text per job. Oversize jobs block the affected account/mode instead of silently truncating; this can prevent complete search. Those provisional limits require representative real-body evidence before activation. The sampled memory watchdog is not a hard isolation guarantee.

This report adds no new stress or security testing. The prior PR 224 security validation remains incomplete. Production-like durability, process isolation, real-body storage/throughput, exact-count resource costs and the permanent API delta still need review. See the [migration plan](queued-search-migration-plan.md) for rollout gates; small estimated costs do not clear them.

Evidence: [final-read.json](evidence/final-read.json) (2026-10-05 22:55 UTC) supplies the frozen-source read/count/storage observations; [capture-and-write.json](evidence/capture-and-write.json) (22:46 UTC) supplies capture/supervised-write measurements. The earlier report's read figures are superseded. Source hashes were checked against the current files when calculating this report. The [benchmark harness](../../scripts/ci/queued-search-benchmark.ts) describes collection; the [cost-model JSON](evidence/cost-model.json) records synthetic arithmetic and explicit hypothetical assumptions; private production observations are excluded.
