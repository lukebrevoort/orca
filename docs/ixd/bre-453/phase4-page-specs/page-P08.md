# P08 — Saved-view creation and editing

## 1. Overview
Group useful mail through search/selected senders → real read-only preview → labeled refinement → explicit Save. Entry: P07, sender selection or P02/P09 edit; exit: saved P02 results or unchanged origin. Covers F03 and VIEW-01–04. This is proposed simplification over existing authoring contracts, not a new rules engine.

## 2. Layout
Scope/source and return → view name → simple criteria/refinement → preview state/count/rows → Save/Cancel and contextual advanced entry. Desktop may place preview beside the form; narrow web/native stack it with a reachable action region. No modal, feedback button or keyboard may obscure Save, criteria or preview content.

## 3. Components
Name; actual account scope; search/sender seed; selected exact addresses/domains where supported; precise narrowing labels; preview/count; retained advanced-filter summary; advanced disclosure; Save/Cancel; conflict and unsaved-leave guard. Use shared readable selected controls and existing validation.

## 4. Behavior
Preview/refinement create no temporary saved object, placement change or notification permission. Positive sender restriction means only selected senders, not exclusion; retained addresses/domains use the actual supported OR semantics and other filters still apply. Existing advanced criteria round-trip unchanged through no-op/simple edits; unsupported edits require explicit advanced handling. Save alone persists the reviewed name/definition and navigation entry with revision protection; repeated Save cannot duplicate it. Adding senders shows current → proposed scope before commitment.

## 5. State machine
Seed/load → editable → previewing → preview ready/empty/partial/error → saving → acknowledged saved or recoverable conflict/failure. A changed definition invalidates older preview authority. Offline/stale data cannot claim a current preview or successful save. Dirty exit offers Stay/Leave; interrupted/repeated navigation retains draft and top-layer ownership. Account/session change rejects old preview/save responses and inaccessible scope.

## 6. Motion
Shared form/disclosure tokens and reduced motion. Keep edits, focus and scroll stable during preview updates. No preview transition may activate Save under a pointer or make old matches look current.

## 7. Data loading
Reuse existing preparation/preview/schema/revision contracts and shared definition serializer. Counts distinguish shown/partial/full matching scope; never infer a total or future sender population from loaded rows. Read-only preview has independently verifiable zero writes. Preserve legacy advanced policy fields without silently enabling/changing them in this simple flow.

## 8. Adaptation
Web supports search- and sender-based starts. Native currently starts simple creation from selected sender; do not claim native search-based creation, general editing or full advanced parity until supported and verified. Native gaps must preserve a safe cancel/return and access to existing views. Long names/addresses, small web widths, zoom and native Dynamic Type keep criteria/actions readable.

## 9. Walkthrough
Search/sender seed → preview/refine → cancel with zero writes → explicit save/reopen/reload; nontrivial advanced no-op round-trip; positive restriction versus future sender; address/domain growth; partial counts; invalid name; failed/stale/replayed save; dirty Back/escape/account switch. Verify unchanged provider placement/notifications and no duplicate views. Inspect both themes, native supported paths and feedback collisions; evidence is pending.

## 10. Micro-interactions
Explain exact scope and unsupported criteria before Save. Pending preview/save has contextual labels; only acknowledgement says Saved. Conflict retains intended edits and offers current-state review. Cancel/guard returns focus to the true opener; removing a sender chip cannot move focus onto Save unexpectedly.
