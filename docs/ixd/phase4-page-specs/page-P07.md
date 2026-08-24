# P07 Organization Studio — Interaction Specification

**Ticket**: BRE-307  
**Scope**: Desktop Organization page only. Inbox, reader, composer, Zen Mode, and mobile remain unchanged.
**Status**: Desktop direction explicitly approved. Mobile remains deferred to a separate rebranding milestone.

## 1. Page overview

**Function**: The single control surface for discovering, authoring, simulating, activating, explaining, auditing, and reverting Orca rules.  
**Module**: Organization  
**Upstream pages**: Attention Home and All Mail through the existing Organization navigation item; Thread Reader through “Why is this here?” deep links.  
**Downstream surfaces**: Inline simulation results, Trace, audit history, and revert confirmation. These are panels or overlays, not separate navigation destinations.  
**User goal**: Understand what a rule does, safely change it, prove its historical impact, activate one immutable revision, and recover without losing history.

### Direction lock

- **Glass Box is the default** authoring and explanation mode. It exposes When, If, Then, and Because as distinct shapes in one connected causal diagram.
- **Tide Table is the deep-edit mode** for minute Orca-language work. Switching modes changes representation, not rule identity or semantics.
- The information hierarchy is: rule discovery → authoring → simulation → activation → Trace → audit history → revert.
- Simulation and live execution use the same semantics. A rule cannot activate from an unsimulated, stale, conflicting, invalid, or unauthorized revision.
- Revert creates a compensating change set. History is never rewritten.
- Trace and Audit are hidden by default in a contextual right drawer. Wide-screen users may pin it and Orca remembers that preference.
- Historical simulation remains attached to authoring as a compact summary with expandable evidence; edits mark the result stale immediately.
- Stable shell anchors remain fixed. Focus, Signals, Quiet, Later, and future workflow spaces are user-owned and malleable.
- Mobile is explicitly deferred to its own complete rebranding milestone; the earlier mobile prototype is exploratory and non-authoritative.

## 2. Layout structure

### Desktop

```text
┌────────────────────────────────────────────────────────────────────┐
│ Existing Orca title bar / window chrome                            │
├──────┬─────────────────────────────────────────────────────────────┤
│      │ Page header: Organization · rule count · search · New rule  │
│ Orca ├──────────────┬──────────────────────────┬───────────────────┤
│ rail │ Rule library │ Wide authoring workbench                     │
│      │ Search       │ Diagrammatic Glass Box / Tide Table         │
│ Org  │ Drafts       │ Rule revision + compact simulation          │
│ sel. │ Active       │ Fixed action bar       [Evidence drawer →]  │
│      │ Archived     │                                             │
└──────┴──────────────┴──────────────────────────┴───────────────────┘
```

- The Orca rail establishes the new shell direction. Inbox, Drafts, Organization, and Settings are stable anchors; workflow spaces are reorderable, renameable, hideable, restorable, and eventually user-created.
- The rule library is independently scrollable and preserves the selected rule when filtering.
- The authoring workbench is the focal region. Its mode switch and action bar stay visible while content scrolls.
- Trace and audit remain adjacent to authoring in a hidden-by-default evidence drawer opened by “Explain outcome” or “History.” On wide screens it can be pinned and the preference is remembered.
- At narrow desktop widths, the library collapses first and the evidence drawer remains an overlay. No production content escapes its window container.

### Mobile — deferred, not approved

```text
┌──────────────────────────────────────┐
│ Existing status area                 │
├──────────────────────────────────────┤
│ Organization + New rule              │
│ Glass Box | Tide Table               │
├──────────────────────────────────────┤
│ Rule discovery picker                │
│ Selected revision                    │
│ Authoring blocks / Tide Table source │
│ Simulation result                    │
│ Trace | Audit history                │
├──────────────────────────────────────┤
│ Simulate | Activate                  │
├──────────────────────────────────────┤
│ Existing Orca bottom navigation      │
└──────────────────────────────────────┘
```

This earlier layout sketch is retained only as historical exploration. It is not an implementation contract. The next mobile milestone must begin with a complete rebranding and information-architecture pass rather than adapting this desktop canvas mechanically.

