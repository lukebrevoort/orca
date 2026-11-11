# Code Review: BRE-457 native reader hit targets

## Summary

The exact source delta is appropriately narrow and consistent with the retained first-broken-step evidence. No blocking correctness or security finding was identified. Source approval does not establish that the new native switch actuates, exposes one accessibility element, or supplies a measured44pt hit area; those remain hosted UI gates.

- Independent reviewer: `/root/review_native_reader_hit_targets_feee`, same-provider reviewer agent using inherited GPT-6.1-sol settings; no different-model claim.
- Base: `fb10f5c89f4c5147de3a7e7b9a375c4ad1f9951f`.
- Candidate: `feee9ee7672962a3682e541f62940b5f1ba7a0da`.
- Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`, clean at start and final observation, HEAD exactly candidate.
- Method: read-only full changed source/evidence documents, relevant reader/view/test callers, ordered retained diagnostics, source hashes and before-fix screenshots. No compiler, grammar/test runner, browser/server, simulator, CI poll, dependency operation, source edit, child or external posting.

## Intent

1. Require an actual fully visible history disclosure before the original single tap, using the existing six-swipe reveal budget; preserve the original immediate5s jump predicate and all later assertions.
2. Separate the visible wide-content label from the native switch's activation target while retaining its existing state/binding, explicit accessibility label and ordinary Dynamic Type wrapping.

## Findings

### Consider — stop test interaction after the new precondition has already failed

**Location:** `apps/ios/OrcaUITests/OrcaUITests.swift:1994–1995`.

`XCTAssertTrue(historyReachableBeforeTap, ...)` records failure but does not return. If the disclosure remains covered or absent after the unchanged six attempts, the code still taps it and proceeds into unrelated jump checks. This cannot turn the run green—the precondition failure is retained—so it is not a correctness blocker. A return/guard immediately after the assertion would preserve the failed test while avoiding an occluded tap and secondary failures. Keep teardown and the original successful-path single tap/5s wait unchanged.

### Noted — stricter history stimulus is supported without changing the product jump policy

**Location:** `OrcaUITests.swift:1969–2006`.

The viewport intersects reader/app bounds and excludes native navigation and Reply. Full width/height44 and rectangle containment reject the actual retained Show21 frame y56..100 beneath navigation y62..116. The source still uses at most six `app.swipeDown()` gestures, one original tap, then starts the original5s predicate before post-tap diagnostics. Product history insertion, chronology, scroll anchor and message-visibility formulas are unchanged. The broad `.any["thread.reader"]` selector is the existing diagnostic selector and resolves to the retained ScrollView; no demonstrated ambiguity was found. A typed ScrollView query could improve clarity but is not a required fix.

This is a stricter user-stimulus precondition, not proof that a product anchoring defect has been repaired. If the new precondition fails, that failure must remain a failure; do not skip or force the gesture.

### Noted — native control structure keeps the relevant semantics

**Location:** `apps/ios/Orca/Mail/ThreadView.swift:403–418`.

The wrapping subheadline text is hidden separately from accessibility, and the labels-hidden native `.switch` retains the full explicit accessibility label and the same `$wideContent` binding. Its own fixed-size/minimum frame is localized rather than allowing the visual label to define a full-row Switch target. There is no extra row gesture, second state source, view identity reset, private UIKit/KVC, or changed HTML/render input. The unchanged `ReaderUITests.swift` still queries the same label, performs the same first tap, captures its first value immediately, expects1, and exercises all later off/on, collapse/reopen, plain Find and formatting preservation steps.

Actual UIKit/AX hit testing and44pt interactive reach are not statically guaranteed by `.frame`/`.contentShape`; the evidence README explicitly acknowledges that limitation. Keep hosted standard/AX and both-theme verification before declaring the defect fixed.

### Noted — provenance and claims are honest

`docs/verification/bre-457/reader-hit-targets-fb10/README.md:3–35` preserves actual Light186pass/2fail/5image-scope skips, Dark not run, and the event SHA as distinct from tested head. It does not promote grammar to SwiftUI/runtime proof. I verified all13 declared source/evidence hashes. ReaderUITests, SafeHTMLView, Core, API/shared, Tools and the runner have no delta in this comparison. I actually inspected the unique Tools-off63 and history99 screenshots;76 is hash-identical to63. I did not claim unique attachment/test ordinal mapping or inspect all exported images. Ordered diagnostics preserve the first immediate wide0 and the original history wait timing.

## Security assessment

No new authorization, account/session identity, input, network, filesystem, provider, HTML sanitization or privacy-consent boundary is introduced. SafeHTMLView and its rendering/sanitization inputs, account/routing/importance flows, fixture data and credentials remain unchanged. The newly retained material is synthetic before-fix evidence with explicit attribution limits. No introduced security blocker identified within this immutable delta.

## Verdict

**APPROVED WITH COMMENTS — source scope only.** No Act-on blocker. The optional failed-precondition early return is a clarity improvement, not a waiver of the existing failure. The requested minimal grammar check is an appropriate next syntax gate; hosted typecheck/XCTest, actual switch/frame behavior, all unchanged reading assertions and inspected standard/AX light/dark screenshots remain unproven. This review does not authorize merge, publication, release, or acceptance of the complete application.
