# P04 — Drafts

## 1. Overview
Recover saved writing as a primary web/iOS destination. Entry: primary navigation, P15 where supported, or return after closing P05/P06. Exit: the same owned draft in P05/P06 or Mail. Preserve CORE-01 and F02; no new draft persistence system is proposed.

## 2. Layout
Shell and account context → Drafts heading/new Compose → load/recovery status → scrollable draft list. Each row prioritizes recipients, subject, useful body preview and saved time/state. Mobile/native use platform list/navigation and safe-area spacing; utility feedback must not obscure the last draft or Compose.

## 3. Components
Account identity; Compose; draft rows with stable owned identity; attachment indication where real; saved/recoverable/conflicted status where supplied; loading/empty/error/retry. Explicit discard belongs to the existing guarded draft flow, not an unconfirmed destructive list gesture.

## 4. Behavior
Open the existing draft/controller with recipients, pending writing, format and attachments intact. Repeated row activation cannot create duplicate drafts or install an earlier open result. Closing safely returns to the originating list/focus. A draft disappears only after owned acknowledged discard or verified dispatch outcome; a timeout is not evidence it was sent. Empty state offers Compose without asserting unsynced local writing is absent.

## 5. State machine
Loading → ready/empty/error; an available stale list stays visibly stale during refresh. Draft open → recovering/editable/conflict/permission failure under P05. Offline draft access is limited to genuinely available local recovery; do not promise cross-device offline persistence. Session/account change invalidates opens and clears inaccessible writing/list state.

## 6. Motion
Use shared list and writing-transition tokens with reduced motion. Preserve row focus/scroll after return and safe refresh. Do not animate a stale row into another draft's identity or hide recovery behind an entrance transition.

## 7. Data loading
Reuse draft listing, owned local recovery and server revision contracts. Keep local newest writing distinct from older server acknowledgement; never overwrite it from a background list fetch. Refresh after acknowledged mutations without extra provider dispatch. Preserve current generation/account checks for delayed responses.

## 8. Adaptation
Desktop uses the Mail list rhythm; mobile web/native present a single readable list and full writing navigation. Long recipients/subjects and native accessibility text wrap; attachment/state labels remain legible. Native protected local-draft handling remains native behavior, not proof of web storage parity.

## 9. Walkthrough
New/saved/recovered drafts → reopen/reply → close → reload; multiple accounts with similar subjects/IDs; interrupted open; newest local versus older remote draft; failed save/conflict; repeated activation; uncertain send and explicit discard. Inspect both themes, web widths/zoom, native Dynamic Type and feedback overlay collisions. Required verification remains pending.

## 10. Micro-interactions
Rows identify saved state rather than imply delivery. Retry preserves the selected draft/context. Keyboard focus returns to its original row or nearest surviving row after verified removal. Error copy states what writing remains recoverable and the next safe action.
