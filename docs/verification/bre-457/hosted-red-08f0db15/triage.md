# PR313 08f source/artifact triage — no fixes or reruns

Checkout remains clean at `08f0db15fde1ab992eedcd46a49d70af348594dd`. No heavy job, simulator, build, watch, dispatch, retry, push, or repository edit was performed for this triage.

## Identity and complete results

Reading run43032590306/job130563162305: artifact identity `tested_sha=08f0db15fde1ab992eedcd46a49d70af348594dd`, event8864cf636daf39b56ed9c2f47fcad989385130ce, iPhone17/iOS26.4.1/Xcode26.4.1. `Orca-summary.json`: 184 passed, 3 failed, 5 scoped image skips, total192, exit65. All failures are ReaderUITests EarlierMessages AX, HTML AX, LongHTML. Actual test nodes independently show four InboxRecovery tests, NativeViewEditorRecovery, and OrcaUITests04/07/37 Passed. Those prior failure classes are resolved in this execution; full reading acceptance is still failed.

Compose run43032590217/job130563161577: identity declares head08f but `tested_sha=event_sha=8864cf636daf39b56ed9c2f47fcad989385130ce`. That merge object is unavailable locally; its source-tree equality to08f has NOT been verified. `FeedbackLayoutlight`: 0 passed/1 failed; dark:1 passed/0 failed. Both contain ONLY test18. Runner lines193–216 explicitly intend existing test18's recovered-writer geometry, so no phase-selection bug is established. Test43, capture/main/full compose and subsequent gates were NOT reached. Overall exit65.

Root-supplied verified ZIP hashes retained as provenance: reading0695f2b40b1af1d62a84e72f9aa87a8149872d6d0b1a8a7c8400236f236a9c42; compose88022d7bd9d5e83c0cb79bea5e95d7c62ed0d295f88302b12d9f361b2a91d708. Inputs `/tmp/bre457-hosted-{reading,compose}-08f0db15/`: identity, checks, fixture, tests, summaries, outcomes, PNGs.

## Reader EarlierMessages AX — first precondition, not disclosure

Exact line11 is `row.waitForExistence(timeout:20)`, not hittability. Test waits for `.buttons["inbox.message.ios-fixture-message-1"]` after choosing Inbox without any reveal gesture. API fixture returned all five expected IDs including message1 at14:06:19.940Z, while the test was waiting for row1. It never opens the conversation or evaluates disclosure layout. Fixed mailbox controls plus the list introduction/date and AX-sized rows can put row1 outside SwiftUI's realized viewport. A narrowed Button query could also matter; the available failure hierarchy does not establish the element's actual AX type.

No uniquely mapped failure PNG/hierarchy with frames is present in the sanitized export. All twelve1206x2622 phone PNGs were inspected; none shows this AX failed list. Do not claim virtualization alone proven. Next narrow diagnostic: capture Mail-selected state, list/visible viewport, full hierarchy/frames and row any-type/Button counts before waiting; use a bounded reveal inside the actual content viewport, retaining target identity and Mail-selected assertions. Do not extend waiting for a row that may require scrolling.

## Reader HTML AX — navigation changes after first list gesture

API returned all five IDs at14:06:56.933Z. `openHTML` first waits successfully for inbox.list. Row3 is absent, first `list.swipeUp()` begins16.05s and returns16.99s; at18.34s the next swipe cannot find the list. Failure hierarchy shows Drafts selected and drafts.list, with a protected local reply. Thus there is an actual tab transition after the first gesture, not evidence of a missing HTML conversation or server data loss. No explicit app navigation action occurs in this helper between those snapshots.

Default XCTest list-swipe coordinates crossing native tab chrome are plausible, especially when fixed AX controls shrink content. Exact list/tab frames and event coordinates are absent, so a literal tab hit is not yet proven. Need pre/post gesture screenshot+hierarchy, clamped unobscured-list gesture endpoints, and an assertion that Mail stays selected after each gesture. Existing OrcaUITests draft-row helper already derives a bounded content gesture; do not copy an unbounded whole-list gesture or bypass navigation.

## LongHTML — first-open vertical budget, not demonstrated restoration

The failure is on pass1 before any body scroll, Back or reopen. The expected paragraph EXISTS; measured frame `(40,818,270,60)` versus unobscured viewport y116..720. The assertion fails because it is below the reply bar. Later end-of-body, scroll-back and repeated-open assertions are not reached.

