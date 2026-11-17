# BRE-457 fb10 compose artifact: source/artifact-only triage

## Exact identity and executed phases

Artifact13891000380, run43087654824/job130756175614, extracted `/tmp/bre457-hosted-compose-fb10` (150 files). ZIP `/tmp/bre457-compose-fb10.zip` SHA256 independently verified `fdb29a9b1caac50f201f10ffbaeb063ef85fe651aba02e0de6285e61acdc1c4d`.

CRITICAL: identity says **tested_sha = event_sha `56a2b65594ca10d6a07cce82e9ddee2665af93ed`**, head `fb10f5c89f4c5147de3a7e7b9a375c4ad1f9951f`. This differs from reading/mailbox identity. Event commit is not available in this local object store, so tested/head native or whole-tree equality is not asserted. Source references below were pinned with `git show fb10` into `/tmp/bre457-compose-fb10-head-source`; they are head-source explanations aligned with emitted line numbers/diagnostic strings, not invented verification of the event tree. Raw xcresult was not uploaded. Hosted iPhone17/iOS26.4.1/Xcode26.4.1, synthetic fixture only; outcome65.

Every exported summary was read: DirectCaptureLight16/0/0; FeedbackLayoutlight1/0/0; FeedbackLayoutdark1/0/0; FeedbackLight1/0/0; main Light178 passed/5 failed/0 skipped,total183 including units. **No main Dark summary/tests/artifact is present.** Ordered main test completion reports failure; no main Dark invocation follows it. Do not call FeedbackLayoutdark the main dark compose or test43 gate. Its intended selection remains test18.

## All five first failures

| Case | Actual first step | Checks/source reference and not-reached behavior |
| --- | --- | --- |
|14 SendingAccessRefresh | Writing-area helper exhausts12 original drag attempts; requires >=44pt safe body intersection and records failure before body.typeText | checks7478, emitted source780. It had launched Inbox, opened Compose and typed recipient. Access-refresh failure/upgrade/preservation assertions are NOT reached. This is not the old e061 noKeyboardFocus event, nor a capability transport timeout. |
|17 ForegroundRefresh | Same helper exhausts12 attempts before typing body | checks8447, emitted880. Browser/foreground capability refresh flow is NOT reached. |
|35 RichDraftConversionAX | Initial `assertInboxLoaded`, row1 existence after original20s wait | checks10488, emitted1178. Neither Drafts entry, rich draft selection, conversion nor large-body writing is reached. |
|36 SentRecoveryAX | Initial `assertInboxLoaded`, row1 existence after original20s wait | checks10713, emitted1103. Drafts/server delivery-recovery controls are NOT reached. |
|43 FeedbackShortReaderWriter | First body focus/type succeeds; feedback open/dismiss and short-height keyboard recovery reach second helper, which exhausts12 attempts at the resumed-writing boundary | checks11460, emitted401. The later resumed typing/44pt/footer geometry/state assertions and subsequent size iteration are not proven by the case. |

Test16 is **Passed**,47.530s, both actual test node and ordered checks7747–7946: no current attachment-removal/form-reveal failure. Test53 is **Passed**,50.084s, checks11609–11796. These statuses supersede “unexecuted” for their actual light event-tested scope only; they do not retroactively change earlier e061 failures or prove dark/main/full-provider acceptance.

## Diagnostic geometry and chronology

The diagnostic timing fixes preserved the original behavior boundary: no extra focus observation between successful tap and typeText; failure teardown captures after the issue. The failing helper's own exhausted-attempt capture happens before XCTFail. Its44pt assertion remains substantive and is not to be weakened.

14 and17 each print12 identical intersections:

- form `(0,0,402,487)`; navigation maxY116;
- body `(22,374.333,358,360)`; save-status minY406.333;
- computed viewport `(0,118,402,286.333)` and body intersection height **30.00001pt**;
- Send/Done y431,height44; keyboard y583..816; Feedback y490.5..535.5;
- permission guidance/Refresh action exists in the fixed inset. Send is disabled as expected for read-only access.

43 first helper had a199.33pt body intersection and successfully tapped/typed `Layout writing.`. At the second helper, all12 later intersections stay43.00001pt:

- form `(0,182,402,305)`; navigation y192..246;
- body `(22,361.333,358,177.667)`; save-status minY406.333;
- computed viewport `(0,248,402,156.333)`; intersection height **43.00001pt**, below44;
- Send/Done y431,height44; keyboard y583..816; Feedback y490.5,height45.

Head-source helper1311–1352 computes bottom from save-status, then drags at x0.98 and y0.75→0.25 relative to the **reported entire form frame**, rather than the viewport it just calculated. For43, its drag starts y410.75, inside the fixed actions/status region, below actual safe body viewport max404.333. For14/17, drag starts y365.25; the screenshot shows fixed read-only guidance/Refresh occupying this band. The safe-area-inset VStack at ComposeView213 onward contains permission copy and44pt Refresh *above* save status; thus save-status is not the top of the entire fixed inset in permission-blocked states.

