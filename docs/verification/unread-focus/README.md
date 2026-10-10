# Inbox unread-Focus acceptance contract

## Before → after

- Old, read Focus (for example Alta Aero) no longer outranks fresh normal mail. It keeps its Focus preference and appears at its date in the timeline.
- Unread Focus and Notify form one newest-first promoted set. Notify keeps its existing notification meaning; it has no extra visual tier.
- Any unread message makes its thread unread. A newly received unread reply or a successful mark-unread re-promotes the thread. Opening and successfully reading it returns it to date order.
- Focus is an Inbox lens: identical eligible Inbox membership intersected with the existing Focus category (Focus + Notify). It does not move mail.
- Explicit destinations, custom Spaces, sidebar structure, manual placement, safety locks, advanced rules, Quiet and Hidden routing remain authoritative.
- Inbox and Inbox-scoped Focus omit provider-archived Gmail threads and explicit moves out of Inbox. All Mail remains available.
- API pages contain one latest representative per Inbox thread, with aggregate unread state. Search may match earlier thread content. Keyset pagination is account-scoped, deterministic, bounded and revision-checked.
- Web and iOS remove attention-category section headings and retain compact attention metadata alongside the timeline. No grouped/pinned design preview is revived.

## Compatibility migration

Migration `0051_focus_is_attention` changes a derived SQL view, not stored message, thread, destination binding, manual placement, or provider-label records. Old implicit Focus/Notify compatibility routing no longer chooses a destination. Such mail now inherits the next explicit placement or Inbox fallback. Explicit placement in a formerly generated Focus/Notify destination remains intact. Quiet/Hidden compatibility routing is unchanged. Routing/mailbox revisions advance so previous snapshots are revalidated.

The parallel TypeScript resolver and routing-state projection follow the same rules. Inbox badge counts share its thread/provider membership predicates. No production migration, merge or deployment was performed for this change.

## Verification and remaining limits

Regression tests were added before implementation and failed for read-Focus priority and duplicate/misread thread rows, web ordering/membership, and alternate resolver consistency. Tests cover multiple accounts, pagination boundaries, old cursor rejection, archived mail, earlier-message unread, new replies, read/unread transitions, Inbox visibility policy, and populated migration upgrades preserving stored placements.

The PR records final commands, exact source commit, independent review results and hosted check links. Native source/tests are statically reviewed on Linux; that is not a native build or XCTest pass. Hosted macOS/Xcode checks remain required. Local cloud Chromium cannot launch because its process-singleton socket creation is denied; DOM contract tests are not screenshot evidence. Outlook sync is currently unimplemented, so no live Outlook folder-sync claim is made.

Completion for review: a draft PR with factual test results, independent review, exact-commit hosted check status, and explicit remaining visual/native limitations. No merge or release authorization is implied.