## 3. Component inventory

| ID | Component | Region | Interaction | Key states |
|---|---|---|---|---|
| C01 | Existing Orca navigation | Global chrome | Opens Organization | default, hover, focus, selected |
| C02 | Rule search / picker | Rule discovery | Filters or selects stable rule identity | default, focus, empty, error |
| C03 | Rule row | Rule discovery | Selects a rule without navigation | default, hover, focus, selected, active, draft |
| C04 | New rule | Header | Creates a local draft and focuses title | default, hover, focus |
| C05 | Mode switch | Workbench | Swaps Glass Box and Tide Table representations | default, hover, focus, selected |
| C06 | Glass Box causal node | Workbench | Opens the appropriate structured editor inside a connected When → If → Then → Because diagram | default, hover, focus, validation error |
| C07 | Tide Table editor | Workbench | Edits Orca source with located diagnostics | default, focus, dirty, error |
| C08 | Compact simulation panel | Workbench | Keeps core impact visible and expands representative matches, conflicts, risk, and authority on demand | loading, simulated, stale, conflict, error |
| C09 | Simulate action | Action bar | Validates and runs against historical mail | default, hover, focus, loading, disabled |
| C10 | Activate action | Action bar | Applies the current simulated revision atomically | disabled, enabled, loading, active, conflict |
| C11 | Trace | Contextual evidence drawer | Shows the complete precedence chain and winner; drawer is closed by default and pinnable on wide screens | default, partial, error |
| C12 | Audit history | Contextual evidence drawer | Lists append-only actor/revision/change-set events | default, loading, empty, partial, error |
| C13 | Revert action | Audit | Opens confirmation and creates compensating change | default, hover, focus, disabled, loading |
| C14 | Revert dialog | Inline overlay | Confirms or cancels revert | open, focus-trapped, submitting, error |
| C15 | Scenario control | Prototype shell only | Demonstrates required states | default, simulated, active, conflict, error |

## 4. Interaction behaviors

### Rule discovery and selection

- Typing in search filters by rule name, event, action, and status without changing the selected rule.
- Empty search shows “No rules match” plus Clear search. A workspace with no rules shows “Describe what deserves your attention” plus Create first rule.
- Desktop arrow keys move between visible rule rows; Enter selects.
- A selected row uses `--orca-surface-hover`, `--orca-border`, and `--orca-ink`; selected text never relies on inverse color assumptions.

### Glass Box authoring

- Glass Box loads by default and preserves this order as one left-to-right causal diagram: When → If → Then → Because.
- Each stage has a distinct semantic silhouette: trigger, gate, outcome, and human reason. Connection and shape carry meaning before decorative color.
- Selecting a block opens only that block’s structured fields. Edits create a dirty draft; the last successful simulation becomes stale immediately.
- Each block exposes human copy and its typed semantic projection. Decorative connector lines are not interactive.
- “Because” is required for activated rules because it becomes the human-readable Trace reason.

### Tide Table deep editing

- Tide Table opens the same revision and serializes the same rule. No copy or conversion step is required.
- Located diagnostics connect a line and column to the corresponding Glass Box block.
- Switching back to Glass Box is allowed only when source parses. Invalid source stays preserved in Tide Table and names the blocking diagnostic.
- Desktop shortcut: Command/Control + Enter simulates. Command/Control + Shift + Enter activates only when activation is enabled. Escape closes the current overlay.

### Simulation

- Simulate validates syntax, types, authority, expected revision, and resource limits before evaluating historical mail.
- The collapsed result keeps evaluated scope, affected count, notification count, hidden count, and freshness visible. Users expand representative examples, conflicts, risk, and required authority on demand.
- Simulation never mutates mail or organization state.
- Any edit after simulation marks results stale and disables Activate.

### Activation

- Activate is disabled until the current revision has a successful, conflict-free, current simulation and required authority.
- Activation performs one revision-checked atomic change set. Duplicate submission reuses the idempotency key.
- Success updates revision status, writes audit history, refreshes Trace, and announces the outcome through an accessible status region.
- Revision conflict does not auto-merge. It returns to conflict state and requires refresh, review, and resimulation.

