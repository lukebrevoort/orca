# P07 — Search and results

## 1. Overview
Find retained mail and recover missed importance decisions. Entry: global/contextual search from any supported surface; exit: P03 reader, originating surface or P08 saved-view review. Covers F03/F05, NAV-02, VIEW and CORE-02. Search scope and Human Signal evidence stay separate from importance.

## 2. Layout
Desktop: return/source context → query and account/scope → labeled optional refinements → result state/count → scrollable rows and pagination. Narrow web stacks refinements; native uses its existing mailbox search/navigation. Search, close and recovery remain reachable with keyboard or short viewports.

## 3. Components
Query input; explicit submit/clear/close; active account/mailbox/collection/evidence labels where supported; real result rows; shown/total wording; load more/retry; All Mail escape; Save as view entry where supported. Avoid exposing unsupported search syntax as a working filter.

## 4. Behavior
Keep the entered query distinct from submitted results; changing scope/query starts a new owned generation. Preserve URL/history-backed web state and safe internal return validation. Reader exit restores query, refinements, loaded rows, scroll and usable focus. Search does not mark results read or write rules. Web Save as view transfers the supported deterministic definition into P08's read-only preview; unsupported criteria are explained before save rather than silently dropped.

## 5. State machine
Idle/entering → loading → ready/empty/partial/error/offline. Empty says no matches in the named scope. Retained older results remain labeled when refresh fails; they cannot masquerade as the latest query. Repeated pagination and stale cursors use existing bounded recovery. Owner/session change cancels or ignores previous-generation results and inaccessible content.

## 6. Motion
Shared search/result tokens and reduced motion; immediate pending feedback without flashing zero results. Preserve query focus and result anchor. Closing only the top search layer restores its real opener and must honor unsaved-writing/authoring guards.

## 7. Data loading
Reuse existing search URL, authorized account/filter, cursor and return-context contracts. Bound pages and avoid per-row requests; counts distinguish loaded results from a complete matching total. No network/provider writes arise from query, preview or result display. An unavailable account/filter cannot silently broaden into all accounts.

## 8. Adaptation
Desktop global search and responsive mobile web share supported scopes. Native currently searches ordinary mailbox surfaces but disables search in saved views; preserve an understandable escape to All Mail and do not claim native global/search-to-view parity. Keyboard, VoiceOver, web zoom and native Dynamic Type retain input, result identity and count labels.

## 9. Walkthrough
Exact/empty/long query, explicit scopes and partial pages → reader → Back/Forward/close; search-to-view preview/cancel; unsupported filter; stale cursor; delayed result after query/account switch; offline refresh and session rejection. Inspect both themes and accessibility/feedback overlap. Compare return context and independent zero-write state; these checks are not yet run.

## 10. Micro-interactions
Announce loading/result changes without reading every row or moving focus. Clear query does not erase unrelated scope without an explicit action. Result labels expose account and actual matching context. No-match copy offers broaden/All Mail explicitly rather than silently widening results.
