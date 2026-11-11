# Independent re-check: BRE-457 candidate runner end-state boundary

## Verdict

**APPROVED for this narrow follow-up. The prior P2 runner finding is closed.** No new blocking correctness or security finding was identified. This does not approve merge, wire publication, native integration, full-workspace acceptance or hosted UI acceptance.

## Immutable scope and method

- Reviewer: `/root/recheck_saved_query_runner_44afb`, independent of the ROOT implementation turn, using the inherited Codex model/settings.
- Reviewed base: `0f07957a637c06bfdcda32263779772b57400ab6`.
- Reviewed head: `44afb3b1aee5bab1592144ed083a5196d57dedf0`.
- Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829`; initial head was exact44afb with empty Git status. Final observation was clean `551072fa4f445b4616bf1f701de103e0546bd9f1`, a concurrent follow-up after the pinned review. This verdict intentionally covers immutable44afb, not later additions.
- Read the complete intervening diff, full runner and new regression test, prior independent security/correctness reports, retained red/green runner logs, updated verification indexes and the historical source869 manifest. Applied the repository `interrogate` rubric.
- No tests, compiler, build, install, browser, server, provider, heavy command, child agent or checkout edit was performed. This report is the only file created, outside the checkout.

## Findings and closure

### Act on — none remaining in this delta

The original runner returned zero when stages passed even if ending HEAD changed or the checkout became dirty. At `docs/verification/bre-457-pin-query/run-candidate.py:119–128`, the finalization path now reads both ending observations, compares them with the admitted head/clean state, records `sourceStateMatched` and `sourceStateExit`, writes the manifest, and raises exit2 when the boundary does not match. Because this occurs in `finally`, a pending success return cannot bypass the check.

Clean-source runs retain the actual child-stage exit or original exception. With source drift, the overall exit becomes2 even if a stage already failed; the original stage code remains in the manifest. That remains fail-closed and does not manufacture success. Failure to observe Git state or write the manifest also propagates a nonzero exception rather than returning a pass. No cleanup/process-ownership code was widened.

### Noted — the regression exercises the actual runner boundary

`run-candidate.test.py:21–67` calls the real `main`, including initial exact-clean admission, allowed-path/ancestor checks, actual runtime/type metadata reads, stage launch/wait, manifest writing and finalization. It substitutes `/usr/bin/true` or `/usr/bin/false` for the type-stage commands and controls only the final Git observations through a wrapper that otherwise delegates to real Git. This isolates the evidence-runner exit contract without altering the checkout or asserting that a compiler/API check ran.

The retained baseline log at `/tmp/bre457-runner-source-drift-red-8e55183d.log` shows four executed cases, with precisely the changed-HEAD and dirty-source cases failing because they observed exit0 instead of2. The retained green log at `/tmp/bre457-runner-source-drift-green.log` shows the same four cases passing. The controls cover clean success and preservation of a real failing-stage exit1. I inspected these supplied logs; I did not independently execute them.

### Noted — nonblocking earlier documentation comments are addressed

The only intervening API source change is the comment at `apps/api/src/mailbox/read.ts:327–330`: bounded retained application rows are explicitly separated from candidate work and SQLite sort/cache memory. Executable API/shared code is unchanged in this follow-up.

The README and implementation checkpoint now distinguish current retained source869 focused/demo proof, f6d0 actual compiler proof, historical preparation text, and still-pending final gates. They explicitly retain the original Bun usage-only exit0 stages as **not executed typechecks**. The copied historical manifest remains unchanged in meaning; its old exit0 values are not promoted to compiler evidence.

## Security assessment and remaining gates

This closes the sole Act On finding from `/tmp/bre457-query-review-security-0f07957a.md`. No product security finding was introduced by the runner/test/documentation delta. The earlier API/shared source assessment remains scoped to its own immutable comparison; this re-check does not re-run or expand it.

A frozen final sequential lint/typecheck/full tests/build gate, final integration/wire publication, native client retrieval/UX and ROOT acceptance remain pending. The four runner regression cases are not semantic API tests, actual TypeScript execution, performance proof or native/OS acceptance.
