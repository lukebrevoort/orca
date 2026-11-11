# Native failure-boundary diagnostics review

**Verdict: CHANGES REQUESTED for diagnostic timing fidelity.** No introduced product authorization or sensitive-text logging blocker found. This is a read-only source/evidence review, not a native execution, test pass, cause diagnosis or merge approval.

Reviewer: independent `/root/review_native_failure_diagnostics_d485`, Codex/gpt-6.1-sol. Immutable comparison: `3bb1f6209d40da63c0aad11e19890de8a8ad608a` → `d485fae8138ce0ecdb49f5508c6ab360be7487c2`. Read the complete four-file delta, relevant callers and supplied failure triage. Verified both pinned UI-test SHA256 values and every declared unchanged path in `e061-boundary-diagnostic-source.json`. No source edits, tests, compile, browser, simulator, server, child agents, pushes or external posts performed; only this requested report was written.

## Act on — P2: keep the first original business check ahead of new diagnostics

### Reader history wait starts after new AX observations

`apps/ios/OrcaUITests/OrcaUITests.swift:1969–1973`: the new Show/Hide `.exists` queries occur after the original Show21 tap but before the original five-second unread-jump wait. Those are synchronous UI observations, not free local reads. If the jump appears just beyond the original five-second window, the added query time can permit a pass. Capturing the wait Boolean afterward does not preserve its original starting boundary.

Move both new Show/Hide observations after the original `jumpUnread.waitForExistence(timeout: 5)` result has been captured, and label them post-wait state. Keep the exact original tap, five-second predicate, captured-result assertion and downstream jump/Feedback checks. The pre-tap snapshot is explicitly observation overhead, so do not claim this is a paired timing experiment.

### Compose snapshots precede the checks that originally failed

`apps/ios/OrcaUITests/OrcaUITests.swift:1333–1338`, caller `:778` and corresponding test17: after the original body tap, the helper now performs UI-focus/keyboard queries and then a full `captureComposeBoundary` before returning to the original `body.typeText`. That capture queries thirteen targets repeatedly, takes a structural snapshot and adds a screenshot (`:2301–2325`). A delayed keyboard/focus transition can settle during this work and make typing succeed even though the original immediate typing path failed. The captured public `hasFocus` and keyboard existence are explicitly not the original keyboard-typing business check, and neither currently fixes that check's outcome before the delay.

Similarly, `:848` performs a full post-removal capture before the next original form-existence wait in `revealComposeControl`. The actual baseline removed-button wait already passed; its first broken step was the subsequent form wait. Capturing the earlier removal result does not protect the timing of that later broken predicate.

Keep expensive evidence work outside these tap→type and removal→form-wait boundaries: defer it until the original business observation has completed or use a bounded failure observer. A minimal safe alternative is to retain the pre-tap numeric geometry, remove the full post-tap capture from the helper, and capture after the original business failure/success without adding another tap or focus assignment. For attachment removal, perform/capture the same original form wait before the new full snapshot. Do not replace the existing business checks with `hasFocus`, keyboard existence, new waits, retries or a longer deadline. All screenshot/query work inevitably perturbs scheduling, so preserve first-check ordering and describe the remaining overhead honestly rather than claiming an instrumented green proves a focus fix.

## Noted

- The Tools branch correctly saves the first immediate `wide.value` at `ReaderUITests.swift:175` before its post-tap evidence and asserts against that saved value at `:177`. A later publication cannot convert a captured initial0 into1. The existing subsequent wide, collapse/reopen, formatting and Find assertions remain present.
- Original failed row/form-wait results are captured before failure snapshots and asserted from those stored Booleans. Those specific captured failures cannot be rescued by their subsequent evidence work.
- New structured logs use fixed aliases, booleans, numeric geometry/types and allowlisted switch/Tools values. Traversed output is bounded; arbitrary labels, identifiers, body/address values, URLs and credentials are omitted. HTTP-loopback fixture gating is present. Named screenshots remain synthetic-test evidence; the exporter still lacks original attachment-name mapping and raw xcresult is absent.
- Product/Core/API/shared/OrcaTests/Tools/runner paths are unchanged from the supplied base. Prior223-case source evidence and four-scope runner proof are not new SwiftUI acceptance. Root separately reports a36-file grammar pass; this reviewer did not execute it, and it does not establish hosted XCTest compilation/runtime.
- The pinned document labels compose `Orca-251.png` a blank screen. Root independently identified it as sent-local-edits context and already owns the small doc correction; no uniquely assigned failure screenshot or cause can be inferred from either description.
- No assertion deletion, corrective user gesture, production mutation or introduced account-isolation defect was found in this diagnostic delta. The requested changes concern evidence integrity and first-broken-step comparability, not a demonstrated product regression.

After the narrow timing edits, recheck the exact delta and retain its source/syntax scope. Hosted reader/compose execution and final acceptance remain pending.
