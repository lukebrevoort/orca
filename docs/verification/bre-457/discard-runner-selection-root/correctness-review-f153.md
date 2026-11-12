# Native Primary Mail, sender Views and guarded Discard review

Reviewer: independent Codex reviewer `review_native_primary_discard_correctness_f153`, inherited gpt-6.1-sol/high. Read-only source/evidence review; no application execution, tests, compilation, browser, simulator, source edits, push or external post.

Pinned comparison: `e061c30bde583acb93cefcef63970741e688f562` → `f15310e69f509356c56a95b7b56d84f2e47ede4d`. Read the complete native diff, production callers, API preparation semantics and the dedicated regression fixtures. Intended behavior is explicit submitted-query provenance, one durable View-save/recovery path, visible first-search operational state, truthful pinned From/draft metadata, and OptionA owned discard using the existing revision-unconditional DELETE API.

## Act on

**P2 — The new discard UI test is excluded from both automatic compose phases.** `apps/ios/OrcaUITests/run-fixture-tests.sh:136-137`; the actual test is `OrcaUITests.swift:20-48`.

`test53ExplicitLocalDiscardKeepsUnfinishedWritingOnCancelThenRemovesOnlyConfirmedCopy` exercises the new From label, destructive confirmation, Keep writing, incomplete-recipient/body preservation, acknowledged dismissal/list absence, and unchanged delivery counters. Neither compose `light_tests` nor `dark_tests` includes it. Mailbox explicitly adds50/51/52 but not53; reading/images use other selections. Therefore the configured automatic compose workflow cannot execute this new UI acceptance journey at this head, even if its inherited selected tests pass. The all-scope runner could execute it, but is not a substitute for wiring the normal compose gate.

Add53 to both compose appearance selections and extend the synthetic runner lifecycle checks to require it in each actual compose argv. Preserve every existing test and assertion; do not advertise lifecycle selection as XCTest execution. Root was notified before this report and accepted the narrow verification correction. This is a verification-wiring blocker, not an observed product discard defect.

## Consider

No additional blocking or nonblocking source defect established in this pinned delta. Existing native hosted failures and the missing final runtime evidence below remain acceptance work rather than invented source diagnoses.

## Noted

- **Primary Mail:** `InboxViewModel.swift:20-35` captures only explicit Submit/clear/mailbox intent; routine refresh/page uses that captured query. Requests retain owner/account/generation/cache provenance checks. `InboxView.swift:16-39,95,129-135` now chooses the saved-result versus pending/error search surface using submitted intent, so accepted `resultSearch == ""` does not hide a first submitted search or its recovery state. The operational surface is tested through the same production predicate; this is not SwiftUI rendering proof.
- **Sender Views:** the old parallel mutable preview/retry-key save path is removed from `MailActions.swift`. `NativeSenderViewChooser` supplies selected-message references into the existing `NativeViewEditorController`; prepare resolves actual senders and revisioned existing targets. Real API preparation preserves target identity/advanced clauses. Original command journal/status/original-ID reload remains authoritative, including dropped-response reopen and edits made after Save. No new API protocol is introduced.
- The sender ledger correction is appropriate: the original single lost acknowledgement remains the stimulus. Candidate proof requires two identical pending commands, one retry key, one original object/count, and **no POST after a definitive acknowledgement**, rather than manufacturing another dropped acknowledgement to force three requests. Historical b3 three-request/two-key duplicate evidence remains distinct.
- **Discard boundary:** `DraftStore.swift:157-194` atomically requires the exact current snapshot, its sole registered editor and a dedicated role lease; it blocks new registration for that ID. Generic reserve/save/remove keep their prior semantics. `ComposeSaveSequencing` drains the cancelled predecessor chain. The controller forces a durable checkpoint before network work, keeps the lease across the await, removes only the acknowledged exact local ID, and retains writing on stale identity/snapshot, non204, transport or disk uncertainty. `APIClient.swift:52-75` captures origin/endpoint and rechecks the original operation after credential lookup. Compose synchronously reserves its UI operation, freezes the form and inset actions, and captures raw To/Cc/Bcc plus rich body/attachments. The implementation does not invent cross-device revision CAS, provider rollback, a discard receipt or exactly-once server deletion.
- **From and P04:** From resolves the draft's pinned account and owner; no fallback reassignment to the mutable selected account. Draft rows use existing actual local/server fields for account, optional text preview, saved time and attachment count. “Stored in Orca” avoids an unsupported provider-sync claim. No per-row body fetch is added.
- **Exact final retained evidence:** `/tmp/bre457-discard-candidate-f15310e6/execution.json`, `controllers/manifest.json`, `results.log` and `api-evidence.json` show compile0/runtime0,223/223 assertions,36 grammar checks, runner syntax0, three synthetic lifecycle scopes passing, provider0,27.106s. Independently verified all19 source hashes and three harness hashes against `git show f15310e6:<path>`: no mismatch. I did not rerun these commands.
- Baseline c426167/158pass/9fail is correctly distinguished: six first-saved-search visibility failures and three **unsafe integration controls using old generic store operations**, not three old exposed Discard UI bugs. Candidate role-specific controls plus56 discard cases are separately described. Earlier125 tests remain selected and passed in the retained source result.

## Remaining acceptance limits

The Foundation/controller/API/file-store checks do not execute `ComposeView`, native confirmation hit targets, focus/safe areas, VoiceOver, standard/AX layout, or the new UI50/51/52/53 handlers. Pinned new From/P04/Discard screenshots and both-theme hosted acceptance remain required. Existing e061 compose176/6, reading186/2/5 and missing mailbox timeout artifacts remain separate unresolved results; this patch's Foundation green does not supersede them. Root corrected the exact failure contexts during review: compose35/36 fail an Inbox helper precondition before draft open;16 reaches attachment absence before its later compose-form reveal failure. No cause or fix is inferred here.

Reader/Tools product and `ReaderUITests` bytes, API/shared/web production are unchanged by the reviewed delta. Required native catalog/collections/pins work, full33 acceptance and final integration remain outside this source approval scope.

## Verdict

**CHANGES REQUESTED for the test53 compose gate wiring.** No additional product correctness or introduced authorization defect was established in the reviewed scope. Once the narrow selector/lifecycle correction is inspected and verified, this source review has no other blocking finding. It is not merge authorization or final native UI approval.
