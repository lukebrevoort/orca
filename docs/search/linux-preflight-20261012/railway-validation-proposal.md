# Proposed minimal Railway validation — approval required later

**Not authorized or started.** The former $1/one-hour permission remains expired. This proposal does not authorize cleanup, production use or deployment. It can establish an initial bounded staging gate, not general production capacity or power-loss durability.

## Proposed authorization envelope

- At most **$1 of new incremental staging spend**, **45 minutes total lifecycle** from starting a build, and **20 minutes maximum measured execution**. No automatic retry, no new service/volume/add-on, no limit increase, no external provider/mail calls. Use the existing synthetic service/volume only if still suitable and explicitly authorized.
- Existing service configuration is 8 vCPU / 8,000,000,000 memory bytes, one replica, restart NEVER; leave unchanged. Each comparison child gets 90 seconds; concurrency phases get 60 seconds. Stop on failed correctness/durability assertions, timeout, growing resource usage beyond limits, or cost uncertainty. Do not weaken SQLite settings to pass.
- Budget accounting runs from build start through verified compute stop, plus a 24-hour retained-storage reserve; retention beyond that needs a separate explicit choice. Before starting, verify an authorized build/deployment cancellation route and an operator who will stop an overrun by minute 45, without deleting the volume or changing settings. A runtime deadline cannot stop a build that never reaches runtime; if cancellation cannot be assured, do not start.
- A reviewed absolute deadline must make the harness exit, with restart NEVER verified before execution. Capture results and verify compute has stopped by the lifecycle deadline. Deleting the service/volume is a separate decision and is not part of this proposal. Retained storage may continue to incur charges after compute stops.
- Budget feasibility reference: published rates are $0.000463/vCPU/minute and $0.000231/GB/minute. At the existing 8 CPU/8 GB ceilings for all 45 minutes, runtime CPU+memory would be about **$0.25**, excluding builds, egress, retained storage and existing plan costs. The $1 proposal leaves headroom but is **not a platform-enforced billing cap**. Before starting, estimate those additional charges and hold if total cannot conservatively fit the cap. No billing settings should be changed.

Rates: [Railway pricing plans](https://docs.railway.com/pricing/plans), [resource pricing](https://docs.railway.com/pricing), checked 2026-10-12. These are planning estimates, not a bill or renewal of past authorization.

## Prerequisites

1. Make the complete staging harness available and review it, or explicitly approve a replacement. The Mac-only `ef561916` artifact has not been recovered or verified here. Do not assume the committed offline harness is equivalent.
2. Pin then-current main and the intended integration candidate, with their own frozen dependencies. Capture runtime, filesystem/mount, SQLite version, connection settings and configured resource limits. Record actual baseline synchronous mode without changing it; candidate must be WAL/FULL on every connection.
3. Review deterministic synthetic fixture distributions against intended use before calling them representative. No real mail. Proposed initial envelope: 1k and 10k messages, four owned accounts plus a foreign account, 1–4 labels/message, explicit rule/override cases, 33-KiB subject and 257-KiB body outliers; preserve exact expected counts and ordered result signatures.
4. Approve the thresholds below before running. Treat them as initial go/no-go targets, not existing product SLOs. A failed gate calls for investigation or a new plan, not relaxed durability or repeated spending.

## Minimal measured matrix and proposed gates

- Two paired trials at each size, alternating revision order: eight sequential children, three warmups plus 20 retained samples/workload. Include common/selective/absent/oversized queries, account/ownership filtering, pagination, explicit metadata receipts, full-body rejection, 25-message persistence and replay.
- Add one 60-second mixed phase per revision: two readers at no more than two total queries/second plus one writer at no more than one 25-message batch/second. Bound offered work, completions and backlog. Observe checkpoint/WAL behavior with default settings; do not force NORMAL or suppress sync/checkpoint cost.
- **Correctness:** exact signatures/counts/pages match; no foreign-account results; legacy envelope and receipts correct; no silent full-body fallback; no SQLite busy failures or lost completed writes.
- **Reads:** common-query p95 <=500 ms at 1k and <=1,000 ms at 10k; candidate legacy p95 <=1.25× matched baseline. Report explicit metadata separately. Apply same absolute limit to completed mixed-phase reads; any unfinished offered work fails the phase.
- **Persistence:** 25-message local persistence p95 <=1,000 ms and <=1.25× baseline, no growing writer backlog; report unchanged replay separately. This does not measure provider fetch time.
- **Resources:** sampled process RSS <=512 MiB; whole service sampled memory <=1 GiB; synthetic DB+WAL+SHM <=256 MiB; WAL <=64 MiB after writer quiescence and successful checkpoint, with no continuing growth. These are proposed experiment gates, not reduced platform limits. Record sampled versus peak limitations explicitly.
- Require repeatable direction across both pairs; a lone warm-cache result does not support a speedup claim. Retain raw observations, scripts/hashes, failures and resource timeline even on abort.

Cold-cache isolation, larger/more diverse mailboxes, longer sustained concurrency, real storage failure/power loss and full production capacity remain outside this minimal plan. Passing it supports only the reviewed fixture/load envelope and would not authorize merge or production deployment.
