# Proposed staging and rollout — not authorized or executed

PR235 remains draft. Updating this branch authorizes only ordinary PR CI/previews. It does not authorize production merge, migration, activation, paid staging, deletion, or release. This plan does not renew any earlier budget.

## Current deployment coupling

Read-only inspection on October 20 found Railway production tracks `lukebrevoort/orca:main`, `checkSuites:false`, one replica, with no staged changes. Vercel showed a Git-triggered production build for main `6fa05f9cd6891a58a986fc922ebc4d94b3ac5efe` (PR263 merge). Main's `railway.json` starts `bun --cwd apps/api start`; that script invokes the migration runner before starting the API. PR235 introduces no new schema migration, index, capture queue, worker or backfill. Nonetheless merging is a production action, not merely publishing code.

The API import conflict must retain both metadata receipt and image imports. The grid conflict must retain main's `minmax(0,1fr)` column plus PR235's coverage row. Main's account-choice fixes and scheduler changes remain intact.

## Proposed one-shot representative synthetic validation

Luke's decision would authorize **at most $1 additional usage, 45 minutes total lifecycle, and 20 minutes measured runtime**, using only the existing synthetic service/volume. No automatic retry, resource deletion, real mail, credential changes or production access. Approval is conditional on a fresh cost estimate fitting the cap, including any agreed storage-retention reserve; $1 is not a platform-enforced hard billing limit.

Before requesting approval of the exact run:

1. Freeze the then-current main, reviewed integration executable, replacement-harness source, dependency lock and runtime image digest. The original Mac-only harness is not claimed recovered. Verify source provenance and run the replacement harness's local control tests; any required harness re-pin/correction receives review before paid execution.
2. Inspect existing synthetic service configuration and pending patch read-only. Require one replica, restart NEVER, no cron or domains/proxies, unchanged CPU/memory/volume limits, synthetic-only data, and the intended `staging/railway-search/railway.json` configuration. A deployed application's root config must not accidentally start production services or restart the harness.
3. Name an authenticated lifecycle operator and verify supported cancellation **before launch** for queued, building, initializing and running states. Dashboard Abort for in-progress deployment and Remove/Stop for running deployment must preserve the service and volume. Confirm the queued-state route explicitly; available MCP here exposes no proven service-preserving stop/cancel action. No delete-service fallback. If any state cannot be stopped, do not launch.
4. Prepare the exact patch specification offline, pinned to the immutable commit, unique run ID and absolute deadline. Platform staging and acceptance happen only after explicit authorization. Inspect all staged fields; accept once. Operator watches continuously, stops on any failed gate/instability or budget/deadline risk, and confirms terminated compute by the 45-minute deadline. Capture before/after state, logs and metrics. Retain the volume; do not infer zero ongoing storage cost.

Retain the existing thresholds, not a favorable subset: paired account-boundary/result/count/page correctness and storage signatures; actual baseline durability preserved, candidate WAL/FULL; stable identical-source baseline guard; common read p95 <=500ms at 1k and <=1,000ms at 10k; every compared legacy and new-persistence p95 <=1.25× baseline; persistence and mixed p95 <=1,000ms; sampled process RSS <=512MiB, service memory <=1GiB, synthetic files <=256MiB, quiescent WAL <=64MiB. Existing harness outgoing-traffic abort threshold is 1GiB; sampling is not a firewall or instantaneous peak guarantee. Paid-run failure remains failure; no repeat until pass, no weaker durability/authentication or looser thresholds.

Historical staging failed the relative gate and did not reach mixed work. Local diagnostics did not identify a justified application fix or clear the gate. This integration does not change that conclusion. A future pass covers only its synthetic fixture/limits, not power loss, arbitrary production distributions or capacity.

## API-before-web production sequence for a later decision

No runtime subset is split or merged by this task. Once exact-head correctness and performance evidence are accepted, Luke must explicitly approve the production rollout and the necessary deployment-control steps.

1. Refresh source and platform configuration again. Agree on the exact API/web artifacts, rollout operator, monitoring window, abort criteria and recovery target. Confirm all deployed schema versions and account for the existing startup migration runner; no new or pending migration may run under a blanket “no migration” assumption.
2. Before merging, establish a verified hold on automatic **web production promotion** (and control API promotion as needed). Such platform configuration changes require separate explicit authorization. Do not trust independent Git auto-deploy timing to enforce ordering; do not simply merge this combined PR and hope API wins.
3. Deploy the reviewed API compatibility artifact first, retaining FULL. Verify health and synthetic authenticated explicit metadata receipt, full-mode 503/no results, and legacy envelope compatibility through an approved non-live-mail verification path. Confirm the intended commit is serving before proceeding.
4. Promote the matching web artifact only after API verification. Check honest coverage labeling, multi-account navigation, mobile containment and visible compatibility errors. Observe agreed error/latency/resource thresholds; do not use real-mail benchmarks.
5. On failure, roll back **web first**, then API if necessary, using a pre-reviewed recovery artifact that preserves FULL. An arbitrary pre-PR API revert removes explicit FULL enforcement and is not the approved durability-preserving rollback. Stop and reconcile any migration issue independently.

A separately reviewed deployment arrangement may change how these stages are delivered, but must not bypass performance acceptance or security/durability controls. Approval of staging is not approval of production.
