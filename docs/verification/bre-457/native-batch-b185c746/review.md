# Code Review: native Drafts, AX setup, submitted-search action and failure observations

## Summary and verdict

**APPROVED WITH COMMENTS for the exact source comparison. No blocking production correctness or security finding identified.** This is independent read-only source/evidence review, not grammar, compilation, UIKit/XCTest, native hit testing, visual after-proof, merge approval or all33 acceptance.

Reviewed base `e2a4ce5071c66bc2fbb4f38318457f63821c4b98` to candidate `b185c7465648c62704b049f78db419de23a66599`, with docs-only retention parent `0d0999b404d4e1f92fb496f4bb09b948bb785583`, in `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`. Reviewer: `/root/review_native_batch_b185`; no different-model claim is made and no child reviewers were started.

Intent: stop Drafts section introductions overlaying writing; give an actually oversized, uniquely owned native draft row a feasible bounded tap precondition without shrinking text; reveal only the initial Inbox row of the two failing largest-AX launches; expose the same accepted-search Save action outside searchable's hidden toolbar slot; and preserve additional observations only after the original failures in still-unclassified cases.

The product delta is confined to `DraftsView.swift` and `InboxView.swift`; UI-test changes are confined to `OrcaUITests.swift` and its existing `ViewportGeometry.swift`. Core, draft persistence, API/shared/auth/provider code, Tools/runner and the reader bridge are unchanged. Independent static checks verified the source patch is byte-identical to the exact Git diff, all44 planned grammar-input hashes, all33 preserved Foundation/harness hashes,18 protected tree/blob scopes against both commits, and ReaderUITests'724 SHA. The checkout was clean at exact b185 throughout these observations.

## Findings

### CRITICAL / Act on: blockers

None identified in this source comparison.

### WARNING / Consider: the geometry method is not selected by current hosted runner arrays

`apps/ios/OrcaUITests/OrcaUITests.swift:24-40`; `apps/ios/OrcaUITests/run-fixture-tests.sh:141-147`.

The new method authors10 scenarios and14 assertion statements against the same helper used by `revealDraftRow`, but it is outside the explicit `-only-testing` arrays. A future normal hosted compose run will therefore not establish that these pure cases executed. The preparation report explicitly discloses this; there is no false execution claim to correct.

ROOT should allocate a source-matched small geometry gate or explicitly wire/select this method before citing geometry execution. An external Foundation/CoreGraphics harness can check the actual helper and the documented cases without repeating the unchanged423 Foundation/API scope, but it must retain exact helper/case hashes and actual assertion counts. Grammar alone does not satisfy that gate. Adding runner selection is a separate source change and should not be inferred from this review.

Counterargument: the immediate request is source review followed by a separately allocated minimal44-file grammar check. Agreed: unselected new cases are a documented execution obligation, not a source blocker or permission to launch a new check.

### WARNING / Consider: the oversized-row condition establishes a feasible stimulus, not native tap or P04 acceptance

`apps/ios/OrcaUITests/ViewportGeometry.swift:33-58`; `apps/ios/OrcaUITests/OrcaUITests.swift:1545-1589`; `apps/ios/Orca/Compose/DraftsView.swift:17-20,120-134`.

For fitting rows, `draftRowArea` still requires full horizontal and vertical containment. Only a row taller than the viewport can use its visible intersection, and then width/height must both be at least44 and its geometric center must be inside the unobscured viewport. The caller additionally requires one stable UUID-based draft ID, exactly one matching native element, Button/Link type, hittability, the fixture account in its real combined label, and meaningful saved/delivery context. The original caller's native `.tap()` and subsequent rich-conversion/sent-recovery/content assertions remain.

These are appropriately conservative source conditions, but a rectangle centroid is not XCTest's measured hit point. Native AX types/labels, scroll settling, real tap dispatch and destination content still require hosted evidence. A full meaningful AX label does not itself establish all rendered metadata is readable simultaneously. New opaque scrolling header rows remove the prior sticky-header source mechanism, but do not establish after-layout, VoiceOver order or dark/AX readability.

Required runtime proof: retain fitting/oversized row, viewport and real native target context; same single tap; all original destination/content/attachment/recovery assertions; inspected standard/largest-AX light/dark Drafts before/after views. Do not claim actual geometry or P04 acceptance from this review or grammar.

Counterargument: the615pt row cannot fit within the recorded570.3pt viewport, so universal full-row containment was impossible without changing product content or Dynamic Type. Agreed; the source amendment addresses that real precondition contradiction without truncating data or bypassing the actual native control.

### SUGGESTION / Consider: search controls and diagnostic observations retain explicit runtime limits

`apps/ios/Orca/Mail/InboxView.swift:179-202`; `apps/ios/OrcaUITests/OrcaUITests.swift:80-108,201-231,256-269,1799-1815,2462-2485,2578-2615`.

The Save handler still captures `model.resultSearch` and the selected account, carries the same review hint and `search.save-view` identifier, and is exposed once beside Clear. Standard layout uses a horizontal container with vertically wrapping text; accessibility sizes use a vertical container. No new line cap or query/View semantics are introduced. The added44pt control may consume more of an already tight AX/keyboard list viewport, so actual narrow/AX visibility, labels and remaining mail reachability remain acceptance gates. The unchanged49 test is a useful real-flow oracle; its existence in source is not a runtime pass.

