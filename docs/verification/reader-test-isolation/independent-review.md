# Independent reader test review

Reviewed immutable head `4ff6db53215a4e1b629e39ad86042784773c1f45` against `2d104ea394cc319c085d8983d2c17a923c2be467` in /workspace/orca. Read AGENTS.md and the relevant reader effects/cache implementation. No source edits made.

## Result

No blocking findings. Diff changes only App.interaction.test.tsx (169 insertions, 100 deletions); runtime unchanged.

Independent command: `PATH=/workspace/.orca-tools/node_modules/.bin:$PATH bun test apps/web/src/App.interaction.test.tsx --test-name-pattern 'retries a failed silent|fetches fresh detail after'`

Bun 1.3.14: 4 pass, 0 fail, 131 filtered out, 86 assertions, 2.60 seconds. Tests passed: silent same-version refresh retry; explicit Retry and next-thread selection with held, completed, and in-flight prefetch.

## Review evidence

- Inbox fixture identifies destination, guidance, and primary mailbox queries before counting. It explicitly observes all three contracts and asserts primary mailbox classification/limit.
- Startup completes at two primary mailbox reads before selecting a reader and arming the failure. First focus produces exactly mailbox read 3/detail read 2; failure flag must be consumed, same reader node and old title retained without loading. Second focus produces mailbox read 4/detail read 3 and updated title on the same node.
- Request interception asserts accountId for every captured reader detail request. Exact selected detail counts distinguish foreground Retry from intentionally scheduled prefetch. Next-thread target is asserted as one exact account-qualified path (stronger than the former existential assertion).
- Prefetch helper captures real timer handles, intercepts cancellation, clears queued handles on restore, and restores both global timer functions in finally. All scenarios explicitly exercise a scheduled prefetch; this is not wholesale prefetch suppression. The scheduler assumes the current production 100 ms constant; a delay change requires updating this fixture.
- Completed/in-flight cases explicitly run background prefetch while the error is displayed, preserve the retry button, then require one fresh foreground request. In-flight case resolves a stale-subject payload after foreground success and checks that the visible fresh title and request count remain unchanged.
- No assertion weakening found. Silent refresh old lower-bound inbox count is replaced by exact per-phase counts; next-thread existential request test is replaced by an exact path array.

## Limits / nonblocking observation

The stale-payload assertion covers the currently visible reader, not reopening the original thread to independently inspect its cached value. The unchanged cache implementation has a generation guard against stale writes; existing cache unit tests should remain part of full-suite validation. No claim of full account-isolation coverage follows from a single-account fixture with explicit account query assertions. This review did not rerun the full suite/typechecks or hosted CI; those belong to the parent final-head validation. Unresolved mobile anchor observation is outside this change.

## Independent mutation control

Archived immutable head to `/tmp/reader-review-mutation` and removed only the explicit Retry `threadDetailCacheRef.current?.invalidate(...)` call in that disposable App.tsx copy. Original repository source remained untouched. Ran the three Retry cases with the same dependencies.

Result: held-prefetch case passed; completed-prefetch failed exact request count (expected 3, received 2 at test line 3501); in-flight-prefetch failed reader-ready settling (line 3500) because Retry reused the unresolved background request. Overall 1 pass, 2 fail, 40 assertions. Log: `/tmp/reader-independent-mutation.log`. This demonstrates that the new background-prefetch cases detect a meaningful missing-invalidation regression that the held-only case does not.
