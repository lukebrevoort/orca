# Retry integration gate: reuse PR252's fixture correction

After PR260 merged as `357ee56de74e3f080c2dcb6e3ccfadfed1a199e0`, the approved PR261 head `54021edc5b49909e80f9376709eeca9369b3b3e3` was combined locally as `7b084a8232c5db29e18bd33739e8e0c2c5827f89`. Full integration tests failed the reader Retry count (expected 2, observed 3); merge was stopped. The user then authorized diagnosis and a supported narrow correction before continuing the merge workflow.

## Cause and existing ownership

Draft PR252 already repairs this fixture. Its independently reviewed executable `4ff6db53215a4e1b629e39ad86042784773c1f45`, published as `43b76349eb829b2e37abda008ec58a25ef63512e`, covers held/completed/in-flight prefetch. This patch reuses those helpers and three Retry cases verbatim, with attribution; PR252's separate silent-refresh repair is excluded. PR252 is not merged or closed here and its owner should reconcile the remaining scope separately.

Controlled trace workload (`trace.py`) adds a 150 ms error-screen dwell and synthetic request stack logging in a disposable checkout. On each exact source revision—combined `7b084a8`, updated main `357ee56`, approved head `54021ed`—the original assertion fails 4 versus 2. Logs show foreground failure through App.tsx:2060, background requests through App.tsx:2009/cache prefetch, then the foreground Retry. The substring filter also includes the `-next` thread in the selected thread count. Both revisions without the combined changes exhibit the same fixture problem; no product regression is established.

The reused cases control only 100 ms timer callbacks with real cancellable handles, explicitly exercise queued prefetch, and restore timers in finally. They assert exact selected-thread/account requests, exactly one new Retry request, totals 2/3/3 for held/completed/in-flight prefetch, rejection of a stale in-flight response, and exactly one next-thread request. Product code, UI behavior, timeouts and workflows are unchanged. The helper intentionally depends on the current prefetch scheduler; it must be updated if that scheduler changes.

## Immutable verification

- Fixture-only commit: `e522a41537318c3702ad9f2fd1ee5eb43fd6dafb`.
- Tested integrated executable: `b12abcae18d6a0b0cb4f6e7c85eb0f77583378e5`, merging updated main into the PR branch without conflicts.
- Focused: 3 passed, 57 assertions. Same 150 ms dwell on corrected cases: 3 passed, 57 assertions.
- Negative control removes only product Retry cache invalidation in a disposable copy: held passes; completed and in-flight fail. Mutation is restored and is not committed. This demonstrates the strengthened coverage still detects missing fresh requests.
- Full integrated suite: 1,551 passed, zero failed (95 shared, 779 API, 677 web). Production build including workspace compiler checks passed. All 13 exporter tests passed.
- Production search browser matrix: all 12 cases passed, zero failures/page errors, light/dark at 320/390/760/1024/1440 px plus long labels. Exact source commit is recorded in browser/results.json. This is synthetic browser coverage, not native verification.
- The first browser launch did not execute because cleared PATH omitted Node. Its fixture exited and removed its database. The actual run used the installed absolute Node executable; browser exited 0, owned fixture exited 0 and its database was removed. No failed browser test was retried.
- Independent reviewer `/root/evidence_review` found no blockers in the fixture reuse and integrated source; no model-diversity claim.

Bun 1.3.14, installed frozen dependencies, cleared environment, no live mail/provider traffic. Commands: `bun --no-env-file run test`, `bun --no-env-file run build`, `python3 scripts/ci/test-export-evidence.py`. Focused filter: `fetches fresh detail after explicit Retry`. Browser uses the existing compose-fixture and search-ui-fixture-e2e.mjs harness with owned temporary data and Chromium.

Raw source-comparison traces, passing/failing logs, browser screenshots/results and integrity manifest are retained here. Later evidence-only commits do not alter executable sources. Hosted checks on the final published head must pass before merging; their results are recorded in the PR body to avoid evidence-only reruns. No PR252/262 merge, release, migrations or infrastructure change is part of this correction.