### Trace, audit, and revert

- “Explain outcome” and “History” open the right evidence drawer at the relevant section. The drawer is not visible on first use.
- At wide desktop widths, Pin makes the drawer persistent and stores the preference. Close removes the pin and restores the wide workbench.
- Trace always lists the precedence strata in order: Safety Lock → Manual Override → winning Rule → Lane Policy → Workspace/Fallback.
- Every winner names rule identity, revision, priority, actor, reason, and evaluated snapshot.
- Audit entries are append-only and ordered newest first. Selecting an entry may compare immutable revisions but never rewrites them.
- Revert opens a focused confirmation that states scope and expected effect. Confirm creates a compensating change set, then re-evaluates affected threads.

### Disabled behavior

- Disabled controls remain fully labeled and use theme-safe control, border, and muted text tokens.
- Hover and click do not fire. A nearby sentence explains why activation is disabled; no disabled control relies on a tooltip alone.

## 5. State machine

| State | Trigger | Visual treatment | Available actions |
|---|---|---|---|
| Default draft | Rule selected, current revision not simulated | Glass Box default; Activate disabled | Edit, switch mode, simulate |
| Loading | Rule, simulation, Trace, or audit request pending | Local skeleton/progress in the affected region | Cancel safe requests, navigate back |
| Empty | No rules or no audit events | Specific empty explanation and CTA | Create rule or return |
| Error | Load, parse, simulation, apply, or revert fails | Located inline error; draft retained | Retry, edit, cancel |
| No access | Actor lacks scope or security gate | Required capability and requesting actor shown | Request scope, inspect read-only |
| Partial | Rule loads but Trace or audit fails | Authoring remains usable; failed panel names staleness | Retry failed panel |
| Edit | Glass Box field or Tide Table changes | Dirty marker; prior simulation stale | Save draft, simulate, cancel |
| Simulated | Current revision passes historical simulation | Impact summary and representative sample visible | Activate, inspect Trace, edit |
| Active | Atomic apply succeeds | Active status and new audit entry | Inspect, clone, revert |
| Conflict | Overlap, stale revision, or precedence conflict found | Conflict summary with losing/winning candidate | Resolve, refresh, resimulate |

```mermaid
stateDiagram-v2
  [*] --> DefaultDraft
  DefaultDraft --> Edit: author
  Edit --> Simulating: simulate
  Simulating --> Simulated: valid + authorized + conflict-free
  Simulating --> Conflict: overlap or expected revision mismatch
  Simulating --> Error: validation or service failure
  Simulated --> Edit: change current revision
  Simulated --> Activating: activate
  Activating --> Active: atomic apply succeeds
  Activating --> Conflict: revision changed
  Activating --> Error: transaction fails
  Active --> Reverting: confirm revert
  Reverting --> Active: compensating change succeeds
```

## 6. Motion specifications

- Page entry and mode changes use `--orca-motion-medium` with `--orca-ease-enter`.
- Hover and focus feedback use `--orca-motion-fast`.
- Simulation result enters with a restrained opacity and vertical-offset transition; counts do not animate numerically.
- Activation and revert update only affected regions; the entire application does not celebrate or flash.
- Reduced-motion mode removes transforms and uses immediate opacity/state changes.

## 7. Data loading strategy

- First load requests rule summaries, selected rule revision, active rule-set revision, and compact audit cursor in parallel.
- Rule library and audit history use cursor pagination. Trace loads for the selected rule or selected representative thread.
- Draft authoring is optimistic locally but never marks simulated or active until the server confirms.
- Simulation is keyed by rule revision, workspace snapshot, account scope, and evaluation-engine version.
- Return navigation restores selected rule, authoring mode, scroll position, and unsaved Tide Table text.
- Offline mode permits inspection of cached rules and local draft edits; simulate, activate, and revert remain disabled with an explanation.

## 8. Adaptation, theme, and accessibility

### Responsive behavior

