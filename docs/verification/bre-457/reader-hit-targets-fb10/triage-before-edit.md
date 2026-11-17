# BRE-457 fb10 native reading: read-only artifact triage

## Verdict and identity

Both failures are actual current-head light-theme runtime reds. The new diagnostics narrow the first broken steps to **history disclosure with no observed net expansion**, and **one exposed composite wide-Switch tap with no observed state change**. Do not yet change the unread visibility formula/history anchor or infer a late AX-publication fix. No source edit, test/build/heavy job, child, server/simulator/browser, CI poll/retry/watch/dispatch, push or catalog/wire integration occurred during this triage. Only this requested `/tmp` report was written; checkout remains clean at fb10.

Artifact13887304884: `/tmp/bre457-reading-fb10.zip`, independently recomputed SHA256 **a8a6764843fd4c955f10ba8e709d3a23c76d0ecb77a9dab5174baba3884f2f83**, extracted `/tmp/bre457-hosted-reading-fb10` (134 files). Read identity/outcome, all summary failures, ordered test outcomes and detailed checks around both complete journeys/new diagnostics. Root's full decoded job is `/tmp/bre457-reading-fb10-job-130756175858.log`; artifact checks.log supplies retained runtime evidence below. Run43087654927/job130756175858 exit65. Identity explicitly says **tested=head fb10f5c89f4c5147de3a7e7b9a375c4ad1f9951f**, event56a2b65594ca10d6a07cce82e9ddee2665af93ed. Do not relabel event SHA as tested merge or assume event-tree equality. iPhone17/iOS26.4.1, Xcode26.4.1 build17E202, macOS26.7.2, Bun1.3.14/Node24.22.2 on hosted runner. rawXcresultUploaded=false.

**Light Orca:186PASS/2FAIL/5isolated-image scope skips, total193. Dark reading not run**: only Orca-summary/tests exist. Separate image job PASS is root-reported separate scope, not dark reader acceptance. Unit/browser PASS and compose/mailbox last reported RUNNING are root inputs; those jobs were not polled.

All native UI outcomes in ordered checks: styled04 PASS64.361s; conversation07 PASS59.773s; test37 FAIL57.207s; EarlierMessages AX PASS108.081s; HTML AX PASS129.363s; LongHTML repeated-open PASS91.363s; Tools FAIL68.535s. Five image cases are explicitly skipped here for their isolated scope. No additional failure class is hidden by a tail-only reading.

Exact immutable source reviewed: ThreadView.swift Git blob662d95581d020425698c99f7c989190b86956148/SHA2564ffcd711daadfd672d59d13bff33db1f91edddfcfedca1d6a488bdb926887693; OrcaUITests.swift SHA2567018fe4aad9613161b30759a3fe7adb039a7b1e090b2c4bd1d08d80e85e2e0bb; ReaderUITests.swift SHA256a0b299eb7006da067f7e1c41718d20c772ae33d5a4cf1e00a11499dbbf229f0a. Read current exact fb10 source, b455 timing ordering, canonical P03 and exporter source. Product remained f153 while diagnostic test source remained b455. e061186/2/5 remains historical, not overwritten by this new receipt.

## 1. History: first break precedes an established expansion

`OrcaUITests.test37LongConversationOffersOffscreenUnreadAndLatestJumps`, fb10 line1983. The initial unread22→latest24→unread22 round trip passes. Feedback/jump/reply geometry at the initial checkpoint passes37 assertions/zero overlaps. The existing six-iteration pre-history loop emits **no swipe**: it accepts Show21.isHittable immediately.

New pre-tap state (checks5976–6059):

| Target | Before | After original failed5s wait |
| --- | --- | --- |
| Show21 | exists/enabled/hittable true; `(118,56,166,44)` | same |
| Hide21 | absent | absent |
| Earliest sender1/header | absent | absent |
| Unread22 sender | `(84,132,115.667,16.667)`, hittable | identical |
| Unread22 header | `(40,132,322,78.667)`, hittable | identical |
| Latest24 sender/header | absent | absent |
| Jump unread | absent | absent |
| Jump latest | `(265.833,655.5,124.667,45)` | identical |
| Reader AX scroll view | `(0,0,402,788)` | identical |
| Navigation | `(0,62,402,54)` | identical |
| Reply / Feedback | `(20,732,98.333,44)` / `(270.5,791.5,116,45)` | identical |