All exported phone screenshots were inspected. `screenshots/Orca-103.png` is a contextual standard HTML reader image (not uniquely mapped to this failure): account/attention/importance/subject, sender/date/recipient/details, image consent, Find and wide-content controls precede the HTML heading. The heading starts near the reply bar; the measured paragraph below it is consistent with this layout. The fixture's real HTML starts with h2 then the asserted paragraph. ThreadView initializes expanded entry but does not initially scrollTo it; its only scrollTo paths are disclosure change and explicit contextual jumps. This supports vertical header/control growth as the principal source diagnosis, not a restored old offset. A current failed-view screenshot/frame map is still needed before selecting a product layout change. Preserve the initial/reopen top assertion; do not silently scroll to make its first-open assertion pass or remove it. Any layout correction must preserve sender/subject/account/actions, AX and image consent.

## Compose — prelaunch transport failure; intended geometry partially proven

Light starts14:00:48.515Z, first URLSession task finishes with-1001 at14:01:18.515Z; line1252 fails and test ends34.202s. No app launch/business action is reached. Contrary to earlier GET wording, source test18 begins `setFixtureSending(true)`, which explicitly sends POST capabilities. NSError prints the URL but no method; source binds POST at current08f, subject to tested-merge tree identity above. Helper specifies8s request/10s expectation yet observed completion is30s; cause unproven.

The fixture capabilities handler authenticates, reads request.text, validates booleans, synchronously returns204; it does not await a compose gate. Existing fixture traces cover selected mail routes only, not capabilities, and no received/body-read/response-ready record exists for the failing control. Therefore no conclusion about request arrival or server stall is possible. The same server later handles dark test18 successfully; this rules out permanent unavailability but does not explain the light failure.

All five exported dark PNGs were inspected, including FeedbackLayoutdark-2/-5 showing recovered text, status, Done/Send, Feedback and keyboard. Actual log checkpoints report keyboard and reopened each20 geometry assertions, zero overlaps, then send_requests_delta1/deliveries_delta1. This is real DARK test18 evidence only, not test43/light/fullcompose proof.

Suggested root-owned fixture diagnostic (no implementation here): sanitized received/body-read/response-ready epoch timing for the control route, request method/path only; native helper emits method/path/start/end/error and URLSessionTaskMetrics without token/body; contemporaneous host health and one simulator-side read observation distinguish server availability from simulator transport. Preserve first failure and do not retry-to-green, change timeout or weaken business assertions. Optional lifecycle regression can lock intended FeedbackLayout→test18 mapping, not substitute43.

## Remaining gate

Need actual failed AX screenshot/hierarchy with frames or explicitly instrumented next authorized hosted execution; source/artifact-only triage cannot supply a current green. No product or harness fix is made. Fresh independent reviews and final standard/AX, light/dark native runtime/screenshots remain root gates.

## Compact P03 proposal after user reconfirms D1/D2

Authority: `docs/ixd/bre-453/phase4-page-specs/page-P03.md` sections2/3/4/8 and C06/target rules in phase5. Body owns the primary reading column; details/history are contextual disclosures; importance stays conversation/account scoped and separate from Move. This is a proposal, not an implemented or rendered candidate.

1. Keep native Back/source and Conversation toolbar. Remove the redundant CONVERSATION eyebrow. Put subject first and a compact readable account line immediately beneath it; no clipping or capped AX line count.
2. Preserve a visible44pt conversation-importance action row with readable Important / Not important labels, effective state and pending/receipt availability. Keep the existing safe mutation/Undo/reconciliation semantics and separate exact-sender preview/confirmation. Adaptive wrapping at AX, never smaller labels/targets. Move remains separate in the action menu.
3. Keep sender name AND address readable alongside/under its glyph, with time and a44pt Message details disclosure. Move the verbose Attention explanation plus full To/Cc/Bcc fields into that disclosure; retain actual account and recipient data. Do not turn attention into importance or lose its current meaning.
4. Replace the two permanent pre-body Find and wide-content rows with one44pt labeled Message tools disclosure/menu. Its actions keep Find, Formatted/Plain text and the explicit wide-content setting; presentation remains ordinary reflow by default. This removes redundant vertical controls before every message while retaining keyboard/AX reachability and their real states.
5. Keep explicit image consent/status/recovery adjacent to the body, in normal flow; never hide it behind an automatic load, and never allow appearance or layout measurement to fetch images. Keep full chronological content, earlier-history controls, attachments and current jumps.
6. Preserve the existing safe Reply/Reply all/Forward inset and separate Feedback region. Measure usable content height, not only outer scroll frame. Standard-size acceptance retains first HTML paragraph above Reply on BOTH initial and repeated opens without corrective test scrolling. AX acceptance retains all text/actions with wrapping and bounded content gestures, and verifies real body/end/disclosure reachability.

The proposed savings come from removing the eyebrow and duplicate utility rows and folding explanatory metadata into its existing disclosure, not from reducing typography or targets. Exact savings remain unmeasured until a rendered candidate. Capture header/message/body/paragraph/reply/feedback rectangles and inspect standard/AX light/dark before claiming the first-paragraph budget solved.
