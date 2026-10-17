# Reader touch targets

- Intent/playbook: bug-fix; enlarge the reproduced compact mobile-web reader controls and give the original-text toggle a theme-safe treatment.
- Status: **running**. Updated 2026-10-17 UTC.
- Base: `5baf7f3ea9e208001c607a7bc0f5c418fb056d58`; branch `fix/reader-touch-targets`; worktree `/workspace/orca-reader-targets`.
- Scope: `apps/web/src/reader-body.tsx` (class only), `reader-body.css`, `mobile-mail.css`; `apps/web/scripts/reader-touch-target-regression.mjs` and integration in `reader-fixture-e2e.mjs`; this task record and `docs/verification/reader-touch-targets/` evidence.
- Acceptance: original-text/safety/placement/reminder controls >=44 CSS px at 320,390,760px in both themes; no horizontal overflow; visible default/hover/focus/selected/disabled labels; original-text toggle and safety/evidence drawer remain operable; 761/1440px desktop styles unchanged; synthetic before/after evidence, independent review and terminal CI.
- Owner: UI/UX cloud lane. One implementation owner plus independent reviewer; no cache/search/compose implementation changes. #252/#253/#254/#235 remain separate and unmerged.
- Privacy: new browser profiles, synthetic loopback fixture, external requests blocked; no live send or provider calls. Browser evidence is not native iOS verification. No Homebase access or new native dispatch.
- Reproduction: initial inspection measured Advanced safety/Why 34px, reminder34×34px, original-text28px high at390px in both themes. New regression compares unchanged-main build against candidate build. Harness-development failures (reminder accessible-name query, modal-hidden background role query) retained separately; no runtime fixes claimed for those test errors.
- Next: collect final same-harness red/green evidence; commit; independent review; draft PR; follow automatic CI.
- Native handoff: retained-message pagination error at `apps/ios/Orca/Mail/InboxView.swift:131` has no explicit retry; `OrcaTests.swift:2436` preserves cursor but does not exercise UI retry. Simulator reproduction still required; functional owner scope. Authenticated GitHub artifact download returns a file reference, but environment transfer receives HTTP403. Ordinary file materialization returns the same download-host route, not local bytes; no bypass or blind dispatch.
- Final commit, review and CI: pending.
