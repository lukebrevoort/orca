# Search account choices and mobile layout

Selecting one search account previously removed other connected accounts from the filter. On narrow screens, scoped Search also expanded its inner grid beyond the viewport and clipped controls. This fix keeps the authenticated account choices separate from scoped result metadata and explicitly sizes the single Search grid column to `minmax(0,1fr)`.

Parent obtained PR235 owner's clearance for this standalone UI fix; PR235 will reconcile its UI files later. Backend query construction, metadata search mode/coverage, indexing, migrations, performance rollout, native code, reader fixtures and CI diagnostics are unchanged.

## Exact revisions and verification

- Baseline product: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe` (main including PR259).
- Final executable: `91c51488d3a029a93981c897a03a92f0d4b633bf`.
- Independent reviewer: `/root/evidence_review`, separate agent, model identity not exposed. No blocking implementation finding; final evidence and screenshots reviewed. Review is not merge approval.
- Final-head focused account/search tests: **30 passed, 0 failed, 233 assertions**. Workspace typecheck and production build passed. Build runs workspace compiler checks; no lint-rule changes.
- New account regression alone on baseline: **8 failed, 1 passed**. Final focused run includes all nine new cases plus the existing 21 search tests. Tests cover full-list/result response order, direct account switching and exact scoped requests/results, independent metadata failures, invalid metadata, authoritative empty account lists, latest-only fallback, reopening, aborted old metadata, and stale scoped responses.
- Browser red: all **12 cases completed**, **76 recorded assertion failures**, expected exit 1. Candidate: all **12 passed**, zero failures and zero page errors, exit 0.
- Browser dimensions: light/dark at 320, 390, 760, 1024, 1440 × 1000 CSS px, plus 320 px light/dark with a long synthetic account address. Uses the existing authenticated synthetic loopback fixture, real API results, and post-response account-name substitution only in the two long-label cases. No real mail, native iOS or remote provider execution.
- Browser assertions cover direct first→second switching, unchanged account-scoped request URL/results, region and control bounds while the overlay is open, Tab traversal of all visible enabled controls, focused-control visibility, and disabled Save as View for empty search. Captures selected/default, hover, keyboard focus and disabled states. Browser source SHA is operator-supplied; exact clean checkout build logs and asset hashes substantiate it here. Browser version/harness hash are in each results file. External requests, including Google Fonts, were blocked; screenshots use fallback fonts.

### Full-suite limitation

The local full-suite run reports **1,548 passed, one failed**: `App.interaction.test.tsx:3448`, “fetches fresh detail after explicit Retry and after selecting another thread,” expected 2 reads but observed 3. This matches the known Retry/prefetch request-count failure signature addressed by open PR252, but this task did not independently re-diagnose or fix it. No reader test was changed, relaxed or retried.

That run began at `a117edee9d701db060147f8da80e07ce67b2a0e3`; a test-only selector refinement was committed while it ran. Therefore it is **not claimed as immutable final-head full-suite verification**. The refinement changes selector typing, not product behavior. Final-head focused tests, build, typecheck and browser checks above are separate. Automatic draft-PR checks will provide final published-head full-suite results; no speculative rerun or duplicate dispatch is planned.

## Mechanism and behavior

`connectedAccounts` is the full authenticated account-list result; `null` means unavailable, while a successful empty array remains authoritative. `resultAccounts` holds only the latest non-stale search result's fallback metadata. Scoped results cannot overwrite a loaded full list. Full account and collection metadata load independently; each retains its abort guard. Opening/closing refreshes their lifecycle, and each new query clears the scoped fallback. No union of historical accounts is accumulated. Existing selected/missing-account and collection-selection behavior is retained.

The horizontal overflow came from the single implicit `auto` column of `.global-mail-search`. After selecting an account, intrinsic minimum sizing expanded that shared track beyond the fixed mobile dialog. `layout-diagnosis.json` records 320/390/760/1024/1440 px observations before an isolated temporary grid-column override, after that one override, and after adding a redundant form-label min-width override. The single column declaration alone contained all measured regions and controls; the extra form rule added no benefit and was not committed. Existing overflow clipping was not increased to conceal content.

## Reproduce

From a clean checkout of the exact product commit, follow `docs/pstack/cloud.md` for Bun 1.3.14, frozen dependencies and provisioned Chromium. Build with `bun --no-env-file run build`, retain the log, commit and asset hashes, and launch `apps/api/scripts/compose-fixture.ts` with an empty environment, explicit Bun PATH and an owned temporary directory. Use only its new synthetic connection file.

```sh
ORCA_CHROMIUM_EXECUTABLE=/usr/bin/chromium node apps/web/scripts/search-ui-fixture-e2e.mjs CONNECTION.json NEW_OUTPUT 91c51488d3a029a93981c897a03a92f0d4b633bf
bun test apps/web/src/global-search-accounts.test.tsx apps/web/src/global-search.test.tsx
```

For red reproduction, copy the unchanged regression test and browser harness into a clean baseline checkout as untracked files, build baseline and use baseline SHA plus the final `baseline` argument. That mode records failures and uses the existing Every connected account workaround solely to finish layout coverage; it still exits1 if any assertion failed. Output directories must be new. Browser harnesses own and close their browser processes; stop only your fixture process afterward, which removes its temporary database. Do not save connection tokens or databases in evidence.

The dedicated browser harness is not added to CI in this patch. The existing automatic workflows exercise their usual browser/API/native coverage; geometry evidence here is from the recorded local matrix. No performance claim or native verification follows from this matrix.

## Screenshots

| State | Before | After |
| --- | --- | --- |
| 320 px light, selected account | [Before](before/320-light-filtered.png) | [After](after/320-light-filtered.png) |
| 390 px dark, keyboard Search | [Before](before/390-dark-keyboard-search.png) | [After](after/390-dark-keyboard-search.png) |
| 760 px light, empty/disabled | [Before](before/760-light-empty-disabled.png) | [After](after/760-light-empty-disabled.png) |
| 1440 px dark, selected account | [Before](before/1440-dark-filtered.png) | [After](after/1440-dark-filtered.png) |
| 320 px long account | [Before](before/320-light-long-filtered.png) | [After](after/320-light-long-filtered.png) |

![Before: mobile clipped Search controls](before/390-dark-keyboard-search.png)
![After: reachable Search with visible focus](after/390-dark-keyboard-search.png)

All raw browser results/screenshots, failure evidence, logs and asset hashes are retained beside this report. `manifest.json` identifies hashes of the retained evidence. Narrow Save as View wrapping remains readable; the unrelated compose Retry-label observation from the original sweep is outside this fix.

Status: local matching-surface verification and independent review complete; automatic draft-PR checks pending. No merge, deployment, migration or new infrastructure authorized.
