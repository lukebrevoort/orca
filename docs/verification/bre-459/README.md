# BRE-459 — reserve native Feedback geometry

Status: **implementation candidate; complete hosted compose verification and final reviews pending**. Parent owns review and merge approval. BRE-457's wider redesign and PR311's API importance work remain separate.

## Reproduced baseline

Prepared/fetched base: `0182327c5fa36b8d686ed72130d8133ee9b3a1a2`, `origin/integrate/BRE-453-foundation-core` / PR309. Fetch/fast-forward integration found no drift. Original visual baseline remains `a540490efe818ea8f22802548c840b1e3df0c279`, tested merge `b69a87ce5bcecb74194f4e1bf6ff20b6e0fedd91`, identical tree `ebfbe6ffa929bc170dd59c22cd02fca9738685b8`: [original job](https://github.com/lukebrevoort/orca/actions/runs/42966020434/job/130343800003), artifact `ios-simulator-42966020434-1`, `screenshots/OrcaDark-20.png`. [Original inspected PNG](baseline-OrcaDark-20.png), SHA-256 `2b6482fa40e8acb6e5c524d21542ec85abaff158d7dbc15fd33f70c36cadda17`.

The new test-only baseline was genuinely executed:

- Head `b4aa758786511ab145e6807620623138c554cd20`; tested merge `e8f05b26b625b049b5b8a669afeac6dafa882d81`; identical tree `5fe5b503af4d34b468e88c02682cec950cf6c41b`.
- [Hosted job130374715883 / run42975878269](https://github.com/lukebrevoort/orca/actions/runs/42975878269/job/130374715883), retained at `/tmp/bre459-hosted-baseline-b4aa7587`. [Manifest and PNG hashes](hosted-baseline.json).
- iPhone17/iOS26.4.1/Xcode26.4.1. Each theme executed **1 test, 1 intended geometry failure**, exit65. Neither reached the later delivery assertions.
- Per theme: keyboard visible, protected controls **2**, overlapping controls **1**. Feedback `(283.5,490.5,103,45)`; Send `(315,483,69,44)`; intersection **2518.5 pt²**, **82.95%** of Send's3036 pt²; status intersection **0**. Baseline line526 failed: “Feedback must not cover any protected control.”
- [Light conflict](baseline-conflict-light.png) and [Dark conflict](baseline-conflict-dark.png) PNGs actually inspected. Dark includes Apple's swipe-typing introduction. Application geometry above it matches Light. Candidate tests dismiss that specific panel and retain strict keyboard/geometry assertions.

Reader baseline at parent018 visibly covers footer actions in [Light](baseline-reader-light.png) and [Dark](baseline-reader-dark.png), copied byte-for-byte from `/tmp/bre453-hosted-native-images-0182327c/screenshots/{Orca-2,OrcaDark-2}.png` and actually inspected. New reader geometry was **not executed on baseline**: root canceled NativeReader42975878279 and Mailbox42975878271 to free hosted quota. Cancellations are **not passes**. Every candidate suite remains required.

## Root cause and implementation

Each tab previously attached Feedback using a bottom safe-area inset outside its NavigationStack. Reader/composer destinations own separate bottom insets and hide the tab bar. Hosted frames demonstrate their actions and Feedback occupying the same region above the keyboard.

MainView now lays out TabView and a trailing Feedback row as **VStack siblings**. The row consumes real proposed height before navigation/reader/writer layout, remains visible/reachable, grows with the existing Dynamic Type font, and follows keyboard avoidance. No per-destination visibility flags, measured padding guesses or layout-driven network calls. Lists and Settings use the same row; reader footers/jumps and writer actions retain their owners.

Composer fields retain their identities/controller. A native keyboard Done action clears explicit field focus so attachment/recovery controls can be reached with the keyboard down. Added focus state is absent from persisted snapshots. Provider dispatch, revisions, recipients/attachment ownership, screenshot/media consent, capture generation/owner checks, colors and reader content are unchanged.

## Reproducible native demo

Use automatic PR jobs, no redundant dispatch or local simulator:

1. **Fixture Checks / unsigned iOS:** existing test18 runs once per theme in the early gate, retaining both result bundles even on failure. The same strict keyboard-visible, zero-intersection, hit-target and on-screen geometry assertions remain. Real Feedback open/close, unchanged writing, termination/reopen, removed/remaining attachments, original remote version and exactly-one synthetic delivery follow. All remaining unit/media/compose gates remain; later test18 selectors alone were removed to prevent duplication.
2. **New test43:** standard and maximum accessibility text scenarios per theme, with the real UI receiving a **120pt shorter content proposal**. Reader actions before/after scrolling → writer keyboard → Feedback open/close → resumed typing → Home/activate → Done/keyboard down → long attachment target → send. Checks actual frames, keyboard intersections, body, recipients, attachment, exactly-one request/delivery. Short sizing is a DEBUG-only authenticated-loopback fixture seam, not another physical device or proof of arbitrary split-screen sizes. Release sizing is unchanged.
3. **Existing state tests:** new geometry checks in permission retry(14), uncertain reconciliation(15), attachment removal(16), foreground refresh(17), sent-copy standard/AX recovery(32/36), and rich standard/AX recovery(33–35). Original writing/provider assertions remain. Native owner/capture/background unit tests still run. The single-account mobile fixture does not establish a full multi-account UI switch journey.
4. **Native Reader Checks:** test07 checks Reply/Reply all/Forward; test37 checks latest/unread jumps alongside footer actions in scrolled history. Reader and image/privacy suites remain required. **Native Mailbox Checks** also must run because shared shell sizing changes.

Each assertFeedbackClear captures a `bre-459-<checkpoint>` PNG before assertions and logs actual frames, protected/intersection counts and keyboard/protected-pair intersection counts. Button targets must be at least44pt with accessible labels. Successful checkpoints emit the geometry/hit-target assertion count actually completed (`9 + 4 × protected controls + 3 × button targets`); failures do not emit success. Test18/test43 log actual synthetic request/delivery deltas only after their original ledger assertions succeed. Added diagnostics contain fixed checkpoint names and numeric geometry/counts, no writing, recipients, attachment names or credentials.

Exports: FeedbackLayoutlight/dark summaries/tests, their numbered PNGs, later Orca/OrcaDark results, sanitized checks.log and identity.log. Use screenshot contents/test attachments to identify numeric exports. Distinguish actual tested merge from PR head. Setup/compile failure does not verify the fix.

## Evidence boundary and final gate

Baseline actuals: **2 test executions, 2 intended assertion failures, 2 geometry observations, 4 protected-control observations, 2 overlapping-control observations**. No completed baseline delivery is claimed. Candidate native actuals are **pending**: after PNGs, zero-overlap measurements, case/assertion totals and deliveries. Source/local JS checks do not establish native acceptance. PR310 records the exact candidate head and hosted job links.

Full candidate lint/typecheck/test/build runs after committing through `/tmp/orca-ui-heavy-slot.py`, using existing Node24.22.2/Bun1.3.14 and matching-lockfile reused dependencies with worktree-local workspace links. Exit75 means **not started**; no spinning/bypass. PR310 records exact checked SHA, result paths and outcomes. Shell syntax/diff checks are static only.

After hosted execution retain and inspect Light/Dark writer/reader PNGs, standard/AX text and short keyboard-up/down captures. Record actual cases, assertions, protected-control observations, intersections and deliveries. Full compose/media/native unit, reading, images and mailbox suites must run on candidate; parent passes/canceled runs do not substitute. Missing/failing checks or multi-account end-to-end UI evidence remain explicit gaps. Parent performs fresh independent correctness/security reviews and owns merge approval.

Privacy: synthetic loopback fixtures, existing dependencies and unsigned hosted Apple simulators only. No local simulator/Xcodebuild, live mail, credential/access changes, signing, TestFlight, deployment or release. Rollback the implementation commit to product-unchanged `b4aa7587`, retaining its stricter regression; no schema/data migration. Revert the preceding regression commit too only if intentionally restoring original unguarded tests.

## Root final-gate findings at67b20d73

The complete candidate was **not** a pass. [Retained exact outcomes/counts and trace hashes](candidate-67b-failures.json): early conflict/Feedback layout passed one test per theme, but main compose had155passes/four failures and stopped before its later dark suite; reading had163passes/one failure/five scope skips and stopped before its dark supplement. Image and mailbox suites passed separately. The failed first reading attempt was simulator-destination infrastructure exit70; its completed retry reached the actual accessibility disclosure failure. These are distinct failures, not passes or a reason to rerun blindly.

Actual findings: keyboard Done had a36pt accessibility target despite44pt label content; tests14/17 attempted to type through the center of a360pt editor clipped by keyboard/fixed actions; test16 queried a remaining attachment after it fell outside the accessible viewport; and the accessibility history disclosure did not complete its expansion interaction. Logs: `/tmp/bre459-compose-failed-67b20d73.log`, `/tmp/bre459-reading-retry-failed-67b20d73.log`, plus the full downloaded artifacts named in the JSON.

Root follow-up moves Done from the system keyboard toolbar into the existing reserved compose-action row beside Send. The actual button owns its44pt target, and no extra row is consumed. It anchors the history disclosure when older cards are inserted. Regression interactions now require visible writing-area geometry before tapping and explicitly reveal the remaining attachment/disclosure between navigation and fixed actions. They retain original typing, persistence, removal/reopen, original remote version, exact synthetic delivery, label/44pt and zero-overlap assertions. No hidden-control tap or weakened44pt threshold is accepted.

All26 app/unit/UI Swift files syntax-parse locally under the shared resource wrapper (exit0). That is **not** SwiftUI typechecking, an iOS build, XCTest or runtime verification. JS/API/package/lock/CI source is unchanged from67b; existing local full2204-test receipts are scoped to that earlier revision. New exact-head hosted compiler/unit/compose/reader/images/mailbox gates, both themes, actual zero-overlap/keyboard/large-text/short-layout screenshots and independent source review remain required before merge. Follow-up is unverified until those results are retained and inspected.

## Partial hosted result at d3e427e4 and picker readiness follow-up

Head `d3e427e4fc8991354412717d7d5482a39b488d52`, tested merge `ccad40d4b75045fd8202e8c22c4232a36c424e6a`: [compose job](https://github.com/lukebrevoort/orca/actions/runs/42994204378/job/130434571601), [bounded failure log](d3-picker-failure.log), [receipt](d3-picker-failure.json). The ZIP is retained at `/tmp/bre459-d3-failed-native.zip`, SHA-256 `58a8dec0427e6be1896c6346c0a63b87245ea0255efb3b2033a04c1dd513e178`.

Early Feedback layout passed **one test per theme**, including **four completed zero-overlap checkpoints total** (two per theme, 20 geometry assertions each) and one synthetic delivery per theme. Direct capture passed **16 tests**. The later light Feedback media test failed before the main compose and accessibility-size compose suites ran. Those later suites are **not verified**. Mailbox and image jobs passed separately. Reading passed after an isolated retry of a SafeHTML load timeout; the original timeout remains a failed attempt.

The photo lookup retained the result of its first ten-second wait. It extended that wait only if Photos exposed a `Loading...` label. The failure log instead shows no such label, followed by a later snapshot containing `Photo, November 11, 9:36 AM` with the required `PXGGridLayout-Info` identifier. The old expected date was not logged, so this supports a stale readiness observation without proving date injection independently. The candidate rechecks the exact unique fixture-day query throughout the existing 60-second readiness budget and logs the expected day, wait outcome and fresh count. It retains the exact-day/time pattern, uniqueness, stock-photo exclusion, actual picker interaction, two-preview consent and synthetic-ticket assertions. No product layout or hit-target assertion changes in this follow-up.

The branch normally merged main `b23fa0ce72906633af36c54a2140d7599d7aa315` before this fixture change, preserving the published Feedback implementation and foundation benchmark repair. Candidate hosted execution, full compose/media/large-text results and independent final review remain pending. A syntax parse does not establish this picker behavior or native UI acceptance.