The failure observations are correctly registered in test teardown after setup reaches their specific boundary. Original returned Booleans are captured before evidence; original waits/taps/assertions are preserved. They do not dismiss the keyboard, resubmit, scroll a missing option into existence, toggle again, or add an assertion deadline. Reads at teardown may reflect a later post-failure state, not the instant of the failed observation; the first refine value is correctly named after-failure. The new diagnostics cannot, by themselves, prove whether50/55 lost accepted model rows versus native List realization. Subject-refinement/preview errors remain explicitly unavailable because no safe existing error identifier exists. Some earlier setup/tap failures precede registration in a given case; no universal failure-capture claim should be made.

Counterargument: these cases are intentionally not fixed in this batch, and the design explicitly reserves a separately approved, fixture-gated app witness if structural observations remain insufficient. Agreed; preserve their actual reds/unclassified status until that evidence exists.

### PRAISE / Noted: narrow changes preserve authority and assertion meaning

- `DraftsView.swift:17-20,120-134`: exact section titles/scopes become noninteractive first content rows of the same sections, with opaque semantic paper backgrounds and combined header traits. Existing row data, metadata, sorting, fonts, line policies, account/lifetime guards, persistence and reconciliation remain unchanged.
- `ViewportGeometry.swift:33-37`: navigation and fixed-footer exclusions retain the original eight-point vertical margin, and row validation uses the actual list/application intersection width. Pan coordinates remain inside the measured content for the actual caller's valid viewport; there is no coordinate tap, managed app-layout mutation or expanded gesture budget.
- `OrcaUITests.swift:46,509`: only largest-AX iterations43/54 opt into the already existing bounded first-row reveal. The helper still checks Mail selection, performs at most6 owned content gestures, then uses the original20s first-row wait and retains second-row checks/restoration. Standard/default callers and subsequent reader/writer/catalog/Back/hide/provider assertions remain unchanged.
- `InboxView.swift:124-127,185-202`: the obsolete toolbar copy is removed rather than duplicated, and accepted submitted provenance remains the input to the same NativeViewEditor. No saved-View/query-pin conflation, implicit replacement or new wire route appears.
- `captureUnclassifiedBoundary`: output aliases are fixed and scalar observations are bounded counts/Booleans/native types/frames. A dynamic row/option ID is used only to query a unique element and is not emitted. Switch output is restricted to0/1/unavailable. Existing synthetic capture bounds the structural snapshot to60 nodes/depth28/10 children and16KB and omits labels/values/identifiers. No arbitrary error, search text, credential or network request is added.

## Security assessment

No new provider, transport, credential, filesystem, database, authorization or mutation primitive is introduced. The product changes are SwiftUI placement/semantics around existing actions. Failure diagnostics remain in the UI-test target and require the existing HTTP-loopback fixture gate. Their safe fixed aliases and omission of raw labels/values reduce accidental sensitive-data output; screenshots still belong only to the explicitly configured synthetic fixture, not a claim that arbitrary live UI is safe to capture.

The pre-existing fixture gate is a configuration check, not a new authentication or isolation guarantee. No passive app witness was implemented. The design's proposed future DEBUG observer/token-argument conditions are proposals only and are not approved runtime authority by this review. Core/API/shared/source preservation means the existing security contracts are not reimplemented here; it does not constitute full-app security acceptance.

## Evidence independently inspected

Read the applicable user-provided AGENTS instructions, `.agents/skills/interrogate/SKILL.md`, the desktop switch specification for retained behavior/theme/state obligations, full four-file source diff, full batch design and identity inventory, relevant Drafts/Inbox caller/control/helper source, existing diagnostic gate/capture, and runner selections. No parser/compiler was invoked to make these conclusions.

Read full retained724 compose and mailbox triages and relevant raw `checks.log`/full-job excerpts. Actual compose35/36 first failures occur before draft tap: raw native Button frames are `(0,14.7,402,568.7)` and `(0,109.3,402,615)`, with complete synthetic account/saved-status labels and nav/tab bounds yielding usable124..694.3. This supports the precondition diagnosis rather than a proven rich-conversion/sent-recovery protocol failure. Standard43 and54 journeys precede their second largest-AX initial-row failures. Mailbox49 has an acceptedFriday API200 and a missing original Save affordance;50/55/41/10/51 remain separately unresolved.

Actually viewed the two original retained compose PNGs `Orca-148.png` and `Orca-81.png`: both visibly show On server/Stored in Orca pinned text overlaying large draft content. These are724 before-context, not b185 after-shots, and exported ordinal names are not a unique assertion/timestamp mapping. No other screenshot inspection is claimed by this reviewer. Current724 failures and previous source approvals remain separate from this new candidate.

## Verdict and execution boundaries

**APPROVED WITH COMMENTS — exact e2a→b185 source only.** No blocker identified that requires a source correction before ROOT's minimal allocated gate. Execution is not authorized by this report. New10-scenario geometry checks remain unexecuted/unselected;44 grammar remains a future separate gate; UIKit/XCTest, native single-tap dispatch, fitting/oversized Drafts, Search49, both themes/AX, prior unchanged behavior assertions and final all33 acceptance remain open.

No source edit, staging, commit, grammar/parse, compiler, unit/geometry execution, build, simulator, server, browser, heavy job, CI read, remote action, PR mutation or push was performed. Only this external report was written. Checkout remained clean at exact `b185c7465648c62704b049f78db419de23a66599` on final readback.
