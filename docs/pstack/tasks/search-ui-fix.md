# Search account choices and mobile width

- Intent: preserve connected-account filter choices and keep Search controls inside the viewport. Selected playbook: bug-fix, followed by interrogate and exact-commit verification.
- Status: **running**.
- Base: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`; branch `fix/search-account-options-mobile-width`; worktree `/workspace/orca-search-ui-fix`.
- Ownership: parent obtained PR235 owner's clearance for this standalone UI fix; that owner will reconcile its branch later. PR235 backend/mode/coverage/index/performance changes, PR252 reader fixtures, PR253 diagnostics and native files remain excluded.
- Owned product files: `apps/web/src/global-search.tsx`, `apps/web/src/desktop-switch.css`; focused account unit tests, `apps/web/scripts/search-ui-fixture-e2e.mjs`, evidence and this record.
- Acceptance: both accounts stay selectable after scoped results regardless of response order; account/collection metadata failures are independent; current scoped-result fallback never accumulates stale accounts; reopening and aborted responses remain safe; backend query and result scope unchanged. Search controls reachable with keyboard and contained in light/dark at 320/390/760/1024/1440 px, plus long account labels.
- Before: 8 of 9 new account tests fail on baseline; synthetic browser red matrix in progress. CSS diagnosis measures the same regions before/after temporary one-rule override; no production clipping workaround.
- Implementation: separate authenticated account list from latest scoped-result metadata; independently fetch optional collection/account lists; reset lists on reopening and retain abort/generation guards; explicitly size Search's single grid column with minmax(0,1fr).
- Review: independent reviewer `/root/evidence_review`; final immutable diff review pending.
- Next: exact executable commit, full checks/build, green synthetic browser matrix, independent review, evidence, draft PR and automatic checks. No merge or deployment.
