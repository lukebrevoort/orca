# October 16 reader test isolation repair

Baseline/current main: `2d104ea394cc319c085d8983d2c17a923c2be467`. Comparative pre-catch-up main: `9844aca646feabbc843980ecdba1bf5e5fe34b14`. Only `apps/web/src/App.interaction.test.tsx` changes executable code; production code, dependencies and workflows are untouched. Reserved PRs #235, #248 and #251 are untouched.

## Cause and change

The silent-refresh fixture counted every `/v1/inbox` request. First-view guidance (`limit=1`) consumed request 1; initial mailbox loading (`limit=100`) was deferred as if it were a refresh; destination loading (`destinationId=inbox`) received changed mail before startup finished. Both immutable commits reproduced the failure: 3 detail requests versus 2. The repaired fixture distinguishes these query contracts, serves consistent canonical state across them, completes initial mailbox/provider loading before opening the reader, and only then arms one failed silent refresh. It asserts exact initial/failure/recovery counts (1/2/3), exact primary mailbox counts (2/3/4), account targets, unchanged reader identity/title during failure and successful same-version focus retry.

The explicit-Retry fixture assumed no background request while the user viewed the error. Existing recent-thread prefetch runs after 100 ms; a controlled 150 ms dwell made both commits fail 4 requests versus 2. The repaired tests explicitly control that scheduler while keeping its real callback/cache behavior. They cover held, completed and in-flight prefetch, demand exactly one new request for Retry (totals 2/3/3), preserve account targeting and next-thread navigation, and reject a late stale prefetch response after recovery. Running the callback after foreground recovery also asserts that a hot cache causes no redundant selected-thread fetch.

The scheduler helper intercepts only 100 ms timeouts and uses real handles so application effect cleanup cancels obsolete callbacks. Other timers run normally. Each test requires an actual queued callback, explicitly runs it, then restores timer functions and cancels outstanding owned handles in `finally`. This intentional coupling to the prefetch delay is local to these tests; a future scheduler change should update this harness, not loosen counts. No production delay or tolerance was changed.

## Red/green evidence

- Original current and baseline test workload: `red-original-{current,baseline}.log`. Silent-refresh fails; Retry is timing-sensitive and passed this final no-dwell comparison. Earlier current runs failed Retry too.
- Controlled workload: `red-controlled-workload.patch` applied identically to both archives; it includes a diagnostic inbox-query filter and a 150 ms dwell after the Retry error. Neither assertion was relaxed. Both fail, 4 versus 2 for each case: `red-controlled-{current,baseline}.log`. Query filtering alone did not repair startup/prefetch isolation.
- Candidate implementation: `4ff6db53215a4e1b629e39ad86042784773c1f45`; preceding implementation commit `17693666a25b3ed281e6f2c68d13be0008e785d4` passed focused behavior but had a mixed happy-dom/browser DOM typing error. That error and its correction are retained in `initial-typecheck-failure.log` and `typecheck.log`.
- Four focused cases / 86 assertions passed (`green-focused.log`). In an archive of candidate `4ff6db5`, adding the same 150 ms dwell after `Try again` (no other source changes) also passed all four / 86 assertions: `green-controlled-dwell.log`. This diagnostic dwell is not committed to the tests.
- Bun 1.3.14; React/react-dom 19.2.7 and happy-dom 20.11.2 match unchanged bun.lock. Archived comparisons reused the installed dependency tree, not a fresh hermetic install.

Reproduce candidate coverage: `bun test apps/web/src/App.interaction.test.tsx --test-name-pattern 'retries a failed silent|fetches fresh detail after'`. Full-suite, independent-review and hosted status are recorded below and in the PR.

## Unresolved mobile observation and limits

The original sweep's Chromium 154 catch-up matrix observed one 44 px mobile single-message return-anchor shift. The isolated scenario, full 12-case rerun, and one bounded compose-then-mobile-single follow-up passed. Prior compose activity alone was not a sufficient reproduced trigger. This test repair does not change or claim to fix that observation. Next investigation would instrument sticky-header geometry and capture/restore frame ordering in the complete failing sequence; no unbounded retry sweep was run.

No UI implementation change or new screenshot claim. Existing sweep browser coverage was synthetic: 16 compose scenarios / eight stubbed deliveries and a successful 12-case catch-up rerun with original failure preserved. No live mail, production migration, sign-in, credential/security change, paid infrastructure, native local build, merge, release or deployment. Existing automatic CI is used without redundant dispatch. A limited test-isolation repair is not an app-wide bug-free claim.

## Independent review

Separate agent `/root/reader_test_review` reviewed executable head `4ff6db53215a4e1b629e39ad86042784773c1f45`, found no blocking issues and independently passed 4 tests / 86 assertions. In a disposable archive it removed only Retry's cache invalidation: completed-prefetch failed (3 expected / 2 actual), and in-flight-prefetch failed to become ready. The held-only case passed. See independent-review.md and independent-mutation.log. This is a negative control proving meaningful new coverage, not a production change. Stale-response coverage asserts the visible reader; cache reopening is not newly covered.

## Final local validation

On executable head `4ff6db53215a4e1b629e39ad86042784773c1f45`: all **1,483 tests passed** (95 shared, 744 API, 644 web), zero failed; all workspace typechecks passed. Full output: workspace-tests.log and typecheck.log. The original unrelated bulk-Undo assertion also passed this full run; its earlier intermittent failure is not claimed fixed. Evidence-only commits after this head do not change executable files. Final published-head automatic CI is recorded in the PR body to avoid another evidence-only push/restart.
