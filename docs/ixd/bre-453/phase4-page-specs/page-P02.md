# P02 — Mailboxes and saved-view results

## 1. Overview
Find existing user-owned spaces, collections and saved views without crowding primary Mail. Entry: P01 Mailboxes, supported deep links or management return. Exit: P03 reader, P07 search, P08 edit/create, P09 management or All Mail. Proposed D5 exposure preserves NAV/VIEW requirements and F03/F05; it does not claim the new shell exists.

## 2. Layout
Desktop: compact shell disclosure → named destinations in configured order; result pane: account/view identity → available actions → operational state → scrollable rows. Mobile web uses a disclosure or full list before results; native retains its mailbox menu and navigation stack. Controls and feedback reserve space rather than covering the last row.

## 3. Components
Labeled Mailboxes opener; user names/identity; space/view kind; truthful scoped counts; selected destination; Manage/Edit/Add senders where supported; P01-style rows; pagination/retry; missing/hidden recovery and permanent All Mail entry. Selection uses shared surface-hover/border/ink treatment with readable labels.

## 4. Behavior
Opening/closing the disclosure changes presentation only. Opening a saved view runs its actual definition; it is not provider placement or an importance filter. Retain custom names/order/visibility and supported compatibility links. Reader exit restores source, loaded results and focus. Add senders opens P08's read-only review before explicit save. Distinguish restoring a hidden space from recreating a missing view; All Mail remains reachable in either case.

## 5. State machine
Catalog loading → ready/empty/error; results loading → ready/empty/partial/offline/error/missing. An empty view says no current matches, not no mail. Cached results identify staleness and cannot authorize writes. Account/session/view-revision changes invalidate prior requests and selection; inaccessible owner data clears. Repeated pagination cannot duplicate rows; a stale cursor uses the existing bounded reset.

## 6. Motion
Use shared disclosure/selection tokens and reduced motion. Preserve useful scroll anchors and focus when catalog/results refresh. Never animate another account's old rows through the new selection or delay access to recovery.

## 7. Data loading
Reuse authorized destination/catalog and saved-view result contracts, including account/thread identity, definition revision and cursor ownership. Counts say shown/partial unless a complete matching total is supplied. No per-row network fan-out, preview writes or silent default reconstruction after failed loading.

## 8. Adaptation
Desktop disclosure collapses before compressing useful labels; narrow web stacks result actions. Native supports saved-view results and local visibility but currently disables search inside saved views: explain the scope and offer All Mail/search escape rather than imply scoped search works. Long custom names, web zoom and native Dynamic Type retain identity and selected state.

## 9. Walkthrough
Custom names/order/hidden spaces → disclosure → saved view → long-thread reader → Back/reload; empty/partial/offline/missing view; edit/add senders; stale cursor/revision; delayed account switch and revoked session. Confirm retained mail via All Mail, count wording and no placement/notification changes. Inspect light/dark, keyboard, mobile/native text and global-feedback collisions. These are required future checks, not executed evidence.

## 10. Micro-interactions
Announce the actual destination and result state; disclosure has expanded state and focus returns to its opener. Missing-view copy offers recovery without saying mail was deleted. Edit/remove controls describe view ownership; row actions cannot accidentally select a different account or trigger a neighboring action after refresh.
