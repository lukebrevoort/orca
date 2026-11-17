# Independent source review — native reader bridge64b

**Verdict: APPROVED WITH COMMENTS for the scoped source candidate; no blocking correctness or security finding.** This is not a verified interaction fix, UIKit/typecheck result, publication clearance, or whole-app/merge approval. Hosted acceptance remains required.

## Intent, identity and inspected scope

- Reviewer: `/root/review_native_reader_bridge_64b`, independent Codex reviewer, inherited `gpt-6.1-sol`/high; no additional reviewers or children.
- Immutable base: `72448b3fd5c5dbe2d2b9046f30e9185a2bffd44e`.
- Immutable candidate: `64b3308a2fb79a149f08f23a06f7578e85a35b3a`.
- Intent: correct only test04's lazy-list reachability precondition and the Wide switch's UIKit/SwiftUI interaction boundary, while preserving the same reader state and original user-action assertions.
- Read the applicable instructions and interrogate skill, the complete Git diff, relevant reader/helper/caller/test context, candidate identity/design/evidence docs and primary-API contract notes. Independently verified all44 committed planned-input hashes, three changed source paths, clean current candidate, ReaderUITests byte identity, and test04 method identity after removing only its new opt-in argument. Core and ReviewRegressions paths have no diff fromf0e.
- No checkout edits, staging, commits, tests, compiler/parse, build, browser, simulator, CI, publication or external messages. Only this external report was written.

The actual prior hosted724 Light result remains193PASS/2FAIL/5isolated-image skips; all188 native units and test37 passed, Dark did not run. The added three UIKit unit cases and candidate gesture/layout behavior are unexecuted in this review. No423 or44-file grammar result is inferred from static hash verification.

## Findings and disposition

### Act on

None. No concrete source blocker was established in this narrow patch.

### Consider — C1: native sizing and event behavior remain a hosted acceptance gate

Locations: `apps/ios/Orca/Mail/ThreadView.swift:392`, `:427`; unchanged decisive assertions in `apps/ios/OrcaUITests/ReaderUITests.swift:169–190`.

The public intrinsic-size override requests at least64x44 and the representable returns it through SwiftUI's supported sizing hook. It does not assign the managed view's frame, bounds, center or transform. This is a reasonable narrow candidate, but intrinsic size alone cannot establish the actual UIKit allocation, accessibility frame, hit testing, single exposed Switch or immediate post-tap value. The source documentation correctly discloses this limit.

Before accepting the fix, execute the unchanged original single `wide.tap()`, immediate expected1 and all later collapse/reopen/off/on/plain/Find preservation checks in standard and accessibility text in both themes. Inspect the actual target/child geometry and before/after screenshots. A pass of the new programmatic `sendActions` cases alone would prove target-action wiring, not the physical XCTest tap that previously failed. No extra tap, child-coordinate action, fabricated AX value/frame or relaxed wait/assertion is justified.

Disposition: nonblocking source comment, blocking completion/interaction-acceptance gate. No source change requested merely to replace missing runtime evidence.

### Noted — test04's setup correction is narrow and fails honestly

Locations: `apps/ios/OrcaUITests/OrcaUITests.swift:1987`, `:2615–2654`.

Only test04 opts into the reveal. The helper checks Mail selection, Inbox/list ownership, a unique actual Button and complete >=44pt target containment. The0...6 loop permits at most six existing content drags, then fails; it does not add another existence wait or corrective post-tap action. Other callers retain the default path. The original10s existence wait, single row tap,10s navigation wait and all canvas assertions remain.

The prior API response containing row3 plus a same-run bounded-reveal positive supports treating the missing initial AX row as a stimulus precondition gap. Counterargument considered: a source/API-positive does not prove the exact failing row's frame. That limitation is retained, and no product renderer fix is claimed. If the new precondition fails, XCTest records a failure; the caller does not manufacture success.

### Noted — native target/action and current-binding ownership are coherent

Locations: `apps/ios/Orca/Mail/ThreadView.swift:385–422`; `apps/ios/OrcaTests/OrcaTests.swift:3817–3876`.

- The native control registers one `.valueChanged` target. That action writes the current coordinator binding once and rejects disabled controls.
- `updateUIView` refreshes the coordinator binding and enabled state before reflecting a different value through `setOn(animated:false)`. This avoids retaining a replaced binding as the action's authority.
- UIKit programmatic reflection does not emit the user action. The tests exercise actual `UISwitch.sendActions(for:.valueChanged)`, not a fabricated coordinator callback; they also check programmatic/repeated zero-write reflection, replacement-binding ownership and disabled-action protection.
- The same existing `@State wideContent` feeds SafeHTMLView. The visible wrapping label stays readable and AX-hidden while the native switch owns its exact label/identifier. No row gesture, custom AX value, asynchronous writer or new state-reset path was added.

Counterarguments considered: these unit tests do not host a SwiftUI view or prove coordinator/view teardown ordering, accessibility uniqueness, gesture delivery or native geometry. They are accurately labeled as UIKit target/action controls. Main-actor annotations match UIKit access and existing test conventions; actual Apple compilation remains a separate gate.

## Security and preservation assessment

No new input, network, credential, filesystem, provider, notification, authorization or persistence surface is introduced. The new value is a reader-local presentation Boolean. The test helper operates only on an already-owned fixture Inbox and existing content geometry. API/shared/Core/Tools/runner/fixture/Compose/notification code is unchanged in the base-to-candidate diff. ReaderUITests is byte-identical, including the captured first value before diagnostics and all downstream expectations.

There is no confirmed new security defect in the inspected patch. The patch does not prove the detailed cause of the original missing native event, setter/reset behavior or AX publication; it replaces that boundary with a reviewable public control contract. Do not describe the hypothesis as a verified root cause.

## Required next proof

1. Exact candidate grammar/typecheck/native build and three actual UIKit unit cases, with failures retained honestly.
2. Same test04 reachability and complete canvas assertions in both themes.
3. Same original Wide single-tap/immediate-value and downstream standard/AX checks in both themes, with actually inspected before/after control states and native target geometry.
4. Current combined native suites and final root acceptance remain separate; earlier image5+5/Foundation423/grammar histories retain their exact revisions.

No merge, release, deployment or broader all33 approval is granted by this source review.
