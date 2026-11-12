# Native Primary Mail, sender Views and owned Discard security review

**Verdict: APPROVED for this pinned source delta.** No introduced authorization, cross-account publication or destructive-operation safety blocker found. This is not approval to merge, release, or call the native application accepted.

Reviewer: independent reviewer agent `/root/review_native_primary_discard_security_f153`, Codex/gpt-6.1-sol. Source comparison: `e061c30bde583acb93cefcef63970741e688f562` → `f15310e69f509356c56a95b7b56d84f2e47ede4d`. Read-only review of exact Git objects, relevant existing callers and retained receipts. No tests, compilation, build, browser, simulator, server, source changes, push or external posts were performed by this reviewer.

## Intent and boundary

Keep submitted Primary Mail search separate from unfinished typing; expose the first search from a saved View while pending or failed; reuse the existing durable View editor for selected senders; display the draft's original account and real stored metadata; add explicit confirmed discard with same-store ownership and acknowledged deletion. Option A in `/tmp/bre457-native-discard-contract.md` is the agreed boundary. It intentionally does not add server revision CAS, exactly-once discard, provider rollback or cross-device exclusion.

## Act on

None in the reviewed source delta.

## Consider

No additional source finding requiring a product change. Do not expand this review into unrelated cache-purge or server-CAS work.

## Noted — authority and destructive-operation checks

- `apps/ios/Orca/Compose/ComposeView.swift:254–271,521–550` captures the original visible draft/content/raw recipients/editor/client/origin/session generation, rechecks the confirmation before starting, reserves `.discard` synchronously, and suppresses current UI results if the captured context no longer applies. From identity uses the draft's pinned account rather than silently reassigning writing to the selected navigation account (`:338–352`).
- `ComposeView.swift:210,246,250,442,703–715` disables editing/actions while discarding, hides Back, and prevents transition flushing from writing through the active operation. The existing full predecessor-chain sequencing moved to Foundation without behavioral changes (`DraftStore.swift:334–348`); the discard controller cancels and awaits the current tail before taking the actor lease (`:384–389`).
- `DraftStore.swift:157–194` implements a dedicated role rather than treating generic `reserve/remove` as discard authority. Reservation checks the exact current snapshot and the sole registered editor in one actor turn; `beginEditing` refuses new registrations during that role (`:90–94`). Both checkpoint and removal revalidate the token, editor, current snapshot and permitted delivery state. The durable checkpoint precedes any DELETE, and durable removal precedes mutation of the in-memory collection.
- `DraftStore.swift:196–198` rejects sending, ambiguous, rejected, sent and keyed drafts. `ComposeDiscardContext.permits` binds visible writing, raw unfinished recipients, attachments/body through `DraftContent`, account/local/server identity, editor, client, origin and session generation (`:352–366`). Existing versioned-save logic still prevents a retired local snapshot from recreating its identity (`:200–235`). Generic save/reserve/remove were not globally weakened.
- `APIClient.swift:54–74` captures the destination before suspension, checks the original operation after token lookup, and accepts only HTTP204 as the deletion receipt. The Compose caller and controller recheck context after the network await before local removal. Non204, transport failure, missing/foreign resources and stale ownership do not become success. Existing redirect credential stripping remains unchanged (`:78–84`).
- `DraftStore.swift:390–415` retains writing and releases the lease on failure; a server204 followed by local disk failure is explicitly partial, rather than a fabricated successful discard. Only the reserved local ID is removed, even if another local shadow has the same server ID. Approved Option A's existing server/provider concurrency limitations remain documented and unfixed.

## Noted — search and sender View isolation

- `InboxViewModel.swift:20–35,45–56` separates submitted intent from editable text, uses captured query/provenance for refresh/paging, and retains request-generation/owner/account/cache-key guards. The saved-View branch now follows pending submitted intent (`InboxView.swift:20,95,130–136`), rather than waiting for accepted result provenance before exposing loading/error/retry.
- `NativeViewEditorController.swift:121–165` validates sender reference account scope and prepares updates against a verified current target revision. Existing advanced predicates and current adopted identity remain under the original durable editor; the old parallel mutable-key Save path is removed. Review still rejects edited-during-await previews (`:175–186`), and commit/reconciliation preserves original command, owner/origin/client/account/generation guards (`:188–238` and unchanged remainder).
- `NativeSenderViewChooser` validates loaded message/thread account correlation, current owner/client/selected source account, and presentation lifetime before installing source data (`MailActions.swift:187–207`). It chooses source/target only; save/preview/recovery uses the same guarded editor. Same-user advanced multi-account View targets remain supported rather than being silently narrowed.
- Production API/shared code has no diff in this comparison. The fixture additions are confined to the native Tools runner and synthetic loopback state/ledger controls.

## Evidence inspected

Read `/tmp/bre457-discard-candidate-f15310e6/execution.json`, `controllers/manifest.json`, `controllers/results.log`, `controllers/api-evidence.json` and the production/controller/UI/runner diffs. Independently recomputed and matched **19 source hashes and3 harness hashes** against immutable `f15310e6` Git objects. Retained execution reports compile0/runtime0, **223/223 assertions passed**,36 grammar checks, shell syntax0 and3 lifecycle scopes passing. Parsed all223 result entries as passing. API ledger records provider calls0 and exactly two owned draft deletions (success and held204); missing/foreign probes retain their original records.

The c426 baseline's three unsafe generic-store controls are explicitly feature-integration controls, not a claim that an old exposed Discard UI existed. Candidate tests bind those invariants to the new discard-specific role. The original single lost sender-Save acknowledgement remains injected; candidate replay uses two identical commands/one key and sends no additional POST after acknowledgement. No extra injected failure was used to force an obsolete count of three.

## Acceptance still open

Foundation/controller/API/file and synthetic runner evidence does not execute SwiftUI confirmation, control reachability, From/P04 row layout, new hosted cases52/53, Dynamic Type, or keyboard/Feedback geometry. The retained e061 six compose failures and two reading failures remain real, separate acceptance blockers. In particular, this review does not infer that the new From row fixes or preserves the previously failing44pt writing-area geometry. Current source needs the appropriate hosted UI/screenshots and final root acceptance; no source approval supersedes those gates.

Rollback remains the narrow native client delta/new exposure, while retaining durable drafts and View journals. No migration, API contract change, signing, deployment or merge is authorized by this review.
