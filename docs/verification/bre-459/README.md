# BRE-459 — native Feedback/action overlap

Status: **blocked on hosted baseline execution; test-only checkpoint**. No product layout change is included. The parent owns independent review and the merge gate. BRE-457's wider native redesign, API/shared and web work remain separate.

## Baseline and provenance

- Prepared and fetched parent/base: `0182327c5fa36b8d686ed72130d8133ee9b3a1a2`, `origin/integrate/BRE-453-foundation-core` (PR309). Fetch/fast-forward integration found no drift before checkpoint checks.
- Original visual baseline head: `a540490efe818ea8f22802548c840b1e3df0c279`.
- Actual hosted tested merge: `b69a87ce5bcecb74194f4e1bf6ff20b6e0fedd91`; identical tree `ebfbe6ffa929bc170dd59c22cd02fca9738685b8`.
- [Hosted fixture job 130343800003](https://github.com/lukebrevoort/orca/actions/runs/42966020434/job/130343800003), artifact `ios-simulator-42966020434-1`, `screenshots/OrcaDark-20.png`.
- iPhone17, iOS26.4.1, Xcode26.4.1, hosted macOS26 ARM64. Synthetic `test18ConflictCopyKeepsLatestWritingAndRemovedAttachmentAfterTermination`, keyboard up, status “Both drafts kept. This version will send as a new draft.”
- [Retained original PNG](baseline-OrcaDark-20.png), 1206×2622, SHA-256 `2b6482fa40e8acb6e5c524d21542ec85abaff158d7dbc15fd33f70c36cadda17`. Copied byte-for-byte from `/tmp/bre447-hosted-ios-a540490e/screenshots/OrcaDark-20.png` and actually inspected during this task.

The visual baseline shows **one visibly obscured primary action**. It establishes visual occlusion, not independently measured point geometry, tap interception, or a previously executed automated failure. The existing hosted suite passed despite these pixels. `OrcaApp.swift`, `ComposeView.swift`, and `ThreadView.swift` are unchanged between that visual head and the prepared parent. Product code remains unchanged in this checkpoint.

## Regression and execution

`OrcaUITests.swift` now measures actual accessibility frames and intersection areas, checks nonempty/on-screen geometry and hit targets, and captures PNGs before asserting zero overlapping protected controls. Numeric `[bre-459]` log records identify checkpoint, control count, overlap count, keyboard presence, frames and square-point intersection areas; no writing, recipients, subjects or credentials are added to diagnostics.

1. Existing test18: keyboard-visible recovered conflict copy; protected Send and recovery status (**2** regions). Requires the keyboard to remain visible at the original reproduction point. If geometry passes, open and close Feedback through its real target, verify unchanged writing, terminate/reopen, check Send/status again (**2** regions), then retain the existing remote-writing/attachment and exactly-one synthetic-delivery assertions.
2. Existing test07: real reader Reply, Reply all and Forward (**3** targets). Its later action/menu/reply navigation assertions remain intact. This covers the analogous reader footer placement through the same shared shell; contextual reader jumps and larger text still need candidate coverage.

The compose scope moves test18 to an early light/dark gate, running it **once per theme**, even if one fails. Both result bundles are exported through the existing sanitizer. On a failing baseline it exits nonzero before unrelated media/compose tests. On a passing candidate all remaining existing gates still run, with test18 removed only from the later arrays to avoid duplication. No timeout, ownership guard, provider contract, screenshot consent or test expectation is weakened.

Use the existing PR-triggered `Fixture Checks / Unsigned iOS unit and compose UI` job. It runs `bash scripts/ci/fixture-check.sh ios` with the default compose scope on a fresh owned hosted simulator. Reader path triggers separately exercise test07 in light/dark. **Do not dispatch redundant workflows or run this on Luke's Mac.**

Expected baseline outputs:

- `FeedbackLayoutlight-summary.json`, `FeedbackLayoutdark-summary.json` and corresponding `*-tests.json`.
- `screenshots/FeedbackLayoutlight-*.png`, `screenshots/FeedbackLayoutdark-*.png`, including the `bre-459-conflict-copy-keyboard` XCTest attachment (exported filenames are numeric).
- Sanitized `checks.log` containing `[bre-459]` measurements and `identity.log` distinguishing PR head from the actual tested merge SHA. Inspect actual assertion identity before calling a job failure reproduction evidence.

**At this checkpoint:** new native cases executed: **0**; new measured overlap counts: **not available**; synthetic deliveries in the new run: **not available**. A test failure caused by setup/build/media readiness is not the expected geometry regression. No candidate screenshots, zero-overlap result, speedup, native acceptance or completed fix is claimed.

Local static checks: `zsh -n apps/ios/OrcaUITests/run-fixture-tests.sh` and `git diff --check` passed. Full lint/typecheck/test/build were attempted through `python3 /tmp/orca-ui-heavy-slot.py` with existing Node24.22.2/Bun1.3.14 and matching-lockfile reused dependencies. The guard returned **75**, “command was NOT started,” because another worker owns the slot. All four checks are **blocked/not run**, with no retry or bypass. Prelaunch memory free was79%; no simulator/Xcodebuild, dependency installation or browser execution ran locally. Hosted native compilation/assertions remain pending.

## Resume after the hosted baseline

Retain the failing geometry, actual counts, PNGs and exact head/tested-merge SHAs before changing product layout. The source hypothesis is that each tab applies Feedback outside its NavigationStack, while composer and reader own independent bottom safe-area insets. Coordinate the shared reserved geometry so both footer owners receive it; do not hide Feedback, cover other controls with a relocated overlay or disable Send. Keep media consent and capture owner/generation guards unchanged.

Candidate acceptance remains: keyboard up/down; short heights; light/dark; standard/accessibility text; attachments, conflict/recovery, uncertain delivery and retry; reader scrolling/actions/jumps; focus after top-layer dismissal; repeated/interrupted scene/account changes. Preserve local writing/recipients/attachment ownership, original remote conflict version, and exactly-once synthetic delivery. Retain before/after screenshots and inspect them; record actual cases, assertions, protected controls, measured intersections and deliveries rather than planned counts. Run full relevant checks at the committed candidate and actual hosted native fixtures separately from source review. Independent correctness/security reviews remain with the parent.

Scope is synthetic loopback fixtures and hosted unsigned simulators only. No live mail, credential changes, signing, TestFlight, deployment or release. Rollback this checkpoint by reverting its single test/documentation commit; there is no product behavior or data migration to roll back.
