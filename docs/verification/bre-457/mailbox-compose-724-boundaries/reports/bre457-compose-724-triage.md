# Actual724 compose triage — read-only

No source/test/runner/fixture/timeout/selection change, staging, commit, build/runtime/heavy job, CI query, retry or push.64b reader source remains frozen; current checkout0aa117aa329fe4d4a550a18a878cf5e64b62fea7 is clean and docs-only above it. Current artifact findings are not covered by that reader's scoped source review or grammar.

## Identity and complete reached scope

Artifact13908167183 `/tmp/bre313-724-compose`,146files; ZIP SHA256 `249b3b6d60bd0d22db752d6055b84760133e096beaef2257b13a7184096ef235` independently verified (27,988,217bytes). **Actual tested_sha=event_sha1f171a0ff2af3381e798841eacf9246376d0efe2**, PR head72448b3fd5c5dbe2d2b9046f30e9185a2bffd44e. Using the already-present local Git event object, independently checked parents[main7c971936,head724] and whole content tree `94563e0db760ab26a141bb4f8132012c2c7cf71a` equals724's tree. Execution/head remain distinct despite equal source content; no network fetch/query was used. iPhone17/iOS26.4.1/Xcode26.4.1, Bun1.3.14/Node24.22.2.

| Actual phase | Summary and actual test nodes |
| --- | --- |
|FeedbackLayoutlight |test18,1PASS/0FAIL/0SKIP |
|FeedbackLayoutdark |test18,1PASS/0FAIL/0SKIP |
|DirectCaptureLight |16PASS/0FAIL/0SKIP:15 native Feedback tests plus UItest39 current-screen capture |
|FeedbackLight |test38,1PASS/0FAIL/0SKIP,132.377s |
|Main Light Orca |185PASS/5FAIL/0SKIP=190:173 native units PASS,12 UI PASS,5 UI FAIL |
|Main Dark |NOT RUN; no summary/bundle/phase-start |

Direct's15 unit IDs and Main's173 are disjoint; union is188 unique native units passing across these two phases. Do not call185 all units or infer191 candidate units passed. All preludes completed and Main Light did execute, unlike the old41a picker-prelude failure. Job ends exit65; full job log records Process completed with exit65 at01:54:57.412223Z, not mailbox's outer-timeout case. LayoutDark18 is real dark coverage of that case, **not** main-compose Dark or test43 dark acceptance. No raw xcresult uploaded.

Main UI PASS:01 inbox/search/reply/reopen/send-once;15 uncertain-delivery check;16 attachment removal/persist/remaining file send;20 empty refresh;21 move-catalog cancel;22 sender-catalog swipe-away;30 first-create back/reopen no-double-send;31 sent server draft noneditable;32 unsent local edits retained;33 rich cancel preserves HTML;34 explicit rich conversion/reopen;53 explicit local Discard. Their actual scopes are not physical-provider/whole-app approval. From/P04 metadata and all ambiguous paths are not declared accepted just because those case names pass.

## b795 intended picker precondition now actually executes

Raw checks2194–2581: test38 runs; at2389 the actual `PXGGridLayout-Info AND label BEGINSWITH "Video, "` unique-video predicate is queried, then the entire case passes132.377s. Source tree equality binds this to the b795 selector, retaining original10s/count1 and later exact submitted MP4 SHA `0a901c954fd7f21eeab6c48c2ac77e74368df72f9d2a061e88a1a462b1b376d4`, two previews, explicit reviews/retry/API identity assertions. Inspected FeedbackLight4 shows both synthetic image and video reviewed with Send enabled. This is actual current-case positive evidence, not a grammar-only claim or an assumption that a source edit worked. It does not prove uniqueness on arbitrary user libraries, identify timestamp causation or establish all Photos/feedback dark journeys. The original bounded picker helper is unchanged; no new coordinate/force behavior is inferred. Prior41a date-matcher red remains historical.

## Five exact first failures

###14 and17: ambiguous permission-label geometry query, before body tap/type

Checks7179/7674, source1430 in focusComposeBody's fixed-frame collection. Actual query matches TWO legitimate descendants with `compose.send-permission`: Image(labelLock) and StaticText(the read-only Gmail copy). The helper uses `.filter(exists).map(frame)` on a single any-type element query; resolving frame throws multiple-matches. These are not missing permissions, lost writing, no-keyboard-focus, transport timeout or access-upgrade failures at this step. Body tap/type and subsequent failure/upgrade or foreground recovery assertions are NOT REACHED. Old e061 noKeyboardFocus is not re-proven or declared fixed by this earlier stop.

Source ComposeView applies that identifier to a Label, whose image/text can legitimately expose two AX children. This differs from Settings' broad ancestor identifier overriding many unrelated interactive controls. Narrow proposal for ROOT: collect the actual matching footer components through a bounded all-elements query and compute their real bounds/earliest boundary (or uniquely typed StaticText plus measured icon bounds), requiring expected ownership/types rather than firstMatch/title fallback. Preserve the fixed footer exclusion,>=44pt writing intersection, original12 drags, same single body tap and immediate typeText. Do not remove the permission banner or change product auth/Send policy to fix a test-only frame query. Subsequent actual body focus remains a hosted requirement.

