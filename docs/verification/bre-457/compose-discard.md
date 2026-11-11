# Native P04/P05 identity, metadata and explicit discard

Root approved OptionA from `/tmp/bre457-native-discard-contract.md`, canonical P04/P05 and CORE01. No API wire extension, expectedRevision DELETE, server discard lease or provider atomicity is assumed. This phase is separate from the152-case primary Mail/sender View proof at7f33.

## Identity and draft-row feature gaps

At e061, Compose started with To, had no visible From identity or Discard control, and Draft rows omitted account/body preview/saved time/attachment indicators. These are source-established feature gaps, not executed UI bug reds. Root authorized the new native surfaces. The read-only From label now resolves only pinned draftAccountID plus draftOwnerScope from actual connected accounts; it never falls back to mutable selected accountB or reassigns writing. Pending/unavailable identity stays explicit. P04 rows consume actual local content or returned server fields, actual account lookup, modifiedAt/updatedAt and attachment count. Empty/omitted body text yields no invented preview, and invalid time yields an explicit unavailable label. “Stored in Orca” replaces an unproven provider-sync claim. No new per-row request is added. Standard/AX light/dark native runtime and screenshot inspection are pending.

## Before-implementation store control

`DiscardStoreCases.swift` intentionally attempts a naive integration using the **unchanged existing** generic DraftStore.reserve/remove. It runs on three owned synthetic stores with real raw incomplete recipient text, rich/plain body and an attachment. The cases expect protection from another registered editor, new registration under a discard lease, and an old approved snapshot removing a newer leased snapshot. Existing generic APIs do not promise these discard semantics. There is no exposed Discard UI at this baseline: observed failures will demonstrate why this new feature needs dedicated store/controller guards, not establish an existing user-facing discard bug. No DELETE is invoked by these controls.

The expected allocated set is prior152 plus these3 controls (155 if every earlier precondition reaches). Execution is **pending**; no red/pass count is claimed in advance. Compile the actual existing DraftStore in the Foundation harness, retain its exact source hash, all earlier152 cases and independent actual API/provider evidence, and parse the36 native Swift files. No logical discard implementation or source edits during the frozen run. Do not replace the actual primary/sender red/green receipts with this feature-design control.

## Authorized implementation contract after control execution

Confirmation captures original owner/account/client/local and server IDs plus a visible writing fingerprint containing raw unfinished To/Cc/Bcc, subject, text+HTML and attachments. A synchronous dedicated UI operation freezes edit/attach/format/Send/back-flush/repeat actions. Cancel and await the entire predecessor save chain, then revalidate confirmation and ownership.

Acquire a discard-specific DraftStore lease atomically with the exact current snapshot and no other registered editor; block new editor registration under that lease. Generic reserve is not enough. Checkpoint the latest approved visible writing under the lease, without recipient validation. Any changed snapshot, local write error or identity/generation/client change stops before DELETE. Reject sending/ambiguous/rejected/sent/keyed states. Keep the lease across the network await.

Local-only acknowledgement is exact durable removal. Linked drafts additionally require actual204 and current owned identity/generation/exact snapshot/lease before local removal/dismissal. Every timeout/cancellation/401/403/404/409/502 or stale acknowledgement preserves writing and suppresses stale success;404 is not a receipt. A204 followed by local disk failure reports a partial outcome and retains writing. No new UUID, send-key reset, detach, silent replacement, recipient-validation prerequisite or ambiguous-send replay. Removing one local ID never removes siblings sharing its server ID. Retired snapshots cannot recreate deleted writing.

Existing API DELETE index2199–2244 checks delivery/key before and after provider work but has no revision CAS. The native same-store boundary does not protect a newer cross-device server revision or roll back already-started provider delete/mirror. A GET is never described as atomic. Root specifically chose this limited contract rather than optional server strengthening.

## Required later evidence

Dedicated production store/controller cases must cover held pending save chains, repeated operations, existing/new editor exclusion, newer snapshot/stale old save, local disk failure before DELETE and after204, owner/account/client/generation/lease changes, rich body/incomplete recipients/attachments, ambiguous/keyed delivery0DELETE, all non204 failures and local/server success. Actual native handler, confirmation/default/cancel/disabled/keyboard/VoiceOver and light/dark standard/AX geometry remain hosted Apple gates. No local simulator/full Bun/watch/retry/dispatch/push or live-mail/provider evidence is claimed.
