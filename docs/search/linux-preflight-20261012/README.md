# PR 235 final pass — 2026-10-12

**Keep draft. Preparatory Linux checks do not establish representative Railway readiness.**
No runtime change was needed in this pass. The committed benchmark had a platform-specific assertion bug; the correction records the unmodified baseline and still requires candidate WAL/FULL.

## Reviewed sources and integration

- Refreshed PR head: `fcd007220f73453031884d22f6935b354011e2cb`.
- Refreshed main: `ab541c00d6e8dc23812d05004c0611fe9fd19c32`.
- Harness/test-title/documentation correction: `3ba1f61` (descendant of PR head).
- Main + original PR merged without conflict in an isolated local worktree. Initial integration tree: `683986c28f9087a028a041b1b1487eb7471d075c`.
- Corrected local integration commit: `75d46dc3b5af3fd7a5e4a1806d5f729bc68a6480`; tree `e803849fe13893ba2b2e21501e6358b8e6d50a2d`. This local merge was not pushed to main or the PR. It adds only the same harness/docs/test-title correction; application source is identical to the initial integration.

Independent review found no blocking runtime regression in the patch. Explicit metadata uses the unchanged canonical reader and ownership checks. Requests without a search mode retain their envelope and cursor semantics. Authenticated full-body requests return 503 without results; unauthenticated requests remain 401. Web validates the literal metadata receipt, including pagination, and visibly fails against an old API. API must precede web; rollback web before API and retain explicit FULL.

This stage creates no schema, capture queue, index, worker or background drain. Exact counts and substring filtering still scale with stored metadata. Page projection bounds are not count-work or metadata-byte bounds. Same-owner delete/recreate cursor fencing remains unproven for the later capture stage; the test name now states what it actually proves.

## Reproduced blocker and correction

[Original committed-harness failure](baseline-blocker.log): Bun 1.3.14 Linux reported `{synchronous: 2}` where the baseline assertion demanded `{synchronous: 1}`. It failed before any measured query and produced no success JSON. The correction accepts an observed NORMAL or FULL baseline, records the actual value, and continues to require FULL for the candidate. It never sets the baseline's synchronous mode.

The original Mac harness is retained byte-for-byte at [performance-evidence/harness.ts](../performance-evidence/harness.ts), with SHA-256 `ff48cae2b9286951e8a9d3c87f2d5f8772e6711e803133550bd0c95263c9e724`, matching the historical manifest. Recomputing all 93 historical summary rows leaves the summary and report unchanged. Future runs snapshot their own harness. The historical summary renderer intentionally rejects other platform/durability combinations rather than labeling Linux FULL/FULL data as Mac NORMAL/FULL. Use a separate report for those results.

## Verification boundaries