At t43.74 the same Show21 Button.tap begins; synthesis43.95/idle44.39. **The original5s unread-jump wait starts44.50 immediately after the tap, before extra Show/Hide reads.** Polls45.54/46.60/47.53/48.57/49.52 remain absent; final predicate false49.84. Only then Show/Hide observations occur50.10/50.19. Recorded `original_5s_jump_result=false`, `show_after_original_wait=true`, `hide_after_original_wait=false`. Full post diagnostic is printed56.0s, before assertion1983 fails. Later history/latest/Feedback/return assertions are not reached. A screenshot/longer wait did not rescue the original predicate.

**Established:** no net expansion is visible by the original deadline or later diagnostic; earliest history is not exposed; the unread header stays physically visible. Under the unchanged source policy, hiding Jump unread while that unread card is visible is consistent. The previous hypothesis “history inserted, then stale layout/anchor hides the jump” is not the demonstrated first step at fb10.

**Strong geometric explanation, with limits:** Show21 occupies y56..100, entirely above the useful reading region below navigation y116. Its rectangle overlaps navigation by38pt; the remaining6pt is in the upper system region. Its geometric center(201,78) overlaps the Conversation navigation title. `isHittable=true` is therefore an insufficient visibility/activation precondition. Source jump(unread) scrolls the unread card to top, naturally leaving the preceding disclosure above it; the test's isHittable-only loop then stops without revealing it. This is consistent with the actual screenshot context and unchanged frames. XCTest logs do **not** retain the actual event hit point or binding transition; do not assert a measured center click, a specific UIKit interceptor, or prove the closure never ran rather than toggling/resetting. There is no observed expansion to justify changing scrollTo or message visibility formulas yet.

### Narrow proposal for root decision

First correct the **pre-tap test visibility precondition**, not the jump policy: the existing at-most6 swipeDown reveal loop should accept Show21 only when its complete44pt target is below nav.maxY+margin and above the reply inset, using the same real content gesture type/budget. Assert full containment before the original single tap, then keep the immediate5s wait and every downstream assertion unchanged. This is stricter testability evidence, not a claimed product fix; it may cause an existing permitted reveal gesture to execute where the old loop performed none. It is not a force-click, post-tap corrective scroll or timeout increase. Root must explicitly approve that stimulus-precondition correction before editing. If unchanged zero pre-tap gestures are mandatory, report this occluded-target limitation instead of claiming a successful disclosure interaction.

Only if a **fully reachable** single tap produces Hide/earliest history but then loses the jump should a separate layout-aware history anchor correction be evaluated. Preserve chronology, original unread target, focus/reduced motion and existing full-card visibility policy. Do not make Jump unread permanently visible or blindly change Task.yield/scrollTo to cure this non-expansion receipt.

## 2. Tools: composite AX Switch is not the nested native switch rectangle

`ReaderUITests.testMessageToolsPreserveFindFormattingAndWideContentChoices`, line177. This fails in the first standard/L iteration; AX iteration and all later wide/collapse/plain/Find preservation assertions are not reached.

Tools expands successfully; its state remains Expanded. Reveal helper emits no corrective drag for wide and accepts the fully visible control. Pre diagnostic (checks10006–10090): outer labeled Switch `(40,583,322,28)`, exists/enabled/hittable; one Switch matched by the label/identifier predicate, two Any matches, two descendants. Descendant0 is label StaticText `(40,588,184.333,18)`; descendant1 is a **second native Switch `(301,583,63,28)`**. Tools `(40,463,322,44)`, Find y519..563, body `(40,687,322,2738)`, Reply y732..776 and nav y62..116. No navigation/footer overlap at the wide row.

At t55.75 the original `wide.tap()` starts, synthesis56.01/idle56.35. **The first wide.value is read at56.35 before any post diagnostic work and is0.** Line177 later asserts that captured0, not a fresh value. The separate later current-value query at approximately57.04–57.19 is also0. The nested native control is still identified as the0 Switch during descendant observations around66.89–67.40, and the post PNG shows off. Diagnostic print time67.7 is the end of assembling observations, not the timestamp of every field. No event beyond the single original tap occurs. Tools and body frames remain identical and no wide explanation appears.

