# Actual724 native reading triage — read-only

Scope: source/artifact inspection only. No checkout edits, staging, commits, retention, tests, Apple commands, CI query/retry/watch, publication or children. Checkout stayed clean at `72448b3fd5c5dbe2d2b9046f30e9185a2bffd44e`. External report, hash inventory and contact-sheet navigation aids only were written.

## Identity and complete outcome

Artifact `/tmp/bre313-724-reading`, ZIP SHA256 `d69e9104ee55706f8fe6c90d739bbcdafce0f4f6306ad59e8c3e2af504440fce` independently rehashed (24,600,306bytes). Identity explicitly says **tested_sha=head_sha=72448b3fd5c5dbe2d2b9046f30e9185a2bffd44e**, event `1f171a0ff2af3381e798841eacf9246376d0efe2`. Event/head are distinct; no event-tree equality is needed or newly claimed because identity explicitly pins actual tested724. iPhone17/iOS26.4.1/Xcode26.4.1, macos26 image20261102.0473.1, Bun1.3.14/Node24.22.2. Outcome65, raw xcresult not uploaded.

Light: **193PASS /2FAIL /5 image-scope SKIP =200**. Raw test nodes and checks.log5540–5543 confirm **all188 native unit tests pass,0fail**. Five UI passes: test07 latest-message, test37 long-conversation jumps, Reader EarlierMessages AX, HTML AX and LongHTML scroll/back/reopen. Raw test37 starts5864 and passes6457,68.615s. The two remaining failures are exactly below. Dark **NOT RUN**: job phases contain Light start then evidence export, no Dark start; no Dark result/geometry is inferred. Separate current image job5+5PASS remains ROOT-reported independent scope, not these five skipped cases passing in this job.

##1. test04: target row not materialized; canvas never reached

Actual first failure: OrcaUITests.swift2622, `row.waitForExistence(timeout:10)` in `openConversation`, target `inbox.message.ios-fixture-message-3`. Not a foreground/background/canvas assertion, not a failed conversation tap.

Ordered checks.log5553–5636:

- Launch01:18:03.388; open picker; choose the unique `mailbox.option.normal`; Inbox navigation succeeds.
- First row1 exists (original20s check); row2 checks occur; Mail selection is read. At t24.54 the original10s message3 existence wait starts, stays absent and fails t34.74. No reveal drag appears in this path before the wait; no target tap or canvas assertion executes.
- Matching fixture trace `ee4a6b4e-bf49-4db7-8ddb-38727d9091e8`: `/v1/inbox?view=all` received01:18:23.731, status200 response-ready01:18:23.953 includes allfive exact owned IDs1..5 including3. This rules out this request omitting the fixture row; it does not by itself prove how the client laid it out.
- Current production uses native `List`/ForEach with actual row NavigationLink IDs. `openConversation` has only an existence wait then single tap. It does not use the bounded row-reveal precondition already used by ReaderUITests.openHTML.

**Nonvacuous same-run control:** in the later Tools case, ReaderUITests logs initially message3 button_count=0/any_count=0 while Mail is selected, list(0,324,402,464), nav(0,62,402,114), tabs(0,705,402,83). One existing bounded content drag attempt0 uses top332/bottom697/x281.4; afterward button_count=any_count=1, row(20,504,311.667,109.667), Mail still selected. The same real Button then opens Conversation. Ordered witnesses9477/9666/9688/9712 and tap9914. Other Reader HTML cases also pass, providing positive reachability/body controls.

**Classification:** strongly supported test-precondition gap from lazy/offscreen native list content, rather than an API/data absence or demonstrated renderer defect. The exact failing test04 snapshot is not uniquely mapped and no full failing-row hierarchy was exported, so precise offscreen frame/cause in that instance remains inferred, not measured. No tab-bar navigation is observed in this failure; no corrected-navigation product claim is warranted.

**Narrow proposal for ROOT:** reuse the existing bounded native content reveal policy for this actual message3 ID before the unchanged10s existence wait, assert Mail/Inbox ownership plus unique actual row Button and reachable viewport, then retain the same single tap and every original readable-canvas assertion/deadline. No title/firstMatch fallback, forced route, extra20s wait or data mutation. Fail honestly if the bounded precondition cannot materialize/reach the row. This is a user-stimulus setup correction, not an HTML product fix. No code was changed here.

##2. Wide control: single-tap still leaves0; bridge/event cause not instrumented

Actual ReaderUITests.swift177. Standard `UICTContentSizeCategoryL` is first in the loop; failure stops before AX iteration and all downstream wide off/on, collapse/reopen, plain/Find/query preservation assertions. Do not label those current paths passed.