| Width | Layout |
|---|---|
| under 760px | Deferred to the mobile rebranding milestone; no BRE-307 contract |
| 760px–1023px | Rule library drawer; workbench full width; evidence drawer overlays |
| 1024px–1279px | Library + workbench; evidence drawer overlays |
| 1280px and above | Library + wide workbench; evidence drawer overlays by default and may be pinned |

- Desktop minimum review viewport: 1024px × 680px. Prototype baseline: 1280px × 800px.
- The 390px prototype remains historical review evidence only and is not approved mobile direction.
- This is a responsive web surface, not a separate desktop-client window. Multi-window behavior is not introduced by BRE-307.

### Themes

- All states map to established `--orca-*` variables.
- Default, hover, focus, selected, disabled, simulated, active, conflict, and error states are verified in light and dark themes.
- Selected controls use surface, border, and ink tokens; labels remain visible in both themes.
- Error and warning color supplements a text label and icon; color is never the only signal.

### Accessibility

- With the drawer closed, DOM order is navigation → discovery → mode/evidence triggers → authoring → simulation → actions. Opening Trace or History moves focus directly to the drawer Close control; Close/Escape restores the invoking trigger.
- Desktop supports complete Tab/Shift+Tab navigation; dialogs trap focus and restore it on close. The evidence drawer is inert while closed.
- Mode and detail switches expose `aria-pressed` or `aria-selected`; status updates use a polite live region, errors use alerts.
- Desktop controls are at least 32px; primary discovery rows are at least 44px.
- Contrast target is WCAG AA. Reduced motion follows the existing Orca preference and system media query.

## 9. Interaction walkthrough

| Dimension | Passed / total | Result | Notes |
|---|---:|---|---|
| Basic interactions | 5 / 5 | Pass | Feedback, validation, confirmation, reversibility, discoverability covered |
| Page states | 4 / 4 | Pass | Includes cached/offline, restoration, progress, partial failure |
| Navigation and flow | 4 / 4 | Pass | Local panels preserve context and draft |
| Forms and input | 4 / 4 | Pass | Draft retention and located errors specified |
| Data loading | 4 / 4 | Pass | Cursor, freshness key, caching, and local failure boundaries specified |
| Content display | 4 / 4 | Pass | Long copy, empty, unloaded, and sample fallbacks specified |
| Visual and brand | 5 / 5 | Pass | Orca hierarchy, themes, contrast, and restrained color retained |
| Pointer and keyboard | 3 / 3 | Pass | Target size, spacing, drawer focus return, and keyboard alternatives specified |
| Desktop-exclusive | 10 / 10 | Pass | Keyboard, hover, focus, context, resize, pointer drag, Alt+Arrow reorder, persistence, and tooltips resolved |
| Mobile / cross-platform | N/A | Deferred | Mobile is intentionally excluded pending its separate rebranding milestone |
| **Approved desktop total** | **43 / 43** | **Pass** | No P0 or P1 desktop interaction-spec gaps |

## 10. Micro-interaction specifications

### Simulation completion

1. Trigger: historical simulation completes.
2. Visual change: result region appears; status moves from “Simulating” to “Simulated”; Activate becomes enabled only when conflict-free.
3. Motion: `--orca-motion-medium` and `--orca-ease-enter`; no count-up animation.
4. Feedback: polite desktop status announcement; no sound.
5. Reversal: any edit immediately marks the result stale and disables Activate.

### Activation

1. Trigger: user activates a current simulated revision.
2. Visual change: button enters loading, then status reads Active; a new audit row and Trace winner appear.
3. Motion: affected regions crossfade using Orca content-transition tokens.
4. Feedback: accessible status announcement; no decorative celebration.
5. Reversal: Revert creates a new compensating audit event; it does not animate history backward.

### Safe revert

1. Trigger: user selects Revert and confirms scope.
2. Visual change: modal closes after confirmation; active revision and audit update atomically.
3. Motion: dialog uses existing Orca overlay entry/exit tokens.
4. Feedback: polite desktop success announcement; no destructive sound.
5. Reversal: the compensating change is itself revertible through a later audited action.
