# Expanded functional sweep, October 17 America/New_York

Immutable baseline: 5baf7f3ea9e208001c607a7bc0f5c418fb056d58, reverified remotely before expansion; clean checkout. Open drafts remain #235 (performance), #252 (reader Retry fixtures), #253 (native diagnostics), #254 (image loading). User explicitly authorized expansion today; the previous 58 passing checks are reused, not rerun as the sweep.

| Area | Evidence | Remaining gaps |
| --- | --- | --- |
| Inbox/account isolation | Prior 58 passes and independent review, the earlier cloud evidence record at /workspace/scratch/bug-sweep-2026-10-17/README.md | No live mail, full native or malformed thread-reference claim |
| Draft persistence and delivery | Existing autosave interruption, conflict, delivery integration, transitions, writing preferences, API mirror/list/mobile/provider-draft tests in expanded-tests.log | Delayed send across scope transitions uncovered; deterministic new regression fails |
| Search/pagination | global-search.test.tsx and organization/views/search-equivalence.test.ts; prior API filtered pagination cases reused | PR235 explicit search semantics/performance remain separate; no new indexed-search claims |
| Inbox navigation | navigation, reader-navigation and surface-history suites | Visual geometry/accessibility/native behavior owned by separate UI lane |
| Recent changes | Main includes #248 cloud workflow and #251 Gmail date recovery; 16 targeted date recovery/persistence tests pass | Runtime date recovery must use fake provider/fixture storage only |

Expanded existing run: 95 tests / 14 files passed, 616 Bun assertions, zero failures. Happy DOM validates functional contracts, not visual layouts. New disposable delayed-send probe independently reproduced active draft reset after account change (one failure), retained in compose-late-send.log.

Ownership announced before production edits: apps/web/src/compose-workspace.tsx and new apps/web/src/compose-send-lifecycle.test.tsx; isolated worktree /workspace/orca-bug-20261017, branch fix/compose-send-scope-20261017. No native dispatch; use existing automatic PR CI if publication is justified. Visual/native lane owner 01a149fc-c8d7-71fd-ac2d-7e7c5da6b0d1. No changes to its UI layouts or existing PR252/253/254 branches.