- Current source ThreadView.swift375–440: `wideContent` is @State, defaultfalse, passed directly to SafeHTMLView; Tools state is separate @State in the same NativeReaderBody. There is no async action or explicit wide reset. `MessageImageBody` embeds it; identity is owner/account/message/body based. No enclosing row Button wraps the body and no reader-level tap/gesture intercept was found in inspected ThreadView/app scope.
- Readable label is a separate AX-hidden Text; the SwiftUI Toggle uses the same binding, labelsHidden, switch style, fixedSize, min64x44 frame, contentShape(Rectangle), explicit AX label. feee's layout change therefore did not establish a working user interaction.
- Before diagnostic (checks.log10020+): value0, ToolsExpanded, one query Switch/two any matches/one descendant. Outer Switch(298,575,64,44), inner native-type Switch(299.667,583,63,28); both enabled+hittable. Navigation bottom116; Reply begins732; both control rectangles are fully inside the reader viewport, away from Reply and nav.
- SAME one `wide.tap()`: t46.08 target Switch, t46.26 synthesize event, t46.58 idle; t46.59 immediate value read stores0 BEFORE post diagnostics. Later diagnostics also sample current0 and ToolsExpanded; line177 compares the captured first0 against1 and fails. Source capture evaluates observed current value before the slower geometry/snapshot work; its printed epoch is not an8-second-delayed state probe. It does not prove a publication race or eventual later success.
- Outer geometric center(330,597) lies inside child bounds, whose center is approximately(331.167,597). **This is arithmetic only, not the event hit point**; XCTest logs no actual hit coordinate/hit-tested view, UIControl event or binding-setter invocation. Both native/outer AX types being40 and enabled/hittable do not prove valueChanged was delivered. Two any nodes are ancestor/descendant; one exposed query Switch is found, not two independent user controls.

**What is established:** real hosted single-tap regression persists at current source with stable visible off-state and no geometry occlusion in the recorded target. A mere first-read-too-soon explanation is unsupported by later0, and ToolsExpanded plus stable frames does not suggest a whole NativeReaderBody reset; it does not conclusively exclude a narrower reconstruction/event issue. Binding setter/event delivery/state update are uninstrumented. No exact product root cause can honestly be proved from AX geometry alone.

**Narrow product root-cause candidate for ROOT design:** the added SwiftUI interaction/AX wrapper (fixedSize→frame→contentShape around a labelsHidden native switch) is exposing a tappable outer Switch while the native value-change bridge may not receive/commit that action. Avoid another cosmetic wrapper-only claim. A minimally scoped corrective candidate is to replace only that switch boundary with a public UISwitch representable/coordinator whose real valueChanged synchronously writes the SAME @State binding, whose updateUIView reflects that binding, and whose native control owns the readable AX label and >=44pt target. Keep the visible wrapping label, one exposed Switch, Tools state, body/consent/Find semantics and SAME test tap/immediate expected1. No row gesture, double-toggle, child/knob coordinate, privateUIKit/KVC, second tap, polling or relaxed deadline. This is a candidate, not a verified diagnosis/fix.

If ROOT prefers causal instrumentation first, add only synthetic-loopback-gated scalar logging of native valueChanged/binding old→new and subsequent rendering/reset, not mail, tokens or arbitrary hierarchy. Distinguish no event from setter-then-reset and stale AX publication before choosing a bridge implementation. Current artifacts cannot discriminate those paths. Any candidate still needs hosted same single-tap Std/AX/light/dark plus all downstream existing assertions; grammar/Foundation cannot establish it.

## Screenshots actually inspected and mapping limits

127 exported PNGs,111 unique hashes. Surveyed111 unique thumbnails via four derived contact sheets, then inspected **four original screenshots in detail**: Orca-52,20,21,128. This does not claim full-detail inspection of127, nor unique attachment-name/test ordinal mapping.

- Orca-52 (identical SHA to150) shows Conversation/Message tools expanded, gray/off wide switch, readable label, Reply below; geometry is compatible with the recorded wide snapshot. Identical pixels provide a valid representative, not proof that filename52 is uniquely pre-tap or150 uniquely post-tap. No other full-screen Tools-on candidate appears in the thumbnail survey.
- Orca-20 and128 show Inbox selected, five conversations announced, top rows1/2 visible with lower rows outside the content region. Orca-21 (identical to62/121) shows scrolled Inbox with Sofia/Notes message3 and the next row. These visually support scroll/materialization context; their clocks/layout do NOT uniquely attribute them to test04's failed wait. The raw same-run numeric Reader-list control supplies the stronger reveal evidence.
- No arbitrary ordinal is promoted to an exact failing-test before/after pair. No current after-fix screenshot exists because no fix was made. Full hashes and duplicate groups are in `/tmp/bre457-reading-724-hashes.json`.

## Stop / proposed next scope

Send this evidence and two narrow proposals to ROOT; stop for its correction design/allocation. No push/retry/dispatch, no additional tests or source edits. Preserve e061/fb10 history and current image-job acceptance separately. The previously unproved wide structure is now actual current red; test37 is an actual current pass with its original post-tap5s path, not a source-only claim. Whole native acceptance/all33 remains pending.
