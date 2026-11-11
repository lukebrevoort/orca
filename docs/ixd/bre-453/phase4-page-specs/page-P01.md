# P01 — Mail

## 1. Overview
Primary triage and full-mail recovery on web and iOS. Entry: app launch, navigation, a supported mail deep link or return from P03/P07. Downstream: conversation, search, compose, drafts and mailbox disclosure. Goal: notice important correspondence and correct its importance without managing rules. Covers F01/F05 and TRIAGE/NAV requirements.

## 2. Layout
Desktop: compact navigation beside a flexible mail pane; global search/Compose above or adjacent. Mail pane: account/filter context → Important/All Mail switch → operational state → list. Mobile/native: search/account context → same filter meaning → list; primary navigation and Compose remain reachable. Lists scroll; navigation must not cover the last row. No default auxiliary rule/evidence panel.

## 3. Components
- Primary navigation, global search and Compose use the shared shell contract.
- Permanent Important/All Mail switch has readable selected labels in both themes.
- A row contains contact identity, sender, subject, useful preview, received time and read indication; importance is the only new decision control.
- A labeled Importance control exposes Important/Not important and its account/conversation scope. Removing a conversation choice and broader sender choice are secondary explicit actions; removal explains any inherited sender preference.
- Mailboxes disclosure retains saved views, user-owned spaces and supported optional tools.

## 4. Behavior
Open Important by default under working decision D1; preserve explicit incoming destination/filter links. All Mail is one action away, including empty/error paths. Selecting a row opens the full conversation while retaining source context. Importance changes use the real shared contract, never Move. Broader sender effects require a separate explicit preview/confirmation. Do not mark mail read merely because an importance action is used. In Important, remove a row only after acknowledged Not important; focus moves to a logical surviving row/control, or All Mail when none remains. Selection/bulk actions operate on explicitly scoped targets without widening to unknown senders/accounts.

## 5. State machine
Loading → usable list or truthful error/empty state. A filtered empty state says no important conversations, not no mail. Unreviewed/Not important mail stays in All Mail. Choice idle → saving → committed or reconciliation/conflict/failure. Block repeated mutations on the same owned pending target; preserve other rows and reading. Offline changes do not silently queue as saved. Session/account changes invalidate previous-generation results and receipts.

## 6. Motion
Use shared reduced-motion-aware tokens. Feedback/pending state is immediate. No entry animation may make labels temporarily unreadable or delay keyboard use. Filter changes preserve a useful visual anchor; they do not animate unrelated navigation or flash stale mail.

## 7. Data loading
Fetch bounded authorized pages with importance/provenance/revision supplied by the server. Avoid per-row request fan-out. Search, pagination, cache invalidation and read mutations retain existing generation/cursor contracts. Refresh an ambiguous importance write before another decision; do not infer success from optimistic display. Counts describe their computed scope. Retain older mail while a safe refresh is pending, labeled where necessary.

## 8. Adaptation
Desktop and mobile share meaning, not identical chrome. Collapse navigation into a compact disclosure before squeezing row content. Native keeps platform navigation and accessibility text behavior. Long names/subjects/addresses wrap without hiding importance or read state; account identity remains available. Verify relevant small widths, short heights, zoom and native Dynamic Type.

## 9. Walkthrough checks
Important-empty → All Mail → open unimportant automated receipt → mark Important → verify independent persistence and unchanged placement/read state → return → reopen/reload. Repeat with human Not important, sender-scope confirmation, two accounts sharing IDs, stale/failed/replayed writes, account switch, bulk selection, hidden spaces and Back/Forward. Inspect all changed control states in both themes. Record primary control counts and task steps before/after on the same fixture.

## 10. Micro-interactions
Explain scope before commitment; keep account and target readable in the choice surface. Save feedback is contextual, with guarded immediate Undo and a persistent direct correction path. Successful filtered removal announces its effect accessibly and restores focus. A conflict shows the current choice without erasing the user's intended decision or mutating mail placement.