**Established:** this is more than an assumed delayed first AX value; immediate and later observations are off. The exposed parent Switch rectangle spans the label/space while its nested native Switch occupies only the trailing63pt. The parent geometric midpoint(201,597) lies over the text, outside the child301..364 switch. The actual tap point is not exported; infer an input/accessible-target routing mismatch as the leading explanation, not a measured knob miss. No binding-transition trace exists. Source has no wide reset except its Toggle binding; a whole NativeReaderBody remount would also reset toolsExpanded=false, which is not observed. Thus a remount/reset is less supported than non-actuating composite hit routing, but source plus snapshots cannot exclude every internal framework transition.

### Narrow product proposal for root decision

Repair the exposed control structure, retaining the same outer wideContent binding/state and native switch semantics. A concrete minimal candidate is an explicit readable label plus a labelsHidden/fixed-size native Toggle with that same explicit accessibility label, in a44pt minimum row, avoiding a full-row composite Switch that is reported tappable over a non-actuating label. Keep the visual label readable at Dynamic Type and a genuine44pt interaction region; verify the actual returned AX frame/hit point rather than relying on an outer frame alone. Exactly one exposed labeled Switch should activate the binding once. Do not add a row onTapGesture that can double-toggle when its child fires, use private UIKit/KVC, or reset/remount content.

Keep the test's same label-based Switch lookup, same `wide.tap()`, first immediately captured expected1, all later off/on/collapse/reopen/Find checks and current timeouts. Do not target a child/knob coordinate in the test, force-click, add a second tap or replace the assertion with a semantic wait. Hosted standard/AX both-theme results plus actual on/off explanation/reflow/consent preservation must prove the candidate. This is a proposal, not an implemented or verified repair.

## PNG inspection and attribution limits

The artifact has128 PNGs:60 native phone captures at1206x2622 and68 HTML render snapshots. I actually viewed all46 distinct native byte-hash representatives;14 additional native filenames are byte-identical duplicates. The68 render snapshots were not visually reviewed in this focused hit-target triage. No images were edited or synthesized.

Relevant correlations:

- Orca63 and76 are **byte-identical** standard Tools-expanded screenshots with off switch, static label at the leading edge and native knob at the trailing edge. Their content and clock7:54 match the diagnostic controls/frames and single Tools case. They form the relevant unchanged off-state pair, but no attachment manifest proves which ordinal is pre versus post.
- Orca99 shows standard unread22 at the top, no visible Show21 text, Jump latest and reply; status clock7:47. Orca9 shows the same framing at7:48. This matches pre/post diagnostic frame invariance and the19:47:50/19:48:03 capture windows. Treat99→9 as a strong content/time/geometry correlation, **not manifest-verified filename-to-attachment attribution**. In both, the reader's preceding disclosure is behind the navigation region rather than visible in content.
- Orca39/98 show the earlier standard first-unread context with Show21 visibly below the account header; Orca30 shows latest24/Jump unread. Orca34/55 are AX history context from other checks, not the failed standard Show21 step. Other native captures include inbox reveal, earlier-history and HTML reading states; they are not all failure screenshots.

Exporter source scripts/ci/export-evidence.py240–247 enumerates recursive attachment paths and copies only raster files to ordinal names. It does not preserve original name/test→ordinal mapping or non-raster text attachments. The new bounded stdout diagnostics do survive and are the authoritative named before/post evidence. rawXcresultUploaded=false still prevents recovering actual tap hit points/binding transitions from that bundle. No unique ordinal mapping or event coordinate is invented.

## Handoff and preserved gates

Root can separately authorize the stricter history reveal precondition and narrow wide native-control structure after reviewing these first-step receipts. The source policy/layout/security/fixture/API remain unchanged now. The actual fb10 reds are retained before any edit; e061 and08 histories remain distinct. No API/catalog/unpublished Unicode contract is integrated. Keep P03 body readability, direct importance, privacy consent/sanitization, chronology, Reply/Feedback geometry, account/session/generation guards and all original behavior assertions. There is no reason to broaden this into a reader rewrite or request a blind retry.

Current source reviews approved f153 functionality and b455 timing diagnostics within their scopes; the actual reader runtime acceptance is FAILED. New proposed fixes need their own exact-source review and hosted verification. No all33/current-app approval, physical provider/OS delivery or merge/release claim follows.
