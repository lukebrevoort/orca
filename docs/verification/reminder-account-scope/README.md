# October 15 bug sweep: second-account reminders

Baseline main: `9844aca646feabbc843980ecdba1bf5e5fe34b14`, verified with `git ls-remote` before editing and again before publication. The worktree was clean. The only open PRs were #235 (search/performance), #248 (pstack), and #249 (reader catch-up). Their exact heads are recorded in `baseline-refs.txt`. All changed-file lists were inspected. #235 also edits the large API entry point, but its patch is limited to a separate search import and inbox search route; no reminder hunk overlaps. No existing PR code or status was changed. Root AGENTS.md and CONTEXT.md were read; main has no `.agents/skills` directory (the pending pstack PR introduces it).

## Reproduction and root cause

Authenticated requests from a user with two Gmail accounts always resolved the first Gmail account in reminder create, list, update, complete, and cancel handlers. The existing web caller supplies the globally unique local thread ID on create and the reminder ID on mutation; it does not supply an account selector. A second-account thread could be read, but scheduling its reminder returned `404 Thread not found`. Existing second-account reminders were omitted from the list and could not be updated.

Test-only commit `9bd970593f4546eff915832036d96794cca47ed4` reproduces this on unchanged main: **3 failures / 1 pass**, recorded in `red.log`. The failures are create 404 instead of 200, list missing the second reminder, and update 404 instead of 200. Foreign-account and unauthenticated rejection controls pass. An initial fixture setup failure (missing synthetic encryption key) was corrected before collecting this behavioral evidence; it is not counted as a product failure.

Runtime fix: `1ff305a6693fc13fc795fafb281cb812d15f238e`. Test helper typing correction: `50bc0a0d8c125ca814eb1d71c4fd2b0f8aa54219`. The fix resolves the permitted Gmail account IDs from the authenticated user, scopes thread/reminder lookup to those accounts, creates against the resolved thread's account, and lists/resurfaces their reminders in the existing stable order. The existing provider boundary is retained: Outlook reminders remain unsupported. No request or response schema changes, migration, frontend, native code, or dependencies are introduced.

The four new synthetic tests cover first/second-account scheduling, fresh creation on the second account, existing reminder identity preservation, cross-account list/resurface, snooze/complete/cancel, and rejection without writes for foreign/unsupported/missing/unauthenticated targets. Identical provider-thread IDs across accounts exercise local identity scope. Fixtures use disposable SQLite databases, synthetic sessions and a controlled reminder clock; no provider requests or live mail are involved.

## Validation

- Initial fixed focused API run: **40 tests passed** (`green-focused.log`). The subsequently added fresh-create assertion also passes.
- Workspace typechecks passed. All **1,469 tests passed** (95 shared, 744 API, 630 web); see `workspace-test-summary.log`.
- Independent review of exact test head `50bc0a0d8c125ca814eb1d71c4fd2b0f8aa54219` found no blocking issues, independently reproduced 3 baseline failures / 1 pass, and passed 6 reminder tests on the fixed head; see `independent-review.md` and logs.
- Production build passed (`build.log`). Exact-head hosted CI results are recorded in the PR after publication.
- Reproduce: `bun test apps/api/src/reminder-account-scope.test.ts apps/api/src/index.test.ts` with Bun 1.3.14 and installed locked dependencies.
- For red reproduction, archive test-only commit `9bd970593f4546eff915832036d96794cca47ed4` and run its reminder test; the application runtime is byte-identical to main.

## Explicit limits

This is one bounded account-journey fix, not an exhaustive sweep. Draft interruption/recovery was not investigated. Reminder display-name settings still use the existing default Gmail account; account-specific notification defaults, Outlook reminders, push/OS delivery, pagination, concurrent requests/disconnects, and browser/native end-to-end reminder interactions are not established by these route tests. There are no UI code changes or visual claims, so no new screenshots are required. Existing hosted fixture CI supplies broader regression evidence. No manual native dispatch, merge, deployment, release, production migration, live-mail test, paid infrastructure, credential change, or sign-in was performed.
