# October 20 PR #252 integration verification

Pinned main: `6fa05f9cd6891a58a986fc922ebc4d94b3ac5efe` (includes merged #261 and #263).
Reviewed executable: `98933664b47598bc85667af54d94336844ef1a03`.
Original PR #252 head: `43b76349eb829b2e37abda008ec58a25ef63512e`.

## Remaining scope

PR #261 commit `e522a41537318c3702ad9f2fd1ee5eb43fd6dafb` already integrated the scheduling helpers and three Retry cases from #252. Those blocks remain byte-identical to current main, as recorded in comparison.json. Only the silent-reader refresh fixture remains as an executable difference. All other current-main source, runtime, dependencies and newer fixes are preserved.

The old fixture counted first-view guidance, destination and primary mailbox reads together. Startup could prematurely serve updated mail and consume the injected detail failure. The repaired fixture distinguishes those query contracts, settles startup before arming the failure, and asserts exact primary-mailbox and account-qualified detail counts through failure, focus recovery and hot-cache prefetch.

## Current evidence

- Archived pinned-main source, same installed dependencies: 3 Retry cases pass; silent-refresh fails (expected 2 detail reads, received 3). See main-focused.log.
- Candidate focused run: 4 pass, 0 fail, 86 assertions. See candidate-focused.log.
- Independent reviewer: no blockers; independently reran 4 pass, 86 assertions and checked immutable source parity. See review.md.
- Full suite: 1,559 pass, 0 fail (95 shared, 787 API, 677 web). See full.log.
- All three workspace typechecks pass. See typecheck.log.

Focused command: `bun test apps/web/src/App.interaction.test.tsx --test-name-pattern 'retries a failed silent|fetches fresh detail after'`. Full checks: `bun run test` and `bun run typecheck`. Bun 1.3.14. Synthetic fixtures only; no live mail.

Automatic final-head checks are recorded on PR #252 after publication; this evidence commit does not assert their future result. The parent directory is historical October 16 evidence, not current-head validation. No UI/runtime change or new screenshot claim. The prior mobile-anchor observation is unrelated and remains unclaimed as fixed. This limited validation is not a claim that Orca is bug-free.