- Original PR: 56 focused API tests, 207 assertions, passed on Linux ([log](head-api.log)).
- Initial current-main integration: 93 focused API, shared-schema and web-search tests, 373 assertions, passed ([log](integration-focused.log)).
- Workspace typechecks passed ([log](integration-typecheck.log)). Typecheck began on the initial integration; the only overlapping changes were the documented harness/docs/test-title correction, outside application behavior.
- Corrected integration contract recheck: 3 tests, 35 assertions, passed ([log](corrected-integration-contract.log)).
- Workspace production build passed on the corrected integration ([log](integration-build.log)). No deployment was performed.
- Historical summary regeneration passed; Python syntax parsed for both benchmark scripts and this preflight runner.
- Hosted Unit Tests and Fixture Checks were re-read as successful on **fcd0072 only**: [unit tests](https://github.com/lukebrevoort/orca/actions/runs/37944534469), [fixtures](https://github.com/lukebrevoort/orca/actions/runs/37944534396). Those are not new integration or correction-head passes.
- Prior security reviews remain pinned to their recorded heads. This pass is independent correctness/compatibility review, not a new security clearance. No new native/browser visual validation is claimed.

## Railway state and cost boundary

Read-only Railway inventory and deployment logs confirm that [the old synthetic staging service](https://railway.com/project/11ba9a74-676d-404c-9f66-00d173a42149/service/c39760aa-ad0a-4f40-a8d4-44a6328c534e?environmentId=33d450ee-d1d7-4d4b-96bc-b46580fc230d) remains **CRASHED** and its **5,000 MB allocated volume remains live and attached**. There are no staged changes. [Sanitized status and failure evidence](railway-status.json) records deployment `312cd352-aa26-46a3-939b-9afbd68fa7a1`, whose failure reports **offered 0 / completed 0** with the same FULL-versus-NORMAL assertion. This is direct evidence of the original failure, not a recovered full harness or a performance measurement.

The complete staging harness and reported commit `ef561916` were not found in this cloud workspace. The user's Mac was not accessed. The corrected committed offline benchmark is not equivalent to that staging harness.

No Railway resource was created, redeployed, restarted, deleted or reconfigured. No new staging budget was used or authorized; the former $1/one-hour permission remains expired. This read-only inventory does not establish accrued billing or actual disk usage. A crashed service with retained storage is not proof that charges have stopped.

## Luke's remaining decisions

1. **Cleanup:** decide whether to explicitly authorize deletion of the named crashed synthetic service and its disposable volume, or retain them. Cleanup approval was cancelled earlier and has not been renewed. Neither resource has been deleted.
2. **Advancing validation:** keep draft until a separate representative staging plan is approved. It needs a reviewed, available harness, a new dollar/time cap, and explicit p95, throughput, memory and disk acceptance budgets. Preserve actual baseline durability and require candidate FULL. No merge/deployment authorization is implied by approving cleanup or a measurement.

Still unproven: representative Railway storage/mailbox distributions, many-account and rule/override-heavy workloads, concurrency/lock waits, checkpoint pressure, cold cache, sustained sync throughput, capacity limits, and power-loss durability. No real mail is needed or authorized for this task. This stage's existing canonical scan costs are not hard resource bounds.

## Bounded Linux preflight method

[Runner](run.py) uses frozen-lockfile dependencies in separate checkout-local workspaces, candidate `3ba1f61` and original baseline `6ac83d1`, and the corrected candidate harness. It requires an unused output directory and aborts on any failed assertion or timeout. To reproduce, create immutable checkouts at those revisions, install their frozen dependencies, then run:

```sh
python3 docs/search/linux-preflight-20261012/run.py /path/to/bun /path/to/base /path/to/candidate /path/to/new-output
```

Only 1,000 and 5,000 owned synthetic messages plus ten foreign messages per database; two owned accounts, one label per message, three warmups and five samples per workload. Four child processes run sequentially, base/head at 1k then head/base at 5k; this is one pair at each size, not repeated trials. Candidate additionally exercises explicit metadata. The inherited harness checks oversized metadata/body behavior, foreign-scope denial, full-mode rejection, exact counts/pages, response signatures, and real synthetic persistence/replay with propagation disabled. No provider network or real mailbox is involved.

Limits: each child 90 seconds; no new child after 270 seconds; a 270-second scheduling window plus at most 90 seconds for the final child (360 seconds including the final child, plus setup/teardown). Host cgroup ceiling was 4 CPU cores and 16 GiB memory; this is a shared cloud environment, not the prior Railway service. Temporary synthetic SQLite files use the host's temporary filesystem, not representative Railway volume storage. Application DB connections keep their actual settings. Tests/builds were complete before these measurements began; ordinary shared-host activity is uncontrolled. All observations include assertions and JSON parsing; sampled RSS can miss transient peaks.

## Linux preflight result

All four child processes passed in **61.86 seconds**, with **WAL/FULL on both baseline and candidate**. Every paired result signature and seeded/final checkpointed size matched. [Manifest](manifest.json), [descriptive summary](summary.json), [run log](linux-preflight.log), and four raw files linked by the manifest are retained here. There is no speedup, cost, capacity, or incremental FULL-cost claim from one warm pair per size with different candidate workload counts.

Independent read-only review verified the runtime diff and correction, historical harness fingerprint, all four Linux records and paired equality, test totals, typecheck/build outcomes, and local integration tree. No blocking runtime issue was found. This was not a fresh hosted/security/staging review.

## Publication boundary

The correction and evidence are local review commits. The existing PR receives a factual comment; its branch is not pushed because that could trigger the existing Vercel preview deployment integration. Read-only Vercel project/team lookup confirmed the project but did not expose billing or enough Git-deployment configuration to establish whether that side effect is permitted under the no-paid-infrastructure restriction. A portable Git bundle and patch are retained in `/workspace/pr235-evidence/`. Applying the correction to the PR needs a publication route that does not trigger prohibited deployment, or explicit permission for that side effect. This does not require creating a duplicate PR.