###35 and36: full-Draft-row containment fails; one requirement is geometrically impossible

Checks10553/source1281 (rich AX) and11607/source1205 (sent-recovery AX), inside revealDraftRow BEFORE tapping the draft. These cases now pass initial Inbox setup and reach Drafts; they do not fail on initial Inbox/body checks as older e061 did. Helper finds actual target, performs its existing32drags, dumps hierarchy and fails “Expected full draft row above the tab bar before tapping”. Rich conversion/sent-recovery destination assertions after this tap are NOT REACHED.

Actual public hierarchy:

-35 target `draft.746273a0-a6ad-4756-97c4-e8dcbd356a43`, row(0,14.7,402,568.7), source-rich subject/account/preview/saved status in full label; nav(0,62,402,54), tabs(0,702.3,402,83), list(0,0,402,785.3).
-36 target `draft.109696de-962a-4a56-a4bc-911553ee8f66`, row(0,109.3,402,615.0), local-edits subject/account/preview/status; same nav/tab/list bounds.
-Helper's usable vertical interval is124..694.3, about570.3pt.35's568.7pt row leaves only~1.6pt landing tolerance while its drags use large relative movement; last top14.7 is under nav.36's615pt row **cannot** be wholly contained in570.3pt for any scroll offset. More waits/swipes cannot solve that inequality.

This proves a setup-contract conflict with large native rows, not a failed rich-conversion or sent-recovery protocol. It does not grant weakening the behavior assertions. ROOT design proposal: handle rows that can fit with measured bounded alignment; for oversized rows, use a separately approved native-row stimulus contract requiring the unique real Button, complete meaningful AX label,>=44pt actual visible unobscured portion/reachable tap point and retained full destination/content assertions. Keep font scaling and data; do not truncate/shrink fields to satisfy the helper or force coordinate taps. This requires ROOT approval and hosted proof, no implementation here.

**Separate actual visual concern:** detailed148/81 screenshots show On server/Stored in Orca pinned header drawn over scrolling row text. Source plain List Section uses DraftSectionHeader without an opaque background. This is visible in inspected synthetic contexts, not merely an assertion summary. Export ordinals lack a unique attachment map, but row subject/status context matches the failures. A helper change alone cannot establish readable P04 UI. ROOT should evaluate an opaque native header or scrolling section-introduction layout preserving real metadata and Dynamic Type; measure header bounds as another occluding boundary. No Drafts product fix/redesign is authorized here; exact current screenshot/layout overlap is retained as a design issue, not silently normalized.

###43: standard short reader/writer path completes; second AX launch cannot realize initial Inbox row

Checks12344/source469: assertInboxLoaded original20s row1 existence fails in **second largestAX iteration**, before opening that iteration's reader/Compose. Standard iteration proceeds through reader actions, draft body writing, keyboard/Feedback checks, resume and cleanup; no failure interrupts it. The helper actually produced>=44 writing intersections, including a43pt attempt rejected before a later156.333pt visible area/tap. This is meaningful standard-path positive evidence, not all AX acceptance.

Failure diagnostics after the ORIGINAL wait: row-any=false/row-button=false, counts0/0; Mailselected=true; list(0,620.667,402,164.667) not hittable, nav(0,192,402,114), Mailtab(68,706.333,94,54). Source test43 calls assertInboxLoaded without its opt-in boundedListReveal; no bounded reveal is attempted before that first-row wait. Inspected245 shows the giant fixed AX controls and only Inbox introduction before native tabs; no row visible. This supports an AX viewport/materialization precondition issue, not Feedback overlap/body focus at the failed step. Counterargument: very little usable mail viewport remains, itself a native usability concern; a reveal-helper correction cannot prove controls/layout acceptance. Require bounded owned content gestures/full relevant before/after geometry and preserve all original reader/writer/Feedback checks. Do not add waits/tab taps/forced routes or conflate this with724 reader04's different row3 candidate (currently64b changes ONLY test04).

## Inspection and evidence limits

132 exported PNGs,127 unique hashes surveyed via five derived contact sheets. **Five original images inspected in detail:** FeedbackLight4 (two reviewed media), Orca148 (rich draft AX/pinned header), Orca81 (local edits AX/header), Orca245 (initialAXInbox), FeedbackLayoutdark2 (actual dark conflict/keyboard/footer before-context). No full-detail claim for132. Hash groups/known files are in `/tmp/bre457-compose-724-hashes.json`.

No unique assertion-to-exported-ordinal map/raw xcresult is available. Stage prefixes make FeedbackLight/LayoutDark contextual attribution stronger; Orca numbered PNGs are compatible matching contexts, not invented exact timestamps or before/after pairs. None is a64b candidate after-shot. No physical provider, production Linear, OS capture permission, TestFlight or deployment proof follows from synthetic case passes. Actual source tree equality closes the old execution-identity gap but does not turn five failures into passes.

## Stop / handoff

Keep64b product frozen. Report narrow footer-query, AX draft-stimulus/header-readability and initialAXInbox issues to ROOT before any change. Preserve all original deadlines, gesture budgets, content/privacy/Send/recovery assertions and actual passing cases. No source fix, heavy job, automatic retry or publication is implied. All33/full native acceptance remains open.
