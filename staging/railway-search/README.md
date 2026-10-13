# PR235 replacement synthetic harness

This is a new, cloud-prepared harness. It is not the unverified Mac-only `ef561916` staging artifact. It has no Railway API calls and cannot provision, restart, delete or deploy anything. No real mail or provider requests are used. App sources and their durability settings are unmodified.

## Immutable application inputs

- Baseline current main: `0e6805131a9c8386107bf70f598e2b61b0cf6a0b`.
- PR235 application head: `993f6227bfc8d5d79513600455758c8197560666`.
- Reviewed local integration: `fdc78bce2d4e3169f870aaaffd62da20d9f46f30`, tree `87c2ea4907c287f20852c0a4bc5d242ded2bd16b`.

`prepare-sources.sh` fetches the two public commits, reconstructs and verifies the exact integration commit/tree, and installs each revision's own frozen dependencies without lifecycle scripts. The reconstructed commit preserves the existing commit object's authorship metadata; it does not create a newly attributed application change. `PERF_SOURCE_ROOT` permits preparation in a fresh local directory; Docker defaults to `/sources`. Bun and Python base images are pinned by registry digest. No floating app branches are measured.

## Measurement and controls

The paid-mode runner checks the exact synthetic environment/service IDs, a mounted `/data`, immutable application commits, Bun 1.3.14, and an absolute UTC `PERF_RESOURCE_DEADLINE`. It refuses a late start with less than 21 minutes remaining or a deadline over 45 minutes away. A separate operator must start that deadline before the build is triggered. `PERF_RUN_ID` must be a new `pr235-` timestamp identifier. Outputs go only into a newly created directory; existing volume data is not reused or removed.

Two alternating paired trials at 1k/10k use three warmups and 20 samples. Fixtures have four owned accounts plus a foreign owner, two messages per owned thread, 1–4 labels/message, oversized subject/body values, a Focus sender rule, and domain/message classification overrides. Requests cover legacy `view=all`, actual default Inbox/Focus grouping, older-message thread matches, selective/absent/body-only/oversized terms, ownership, pagination, metadata receipts and explicit full-body rejection. Persistence uses local 25-message batches and replay.

Baseline repeats legacy requests in the same positions as candidate-only metadata requests, under `control-repeat-*`. Current main strictly rejects the unsupported metadata parameter, so controls omit it and assert no receipt. This balances workload history before subsequent legacy/persistence samples; controls do not claim baseline metadata support. Relative gates compare shared legacy workloads only. This correction does not prove the cause of earlier failed comparisons.

Separate reader/reader/writer processes then run one 60-second mixed phase per revision at no more than two total reads/second and one 25-message write batch/second. Reports distinguish planned/offered/completed work. Missed scheduling by 500ms, unfinished work, failed correctness or a worker error stops the phase and kills peers. Worker snapshots use atomic replacement, preserving the last completed snapshot on termination. This is bounded synthetic concurrency, not provider throughput or power-loss testing.

Every opened connection asserts observed WAL and baseline NORMAL-or-FULL, with candidate FULL mandatory. Busy timeout and automatic checkpoint values are observed without changing them. A quiescent successful checkpoint and stable post-checkpoint disk size are verified.

`run.py` enforces 90-second child process-group timeouts and a 20-minute total runtime window; the Docker entrypoint independently applies a 20-minute OS timeout with a five-second kill grace. Group cleanup covers surviving grandchildren after parent failure. Restart **NEVER** and one replica must also be verified in Railway before launch. Local mode is rejected when Railway project identity is present.

Unchanged acceptance gates: common read p95 <=500ms at 1k / <=1,000ms at 10k; every compared legacy workload and new persistence candidate p95 <=1.25× baseline; persistence and mixed p95 <=1,000ms; sampled process RSS <=512MiB; sampled whole-service memory <=1GiB; synthetic files <=256MiB; quiescent WAL <=64MiB. The per-file OS safety ceiling is 256MiB, not the earlier erroneous 16MiB. Resource sampling is every 200ms and does not establish instantaneous peaks. Local mode skips Railway-specific service/network checks and is never representative Railway evidence.

Evidence and error logs remain on the volume. Compressed evidence is also emitted in numbered JSON chunks, capped at 8MiB. Runtime has no external network workload; observed outgoing traffic above 1GiB aborts. This polling threshold is not a network firewall. A paid run needs the external lifecycle operator in addition to these runtime controls.

## Exact launch and stop operations — not yet executed

1. Refresh main/head and verify the recorded application inputs are still the agreed comparison. Re-review if application inputs change. Publish an independently reviewed immutable harness source commit on a dedicated staging branch; no duplicate PR is needed.
2. Read the existing synthetic service and pending changes. Confirm one replica, restart NEVER, 8 vCPU / 8,000,000,000-byte limits, no cron, no domains/proxies, no start override or health check, and the existing 5GB `/data` volume. Keep all limits and durability/security settings unchanged.
3. Confirm the authenticated operator owns cancellation until compute is stopped, including a hard 45-minute lifecycle deadline. Railway documents **Abort deployment** for in-progress builds/initialization and **Remove** for stopping deployments while preserving the service and volume. The available crashed-deployment menu is evidence of access, not proof of a future queued-state cancellation control. Queued cancellation remains a coordination requirement; never substitute service/volume deletion.
4. Only after parent confirms all gates, stage the immutable GitHub source with `connect_service_source` (`staged: true`, exact environment and `commitSha`). Stage `railwayConfigFile: staging/railway-search/railway.json` so the application's root config cannot enable production startup/restarts. Stage the new `PERF_RUN_ID` and absolute deadline. Inspect the entire pending patch; accept exactly once only if it contains the intended synthetic changes.
5. The operator watches the new deployment immediately. Use Abort on in-progress work or Remove on runtime when needed, without Restart/Redeploy. Stop on any failed gate; no automatic retry. Capture raw logs/artifacts and read-only metrics. Verify termination and zero compute before the lifecycle deadline. Preserve service and volume.

The approved envelope is $1 additional usage, 45 minutes total lifecycle and 20 minutes measured execution. Conservative planning at existing ceilings is about $0.301 before tax including a 1GB egress allowance and 45-minute full-volume storage, plus about $0.025 for a 24-hour full-volume reserve. Builds are documented as free. This is not a platform-enforced billing cap; retained storage beyond the reserve continues accruing charges. No resource deletion, production operation or further spend is authorized by this file.

## Local verification and limits

Saved evidence is under `/workspace/pr235-evidence/oct13/`. Preserve all red results: the original 16MiB file-limit failure, the earlier 1.525× account-query gate, the candidate's 1,008ms mixed backlog, and the first fully supervised container comparison's relative-latency failures. Do not turn them into passes by ignoring thresholds. They are preparatory Linux observations, not Railway regression measurements.

Independent review approved process-group cleanup, strict gates, peer fail-fast, fixture coverage and atomic worker reports. Source reconstruction and frozen installs passed locally. The pinned runtime image built and a network-disabled 10k mixed smoke completed all six offered operations. The original apt-based build failed container DNS; the replacement runtime requires no apt step. The combined network-fetching Docker build remains distinct from these component checks.

The full API integration suite had 742 passes and one MCP fixture failure; main had 740 passes. A diagnostic reproduced a pre-existing two-clock fixture defect on both revisions: a 1ms gap makes a token exceed the strict 600-second limit, yielding HTTP500 before limiter admission. The historical failing response was not retained, so its exact cause is not conclusively attributed. No unrelated MCP source fix is included.
