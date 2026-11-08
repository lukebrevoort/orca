# BRE-445: quiet native mailbox selector

- Intent/playbook: feature, smallest design refinement of the upper native iOS mailbox Picker. Original feedback screenshot shows a boxed Inbox selector below Search; there is also a bottom Inbox tab, so the target interpretation remains an inference for review.
- Status: **running**. Updated 2026-11-08 UTC.
- Base: `faf41b80a1ec3149ee34d9782235c889023d59ea`; isolated branch `codex/bre-445-native-mailbox-selector`.
- Scope: remove the selector's custom selected-surface fill/outline, preserve native Picker options, tags, selection, disclosure, semantic ink, Sora, minimum 44pt height and fixed row. Explicit rectangular hit shape defines the intended padded interaction area; the edge-tap UI test must verify it at runtime. No tab bar, mail logic, credentials, permissions, production or held-PR changes.
- Acceptance: light/dark legibility, ≥44pt hit area, native menu cancellation/checkmark semantics, repeated selection, Settings return, saved/empty views, largest accessibility text with a long synthetic destination, fixed controls during refresh and switching while refresh is pending.
- Evidence source: [BRE-445](https://linear.app/brevoort/issue/BRE-445/feedback-inbox-button-ui-feels-out-of-place-can-we-look-for-something). Original private screenshot pixels inspected but not copied into the public repository. Original feedback/attachment preserved and acceptance appended in Linear.
- Independent design review: `review_mailbox_selector_design` inspected the original pixels and exact-base source, recommended retaining native Picker and removing only custom chrome. No formal approval. Exact patch review pending.
- Verification route: existing fixture lifecycle and pinned Xcode 26.4.1/iOS 26.4 hosted runner, with a focused Native Mailbox workflow. Its opt-in long destination is synthetic and never loaded into a real mailbox. Existing suites are retained. The focused suite runs default/open/cancelled/selected/repeated controls, long name at Accessibility XXXL, saved/empty views and refresh interruption in both themes.
- Local checks: Python evidence-export/readiness regressions and diff checks. An initial attempt in the read-only sandbox failed because temporary files could not be created; a reviewed write-enabled command is used for actual execution. Bun/Swift/Xcode are absent locally, so no local TypeScript aggregate or native pass is claimed. Hosted full Typecheck/Unit and Fixture workflows remain required.
- UI evidence, exact final head/tree, hosted results and independent patch/evidence verdict: pending; use the draft PR for later exact-head results.
- Limitations: no physical-device/VoiceOver-audio result, no currently installed build confirmation, and no exact same-size synthetic baseline image yet. The original screenshot is visual context, not a performance or runtime baseline. Smallest-phone width, pointer hover and pressed-state pixels must be described honestly from obtained evidence rather than inferred from semantic tokens.

- Source review disposition: independent review of `46f8ed3` found no source-level draft blocker. Addressed catalog/menu snapshot readiness with bounded dismiss/reopen; the refresh-switch test proves navigation availability and eventual return, not stale-response data isolation (the fixture holds both reads and shares messages). No stronger data-order claim is made. Final revised patch re-review requested.
- Completed local helper checks: exporter 25 tests and iOS-readiness 11 tests passed in the write-enabled execution; `git diff --check` passed. These are fixture lifecycle checks, not product/native verification.

## First native run and supported revision

Published first candidate `fd5a7968db2f680ac8b246d986d56de4315012d1` has the exact reviewed local tree `e35d10bc5eea1dd24774c46465b39a5ca711c42e`. [Draft #304](https://github.com/lukebrevoort/orca/pull/304) remains unmerged.

[Native Mailbox 42496574358](https://github.com/lukebrevoort/orca/actions/runs/42496574358) built on Xcode 26.4.1, iPhone 17 / iOS 26.4.1, then passed 161 tests and failed 3 in light; dark did not run. [Artifact](https://github.com/lukebrevoort/orca/actions/runs/42496574358/artifacts/13623538825) ZIP hash `f28c807ea6debb0ddcd22cfd09fde9e8979d0a4b61fae0c826a2194a6a8813a7` and exact-head identity verified after download.

- The top-edge tap could not open the picker. Its outer padded frame/contentShape was not its actual activation area.
- Screenshot `Orca-20.png` shows a long name fragmented down the screen at Accessibility XXXL; `Orca-3.png` also clips Inbox. Passing numeric accessibility/frame assertions did not prove usable text. Actual pixels were inspected independently.
- Tests 13/42's pending probe returned 409 after XCTest's gesture idle synchronization outlasted the fixture's 20s response gate. These failures are preserved, not waived.

Revised product: native Menu wrapping the same selection-bound Picker, with a two-line/tail-truncated Sora title, single muted SF disclosure, complete accessible value, and 44pt padding/frame/contentShape inside the label. Flexible width leaves the fixed Tune target available. Top and bottom edge taps remain required; long-text screenshots remain a visual gate.

Revised fixture: only the first matching synthetic Inbox response is held. The finite real JSON body/status/security headers are retained; bounded JSON-whitespace heartbeats allow the request to stay incomplete through XCTest synchronization without changing production URLSession timeouts. Explicit release, 120s deadline and cancellation are distinct; expiry errors rather than pretending success. Pending probes remain strict before/after interaction. Helper 11 Node24 contract tests pass. These transport mechanics still require native execution; they are not assumed to solve the test.

Other first-head results: Typecheck/Unit 2177 pass; Native Reader success; Fixture browser/API success. General native Fixture stopped at unchanged Photos import test 38 (zero previews/two importing nodes instead of two previews within 10s), so later compose tests did not run. No flakiness/root-cause claim and no gate changes for that separate failure. All first-head runs finished before the revised publication; no unchanged reruns.