Proven: the original stimulus never achieves44pt, repeated frames do not move, and its reported gesture start lies in fixed chrome by the observed geometry/source. Plausible narrow cause: drags begin on the fixed footer rather than scrollable content, and permission guidance is omitted from the helper's upper-footer boundary. **Not proven:** actual event routing, that a real user cannot reveal the body with a content-origin pan, that TextEditor itself cannot scroll, or that removing From/Discard/Feedback is required. Do not jump from this to a Compose product redesign.

## AX35/36 are different from mailbox placement cascades

Diagnostics explicitly preserve original20s false and show row-any count0, row-button count0; list exists `(0,490.667,402,294.667)`, Inbox nav exists, Mail tab selected, Drafts/Settings unselected. Initial source calls stop before any Drafts gesture.

Actual compose fixture at20:11:27.787 and20:12:08.811 returns **message1 and messages2–5** for the initial requests. This differs from the mailbox suite's post-Move omission. Therefore shared misplaced row1 is not supported as the explanation here.

AX screenshots show very large fixed Mail controls/account identity and scrolling Inbox introduction consuming the first visible list area (“5 conversations shown ·1 unread”), with no row visible. This plus count0 is consistent with a lazy/offscreen row precondition; exact event-tree row realization/identifier cause remains bounded by exported diagnostics. No new row-ID product bug is established. Source helper waits without attempting a content-bounded reveal. Do not mislabel35/36 as body.isHittable, rich conversion or sent-recovery failures.

## Actual From / P04 / local Discard scope

Test53's passed head-source handler: real Compose opener; `compose.from` exists and label contains fixture account; unfinished recipient `Unfinished <person@`; explicit subject/body typed; Done; enabled Discard; confirmation; Keep writing preserves subject/raw recipient/body; second explicit confirmation returns to Mail; Drafts does not contain that subject; synthetic sendRequests/deliveries counters unchanged. This is real light local-only, standard-size handler execution at the event-tested source; not merely a Foundation claim. It does not cover linked DELETE, cross-device revision races, all held/disk/session controls, attachments, AX or dark. Existing Foundation boundaries retain their own separate proofs.

Visually inspected screenshots show read-only From with `luke@example.com` and Gmail (e.g.1,9,33,120); Drafts rows show actual account/body preview/saved age/status/attachment indicators and truthful “Stored in Orca” heading (e.g.26,32,102,150,197). These render observations do not establish a selected-account-switch pinned-From runtime test or broad P04 management parity. Test53's From account assertion covers only its fixture account.

Orca-106 contains the Device discard confirmation and exact body text, with “from this device”, Keep writing and Discard draft. Orca-102 shows the8:15 Drafts context after the unique local discard journey. Subject/timestamp/content correlate with53, but there is no exported attachment-ID→PNG ordinal manifest, so do not assert unique ordinal mapping as independent proof of a particular assertion. The test node/ordered assertions supply execution identity.

## Images actually inspected / limits

All38 unique main-phone PNG hashes were visually inspected, covering44 main phone files after6 exact duplicates. Unit-sized render PNGs were not called phone UI. No raw xcresult/attachment manifest links ordinals to exact issue times. Representative content:1/172/200/210 show read-only permission footer, From/recipient and keyboard with body not visible;98/105/153/266 show short resumed Feedback-layout compose with approximately one line above footer;66/236 show AX Inbox intro with no row visible;106 local Discard;2/176 attachment keep.txt after removal;26/32/102/150/197 Drafts metadata. Before/after diagnostic PNG ordering is not inferred solely from filenames. Feedback/DirectCapture phase summary passes are reported separately; their PNGs are not used to claim current main43/dark acceptance.

## Minimal proposed isolated follow-up, no edits made

1. **Test stimulus correction candidate, preserve strict44pt:** derive the actual scroll-content region below nav and above the *top of every fixed footer component*, including read-only guidance/Refresh. Start/end the existing bounded drag budget inside that region, not at normalized0.75 of an outer ScrollView frame containing the safe-area inset. Retain single successful body tap, immediate caller typeText, all12 maximum attempts and44pt assertion, deadlines, writing/privacy/state assertions and failure-only diagnostics. Add pure deterministic rectangle controls for the actual30/43pt cases and footer-start exclusion; hosted proof is still necessary. If bounded content panning cannot expose44pt, report that new precondition failure and seek a narrow product layout decision; do not shrink fonts, discard identity/permission or reduce44.
2. **AX initial row precondition candidate:** same content-bounded native list reveal approach already used for long Drafts rows, constrained between fixed controls and floating tab/footer, asserting Mail stays selected and actual Button/any IDs/counts/full frames. Preserve row existence/read-content assertions; no auto-navigation bypass, extra timeout or firstMatch substitution for ambiguous identities. Prove returned owned data separately as current diagnostics do.
3. Do not touch conversion/send/attachment/discard protocols from these first failures. Keep current test16/53 passed scope and do not broaden them. No blind retries, case skips, assertion weakening, geometry change, product edit, local Apple run, CI watch/dispatch or push occurred during this triage.
