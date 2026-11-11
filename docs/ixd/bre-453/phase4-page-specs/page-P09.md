# P09 — Manage views and spaces

## 1. Overview
Manage useful names, order, visibility and saved definitions while preserving mail. Entry: P02 Manage, P11/P16 or supported management links; exit: P02 results, P08 authoring, P10 advanced or origin. Covers D5, F03/F05 and NAV-03/VIEW. Reuse established management and recovery rather than duplicate advanced Organization.

## 2. Layout
Account/ownership context → views/spaces and their distinct meaning → management rows → scoped actions and operational status. Desktop retains shell navigation; narrow web/native use a single scrollable management list. Reordering and visibility controls remain reachable without dragging or obscuring final rows.

## 3. Components
Named/kind-labeled rows; supported rename/edit/order/visibility actions; create view; restore hidden space; remove-view confirmation; advanced link; pending/error/retry and unsaved-leave guard where edits are staged. All Mail remains an independent permanent recovery action.

## 4. Behavior
Preserve configured names/order/visibility and distinguish device-only visibility from server-owned definitions. Hiding changes exposure, not mail storage. Removing a view explicitly confirms deletion of that view only; underlying mail remains in All Mail. Space retirement/removal retains its existing distinct mail-impact confirmation and authority contract, not the view-delete promise. Unsupported management actions are unavailable with explanation, never simulated. Dirty navigation uses the shared Stay/Leave guard.

## 5. State machine
Loading → ready/empty/error; staged edit → saving → committed/conflict/failure. Pending operations lock their owned target without freezing unrelated safe navigation. Failure preserves acknowledged data and intended edits; stale/repeated writes cannot reorder or remove a newer object. Missing/retired objects offer recovery; revoked ownership clears inaccessible objects. Offline choices persist only where the existing local preference contract supports it.

## 6. Motion
Shared list/disclosure tokens and reduced motion. Reordering preserves selected identity/focus; provide accessible move controls rather than depend on animation/drag. Acknowledged removal settles focus on a surviving row or heading.

## 7. Data loading
Reuse existing catalog, management revision, navigation-guard and authority-recovery contracts. Avoid reconstructing defaults from failed fetches or overwriting user customization during migration. Refresh changed definitions and invalidate only relevant result contexts; bound retries and reject earlier account generations.

## 8. Adaptation
Desktop web retains broad management/advanced entry; mobile web stacks row actions. Native currently offers mailbox visibility and sender-led creation; general rename/reorder/delete/advanced management parity must be explicitly established before showing controls. Native local choices remain owner-scoped. Long labels, keyboard, web zoom and native Dynamic Type retain meaning and action labels.

## 9. Walkthrough
Configured name/order/visibility → reload → hide/restore; create/edit/remove view while confirming retained mail; supported space retirement and recovery; failed/stale/repeated/reordered save; dirty navigation and account switch. Inspect both themes, accessible reordering and feedback overlay collisions. Assert default disclosure changes are reversible; these future checks are unrun.

## 10. Micro-interactions
Labels say Hide, Remove view or the actual space action rather than ambiguous Delete. Explain local/account scope beside controls. Save acknowledgement identifies the affected object; conflicts retain intended values. Focus and announcements make list changes understandable without color or motion.
