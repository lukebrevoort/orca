# Gmail timestamp fallback pilot

- Intent / selected playbook: `bug-fix`; prevent malformed Gmail `internalDate` from aborting a persistence batch. Reuse the existing missing-date epoch policy.
- Acceptance: invalid and out-of-range timestamps normalize to epoch; valid numeric/ISO dates retain behavior; a mixed valid/invalid batch persists; another account's colliding provider IDs remain unchanged.
- Owner / independent reviewer: `/root/pilot_scope`; reviewer assigned by `/root` (pending). Separate agents, model diversity not claimed.
- Status: **running**
- Updated (UTC): 2026-10-15
- Base SHA / branch / worktree / draft PR: `2d104ea394cc319c085d8983d2c17a923c2be467`; `fix/pstack-gmail-date`; `/workspace/orca-pilot`; draft creation pending independent review.
- Scope: Gmail normalizer and focused synthetic tests only. Excludes PR235 search/performance, PR248 workflow, merged #249 catch-up and #250 reminder behavior. Does not edit sync implementation or existing performance tests.
- Dependencies / next action / blocker: workflow procedure read from `/workspace/orca-pstack` integration commit `9464927`; product base remains main. Next: independent review, committed-head verification and draft CI. No implementation blocker.
- Fixture/privacy: temporary migrated SQLite DB, synthetic example.com identities, same provider message/thread IDs in two accounts. Assert account B's full email rows unchanged, account-scoped thread IDs, correct message counts/latest timestamps. No live API/mail, credentials or persistent database changes.
- Before-fix: [original red log](../../verification/gmail-date/red-tests.log): 2 failures, 8 passes on main product code plus new tests. Both failures are `RangeError: Invalid Date` at normalizer entry; batch fails before writes. [Development green](../../verification/gmail-date/green-tests.log): 12 passes, no failures after guard.
- Final executable commit / final PR head: pending first implementation commit and parent handoff.
- Verification: development focused normalizer and SQLite persistence tests passed; final immutable-head tests pending. Bun 1.3.14, frozen-lockfile install in isolated worktree.
- Independent review: pending exact committed base/head and dispositions; owner self-check is not independent review.
- UI evidence: not applicable; no UI changes. Compose browser trial cannot establish provider timestamp correctness and is intentionally not duplicated.
- Hosted checks: pending draft PR; reuse automatic runs, do not dispatch extras. No native local execution claimed.
- Cleanup: test closes its owned SQLite connection and deletes only its unique temporary directory in `finally`; worktree, logs and branch retained.
- Limitations: synthetic malformed provider inputs establish resilience, not evidence that Gmail has delivered malformed dates in production. Existing ISO-string fallback remains supported. Setup workflow is read from separate unmerged draft; this focused product branch does not bundle workflow scripts.

## Decisions

| Phase | Decision / reason / evidence |
| --- | --- |
| Scope | One implementation owner suffices for a two-line date guard and two focused test files; independent reviewer follows commit. |
| Reproduce | Added behavior tests first; original failures retained without rewriting. |
| Fix | Validate the constructed Date with `getTime()`, because a finite number can still exceed JavaScript Date range. Reuse epoch fallback; no new parser/framework. |
| Verify | Unit boundary table plus real SQLite batch/account assertions cover the changed provider seam. Existing batch regression tests run unchanged. |
