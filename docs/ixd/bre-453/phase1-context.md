# Orca foundation direction — BRE-453

Status: product context established; interaction choices and implementation remain pending. This is preparatory work while BRE-448/449/450/451 complete their merge gates. Existing `docs/ixd/progress.json` describes the historical BRE-307 Organization milestone; this directory tracks the November direction independently.

## Purpose and sources

Orca helps Luke notice mail that deserves attention, read every message comfortably, and act with little management overhead. The user explicitly requested a complete application rework following the November Space, after the current UI tickets merge. Existing useful mail behavior, account boundaries, privacy and recovery remain acceptance requirements throughout that rework.

Authoritative direction, read November 10, 2026 Eastern:

- [Product direction](https://chatgpt.com/space/page_6af3ee185e08819195a69ccbd60e1bce), sequence 2.
- [Purpose and Simplification](https://chatgpt.com/space/page_275106778d588191a37931eaa112d91e).
- [Triage and Organization](https://chatgpt.com/space/page_f94fcdb2a79c819196f7f285013c88cb).
- [Work Plan and Decisions](https://chatgpt.com/space/page_b87b72bbb640819187beb51e1180ebae).
- [BRE-453 implementation goal](https://linear.app/brevoort/issue/BRE-453/rework-orca-around-readable-mail-and-simple-importance-driven-triage).

The Space distinguishes confirmed direction from proposed interactions. Historical October/BRE-307 specifications remain evidence and constraints where useful; their completion does not prove this new experience exists.

## Users and scenarios

The primary user is Luke, reading and acting on work, school and personal correspondence across web and native iOS. No additional demographic research is claimed. Two task roles guide the design:

1. Everyday correspondent: quickly notices important mail, reads the full message, replies or returns later, and corrects false importance decisions without understanding rules.
2. Organizer: retrieves related mail through search and saved views, occasionally adjusts account choices or advanced rules, and needs predictable persistence and recovery.

The same person may take either role. Advanced organization should support the first role without becoming a prerequisite for it.

## Core modules and priorities

| Priority | Module | Required outcome |
| --- | --- | --- |
| P0 | Reading | Full, legible messages and recognizable actions across ordinary mail, newsletters and long conversations; honest loading/empty/offline/error states. |
| P0 | Triage and importance | Direct important/not-important correction with visible scope, predictable account-aware persistence and a clear correction path. |
| P0 | Correspondence | Dependable compose/reply, attachments, draft recovery, interrupted/repeated actions and explicit delivery outcomes. |
| P0 | Finding and organizing | Simple retrieval and durable saved views, with all mail and recovery reachable; advanced rules disclosed when needed. |
| P0 | Attention delivery | An explicit important-only interruption policy with honest permission/unavailable states and distinct reminder behavior. |
| P0 | Account and operational trust | Secure isolation, dependable sync/search/recovery, clear account state and measured performance. |
| P1 | Repository simplification | Small verified dead-code/setup cleanup; retention decisions precede historical evidence archival. |

P0 describes completion coverage, not a claim that all capabilities already work. Broader new feature breadth is deferred until this core earns everyday use.

## Constraints

- Platforms: responsive React/Vite web and existing SwiftUI iOS client. Responsive browser checks do not establish native behavior.
- Backend: existing Bun/Hono API, strict TypeScript/shared Zod schemas, Drizzle/SQLite. Reuse supported contracts where their behavior fits; do not disguise routing as importance.
- Design base: existing Orca theme variables, contact identity and readable mail surfaces. Native conventions remain appropriate on iOS. Preserve labeled interactive states in both themes.
- Content/privacy: retain message contents, meaningful tables, quote/link order and attachments; preserve sanitizer, remote-content and account boundaries.
- State: importance, read/reply evidence, saved views, provider placement and notifications must have distinct consequences. Saving a view grants no notification or routing authority.
- Existing work: coordinate PR303 native readability, PR305 bounded cleanup and BRE-438 Summary capabilities. Held PR298 OAuth/migration work remains separate.
- Delivery: reproduce failures, pin exact revisions, inspect before/after screenshots, run relevant full checks, obtain independent correctness/security review, and verify before merging. Every PR includes demos and measured numbers.
- Execution: monitor CPU/memory; serialize heavy local checks and prefer available cloud execution. Native validation uses an owned simulator or hosted Apple runner. Do not interfere with other tasks' processes.
- Authorization: the current goal permits verified merges; releases, production migrations, credentials, live private mail and paid infrastructure retain their applicable boundaries. No new deadline or claim of Gmail replacement is inferred.

## Design challenges

1. Importance has to become a clear, reversible user decision while existing attention/routing concepts remain understandable and compatible.
2. Every message must remain readable despite heterogeneous HTML, long content, attachments and constrained screens.
3. A smaller default surface must retain all mail, saved work and operational recovery.
4. Web and iOS need the same meaning and durable state while using platform-appropriate interactions.
5. Notification eligibility and uncertain evidence must be honest; a visually calm list does not prove the interruption loop is correct.

## Principles

1. The message is the workspace: reading content and the next useful action receive priority over explanatory chrome.
2. Correct a judgment directly: users should understand the scope and consequence of importance changes before applying them.
3. Keep retrieval safe: grouping mail never silently moves it or changes interruption rules.
4. Disclose complexity when needed: deeper authoring and evidence remain available from relevant context.
5. Prove the whole journey: a passing screenshot or narrow fixture cannot establish reliability, privacy or everyday usefulness.

## Reference and visual direction

Gmail is Luke's stated fallback and practical usability comparison, rather than a feature or aesthetic checklist. Orca's approved Tidal work supplies useful identity and theme constraints. The November feedback supplies the simplification criterion: comfortable reading, clear correction and low management overhead.

Direction keywords: quiet, human, warm, readable, precise. Refined typography and restrained identity should make the correspondence memorable; decoration and motion must not compete with reading. Specific navigation and visual values are decisions for subsequent phases.

## Decisions to resolve

The Space leaves primary triage, importance scope and propagation, uncertain ranking, notification policy, default organizational exposure, persisted undo, and real-mail/physical-device acceptance open. Subsequent artifacts must label adopted assumptions and proposals. No automatic learning, precision/recall figures or broad feature deletion is approved by this document.

## Context verification

All required context categories are present: purpose, roles, priorities, constraints, principles and source provenance. The existing repository supplies platform/framework/design-system constraints; the Space supplies positioning and core modules. No additional discovery question is required to establish context. This verifies the brief's completeness only, not any implementation or user acceptance.
