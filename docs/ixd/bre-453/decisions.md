# Working implementation decisions

These decisions implement the user's authorized November goal. They are engineering/product defaults proposed by the coordinator, not claims of earlier Luke approval. The optional A/B preference remains open to steering. Compact interactive alternatives were shown in the thread; both themes and desktop/mobile layouts were inspected. Implementation has not begun.

## D1 — Primary entry

Use option A: open Important within Mail. Keep All Mail permanently one action away, with a clear empty-state route to reviewing all retained mail. Search and Compose remain global; Drafts stays primary. Preserve incoming deep links and source-list/search return context. Important filtering never removes mail from storage or changes its provider placement.

## D2 — Correction scope

The default correction applies to one conversation in one connected account, including later incoming messages in that same conversation. Offer a separate, explicitly confirmed sender choice for existing and future conversations from that exact address in that account. Explain that conversations with their own explicit choices keep those choices. Preview broader consequences without changing data. Do not infer importance from human authorship or reuse the destination Move endpoint.

Resolution is explicit conversation choice, then an explicit account/sender choice, then Unreviewed. Unreviewed is distinct from Not important. Existing attention/destination rules remain their own supported concepts and are not silently renamed, deleted or converted into importance rules. No AI learning or automatic sender rule is implied by a conversation action.

Architecture review compared conversation-only choices with optional exact-sender inheritance. The coordinator retains the separately confirmed sender option because avoiding repeated triage of future conversations supports the stated everyday-email goal. This adds internal resolution work; it must not add a rule editor to the ordinary correction path. Without a conversation override, evaluate distinct inbound participants in that account: any explicitly Important participant makes the conversation Important; otherwise any Unreviewed participant makes it Unreviewed; otherwise all explicitly Not important participants make it Not important. An empty participant set is Unreviewed. Exact sender choices do not generalize to domains, aliases or another account.

Do not use latest-inbound-sender fallback: a new participant must not silently remove an Important conversation. Broader confirmation must explain that conversations with their own choices keep them, and another Important participant may keep a conversation Important. Provenance names the actual contributing preference(s), not a claimed classifier judgment. Notifications consume the same effective conversation result, including when a new participant replies.

Important retrieval uses the All Mail retention/authorization basis, not the legacy provider-Inbox/destination predicate. Marking an archived or moved conversation Important must surface it without moving it back to Inbox. Query work must remain indexed/batched and its actual costs measured; a bounded response does not by itself prove bounded database work.

Removing a conversation choice means inherit the current sender preference, which may still be Important; explain that before applying the reset. Unreviewed is the effective result when neither explicit level supplies a choice, not a synonym for deleting a choice. Revision guards must retain reset history/tombstones so remove/recreate cycles cannot admit a stale initial write.

## D3 — Uncertainty and discoverability

Only effective Important belongs in the Important filter and qualifies for important-only interruption. Unreviewed and Not important remain in All Mail/search. The empty Important state explains how to make a choice and offers All Mail directly. The interface must never say there is no mail when only the selected filter is empty. No precision/recall or classifier-reliability claim is made.

## D4 — Notification policy

- Make Important-only the supported new policy, enabled through explicit notification intent and actual platform permission. Account choices are visible and owned by the current user/device.
- A fresh unread incoming message must resolve Important before it can enter the important-only delivery path. Human Signal, saved-view membership and placement alone are insufficient.
- Changing an old conversation to Important does not replay a backlog of notifications. Correcting it to Not important suppresses queued and future ineligible interruptions.
- Bound repeated interruptions to one per conversation/account/device within a fifteen-minute cooldown. Suppress additional messages during the cooldown rather than silently promising a later batch. Do not aggregate unrelated conversations into an unexplained summary in this first policy.
- App-specific quiet scheduling is not added by default. Respect platform permission and OS quiet/Focus settings; avoid time-sensitive overrides. State that behavior accurately rather than claiming an unimplemented server quiet-hours scheduler.
- Recheck session, account ownership, device generation, policy, importance and read/freshness eligibility at delivery. Preserve existing bounded retry and duplicate-delivery protections.
- Native background delivery uses the existing APNs integration and synthetic-provider verification. Web notification scope must be explicit: implement and verify the supported open-app/browser path, and label any closed-app/background limitation. Do not claim browser delivery from a stored preference or permission label.
- Manual reminders are a different user-chosen return-time feature. Keep their preferences and resurfacing/delivery explanation separate.
- Preserve legacy notification configuration for compatibility/rollback, but never let an older client update silently downgrade an adopted Important-only policy. Specify and test the upgrade behavior before enabling it in either client.

These are policy defaults, not measured notification usefulness. Real provider/OS delivery and physical-device acceptance require their own evidence before those claims can be made.

## D5 — Organization exposure

Use a compact Mailboxes disclosure for user-owned spaces, saved views and supported optional tools. Keep meaningful names/order and explicit customizations intact. Make advanced Organization available from a clearly named Organize/Advanced entry rather than a prerequisite for triage. Existing Focus, Summary, Later, collections and rule surfaces keep their actual meanings and compatibility links. Any changed default exposure is reversible; user data and saved definitions are never deleted by navigation simplification.

## D6 — Correction and undo

Directly changing a choice remains possible after reopening/reloading. Provide a guarded immediate Undo receipt for the last acknowledged mutation; it may restore only the exact revision it owns. Reconcile ambiguous responses before presenting a successful save or enabling an unsafe replay. A newer change prevents stale Undo. Do not represent this transient receipt as a durable global history or persisted general undo system.

## D7 — Acceptance cases

Engineering evidence covers responsive web at 320/390/760/1024/1440 where relevant, both themes, keyboard/focus and all changed control states. Native evidence covers standard and accessibility text, light/dark, appropriate fixture suites, account switching and interruptions. Representative fixtures include human plain text, quoted/forwarded mail, GitHub/table-heavy notifications, newsletters, receipts, long threads, attachments and hostile/remote content.

Every final result identifies the tested revision, environment, actual scenario/work counts and limitations. Representative real-mail and physical-device acceptance remain separate from synthetic browser and unsigned hosted simulator results. They must not be invented or used to call the app a proven Gmail replacement. Keep a specific handoff of remaining real-use cases if authorization/data/device access is unavailable.

## Source and risk notes

Source maps found that current web Attention opens Move to space, native has no importance writer, APNs currently follows Inbox/spaces, and browser reminder notification delivery is not implemented. Those findings justify new contracts and honest delivery states. Existing routing/authorship/recovery security contracts remain preservation tests. Held OAuth/migration PR298 is outside this work; changes to the new importance feature must not absorb it.
