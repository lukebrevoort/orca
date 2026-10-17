# Bound thread-cache generation history

Repeated refreshes of distinct conversations left a generation entry for every historical thread, even after its payload had been evicted. This change retains identities only for cached payloads, current pending requests and live reader callbacks. Both reader callbacks explicitly release their identity lease on completion or cancellation. Account-scoped identity and stale-response rejection remain intact.

Base: `5baf7f3ea9e208001c607a7bc0f5c418fb056d58`.
Reviewed and tested executable: `fc39756c4a120c5cb887b2381dfefbcac937494c`.

## Measured state counts

Four sequential fresh containers, base/head/head/base, each with 10,000 distinct synthetic account/thread references, 20,000 loader calls, 10,000 stale refreshes and capacity30. Every return was checked against the requested thread. Payloads are minimal opaque synthetic objects with a1KiB body; this exercises cache lifecycle, not HTML rendering or wire-schema validation.

| Distinct stale-refreshed threads | Baseline generation entries (both runs) | Candidate entries (both runs) | Payload entries / pending requests (all runs) |
| --- | ---: | ---: | ---: |
| 100 | 100 | 30 | 30 / 0 |
| 1,000 | 1,000 | 30 | 30 / 0 |
| 5,000 | 5,000 | 30 | 30 / 0 |
| 10,000 | 10,000 | 30 | 30 / 0 |

All four children exited0,47.635s total container lifecycle. Each was capped at2CPU/512MiB, network disabled,30s inner timeout plus5s kill grace/40s outer timeout. No tests, builds or competing containers ran during this measurement; the runner stops if another container is present. Shared-host hardware is not claimed exclusive. Largest sampled RSS101.516MiB; no matched RSS improvement is claimed. Zero cgroup quota throttling was recorded in these children.

This is a bounded-bookkeeping improvement, **not measured browser heap savings, latency improvement or OOM prevention**. Initial Bun heap snapshots repeated the same implausible reading across several checkpoints despite forced GC, so they are retained but not used to infer retained bytes.448,890UTF-8 bytes of baseline keys at10k is an encoding count, not physical JS heap size. Elapsed fields include GC/workload/container overhead and are not interaction latency. Candidate now retains an identity for each cached payload even without invalidation; ordinary control loads previously retained none.

The initial control/stale/stale/control experiment is preserved separately: all20,000-load runs retained30 payloads, but stale cases retained10,000 generation keys while controls retained0. Growth is per distinct superseded reference during a cache lifetime, not every mailbox message or every ordinary navigation.

## Correctness and review

The naive-pruning negative control accepts/caches an invalidated late response after deleting its generation. The real correction uses never-reused positive IDs plus explicit leases; missing metadata never matches a request. A current failure or evicted success remains current until its reader consumer finishes. Active work can still retain identities; there is no fixed cap that silently discards pending readers.

- Red resource regression on original main: expected3 retained generations, received100.
- Final executable web suite:649 passed,0 failed,4,985 assertions across56files.
- All three workspace typechecks and production build passed.
- New tests cover distinct-key bounds, eviction before continuation, current errors, late success/error, supersede/prune/reload, account isolation, repeated release and synchronous loader throws.
- Independent reviewer `/root/independent_review` reviewed main→`fc39756`. It found a synchronous-throw cleanup defect in the initial candidate; corrected and re-reviewed with no remaining source blocker. Separate agent, no model-diversity claim.

`web-tests.log` is the exploratory run:647pass/2fail. The cache module was loaded before the synchronous-throw correction while its newly added test ran afterward, so this is not an immutable revision pass. The other failure is the known PR252 Retry fixture request-count mismatch (2expected/3observed). Both failures are preserved. The final immutable full suite passed; this change does not claim to fix PR252's fixture timing or mobile-anchor issue.

No visible layout/style change; full reader interaction tests passed. This is not new visual-parity, native or browser-performance evidence. [Broad sweep coverage and gaps](COVERAGE.md) distinguishes historical search/reader/native evidence. PR235's representative Railway acceptance remains unresolved.

## Reproduction

Use Bun1.3.14 and the repository frozen dependencies. From executable commit:

```sh
bun --cwd apps/web test
bun run typecheck
bun run build
```

The paired harness source and raw results are in `paired/`; pins/source hashes are in `paired/pins.json`. For a new disposable evidence directory, copy `paired/cache-growth.ts` and `paired/run.py`, then materialize modules there:

```sh
git show 5baf7f3ea9e208001c607a7bc0f5c418fb056d58:apps/web/src/thread-detail-cache.ts > base.ts
git show fc39756c4a120c5cb887b2381dfefbcac937494c:apps/web/src/thread-detail-cache.ts > head.ts
```

The saved runner uses the pre-existing local image `orca-pr235-runtime:20261013` (Bun1.3.14 and GNU timeout). It requires that image and Docker already available; it does not install, build, download or provision anything. Run `python3 run.py` only in the new directory; it refuses to overwrite a run manifest. Absolute source mount follows the script directory. Source modules contain type-only shared imports, erased at runtime. A reviewer without that saved image can run each standalone module with Bun1.3.14 under their own equivalent offline resource limits, but that is a distinct environment.

Initial repro files similarly require original main's cache saved as `thread-detail-cache.ts` beside them. `fence-check.ts` deliberately clears private metadata only as a negative control against the original module; it is not application code or a proposed fix.

No live mail, credentials, paid infrastructure, deployment, migration or resource deletion. Owned containers used `--rm`; final container inventory was empty. Existing Railway charges/cleanup were not inspected.
