# P16 — Reading and mailbox preferences

## 1. Overview
Adjust comfortable reading and optional navigation exposure while keeping essential recovery reachable. Entry: P11 sections, dedicated reading/attention-view URLs or native Visible views; exit: originating Mail/Settings. Covers READ-01, NAV-02/03 and D5. Preserve useful existing settings and links without treating legacy attention as importance.

## 2. Layout
Scope/title and return → grouped labeled choices → applicable reset/save/status. Desktop may use Settings frame/index; narrow web stacks groups and wraps options. Native keeps Visible views in a navigation stack. Scroll/keyboard/safe-area layout leaves the final choice and return path unobscured by feedback utilities.

## 3. Components
Existing web System/Light/Dark, reader text, spacing and motion choices; reset to system defaults; supported writing/reminder defaults with accurate scope; attention-view visibility/order preferences; native mailbox visibility and unavailable-view choices. Selected controls use shared surface-hover/border/ink labels. Account-owned choices use their real separate persistence/guard contract.

## 4. Behavior
Device reading choices apply under their local storage contract and do not claim account sync. Reader text changes content without silently changing navigation text semantics. Reset restores defined device defaults, not account/provider settings or saved views. Preserve dedicated routes and useful legacy choices; make Important/All Mail meaning explicit. Optional visibility/order changes never hide the only All Mail/search/Drafts/recovery entry or delete data. Reminder defaults remain manual-reminder intent, separate from Important-only notifications; reconcile legacy duplicated defaults explicitly rather than change scope silently.

## 5. State machine
Local ready → changed/applied or honest storage limitation; server-owned preference load → editable/dirty/saving/saved/error/conflict with existing safe-leave guard. Catalog loading/failed/missing retains saved visibility instead of replacing it with defaults. Native owner-scope changes reset inaccessible catalogs/preferences and reject prior-generation loads. Offline local changes are supported only where genuinely persisted; never imply a failed server write saved.

## 6. Motion
The motion choice immediately governs future relevant transitions while respecting reduced-motion/system semantics. Use shared preference tokens; no fade leaves selected labels invisible. Changing text/spacing/theme preserves focus and the current reading anchor where supported.

## 7. Data loading
Reuse existing reader preference parser/storage, attention-view settings and native owner-scoped mailbox store/catalog contracts. Native currently allows All Mail visibility to be disabled: the proposed permanent recovery contract requires a separately verified retained entry or guard, not a claim current code already guarantees it. Failed catalogs cannot broaden scope or delete saved definitions. No provider write follows a device display choice.

## 8. Adaptation
Desktop/mobile web retain all supported dedicated preference routes and wrap labeled choice groups. Native currently exposes local mailbox visibility; web reader-choice parity is not established, and native Dynamic Type/OS appearance remains a distinct platform behavior. Verify standard/accessibility text and both themes, including unavailable-view labels, reset and selected/disabled controls. Responsive web alone does not prove native readability.

## 9. Walkthrough
Every supported choice → reopen/reload; System appearance change; reduced motion; text/spacing with a long reader; reset; hidden/missing view/catalog failure; owner switch; web legacy route compatibility and dirty server-choice exit. Verify permanent recovery despite hidden optional views and truthful reminder/default scope. Inspect light/dark, web zoom/narrow/desktop, native Dynamic Type and global-feedback collision. All checks remain pending.

## 10. Micro-interactions
Scope labels distinguish immediate device changes from account Save. Choice descriptions explain the actual effect; focus and selected state never rely on color alone. Unavailable saved views remain identifiable/removable where supported rather than disappearing silently. Reset and visibility feedback describe what changed without saying mail or provider state changed.
