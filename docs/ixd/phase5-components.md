# Orca Organization — Component and Token Handoff

**Scope**: P07 Organization Studio for BRE-307. Existing Orca components and variables remain authoritative.

## 1. Design tokens

### Color tokens

Values below are copied from the effective final Tidal cascade in `apps/web/src/styles.css` (the August 2026 definitions near the end of the file override earlier compatibility values). Production remains the source of truth. Organization proposes only one centralized addition, `--orca-warning`, because the production sheet has no semantic warning token yet.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--orca-ink` | `#0f2422` | `#edf3f1` | Primary text and control labels |
| `--orca-paper` | `#f7faf8` | `#111a22` | Page and panel background |
| `--orca-muted` | `#5f7470` | `#9cafb1` | Secondary text and disabled labels |
| `--orca-border` | `#e2ece8` | `#304149` | Dividers and control boundaries |
| `--orca-surface` | `#ffffff` | `#1a2730` | Resting grouped surface |
| `--orca-surface-hover` | `#edf5f2` | `#24353e` | Hover and selected surface |
| `--orca-accent` | `#0e9f8a` | `#8fb7ad` | Focus ring, trace node, active evidence |
| `--orca-accent-soft` | `rgb(14 159 138 / 10%)` | `rgb(143 183 173 / 14%)` | Selected inset ring |
| `--orca-danger` | `#b44c42` | `#e7a197` | Error and failed operation |
| `--orca-warning` *(proposed)* | `#8a672e` | `#d8bb83` | Conflict and stale simulation; add once at `:root`/dark root before implementation |
| `--orca-control` | `#f3f7f5` | `#1b2930` | Disabled/resting control fill |
| `--orca-control-hover` | `#e8f2ef` | `#283b43` | Hover fill for quiet buttons |

### Typography

| Token | Value | Usage |
|---|---|---|
| `--orca-font-display` | `Sora, ui-sans-serif, system-ui, sans-serif` | Page and section titles |
| `--orca-font-body` | `Sora, ui-sans-serif, system-ui, sans-serif` | Navigation, controls, body copy |
| `--orca-font-reader` | `Newsreader, Georgia, serif` | Reader-only content; not used for Organization chrome |
| `--orca-font-mono` | `SFMono-Regular, Consolas, monospace` | Tide Table source and located diagnostics |
| Display | 32px / 36px / 500 | Desktop page title |
| H1 mobile | 30px / 32px / 500 | Mobile page title |
| H2 | 24px / 28px / 500 | Rule title |
| Section | 19px / 24px / 500 | Library, Trace, audit headings |
| Body | 12px / 18px / 500 | Primary compact tool copy |
| Supporting | 10px / 15px / 500 | Metadata and explanations |
| Eyebrow | 9px / 13px / 800 | Section identity and state labels |

### Structure

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | 4px | Tight label/icon gap |
| `--space-2` | 8px | Same-group gap |
| `--space-3` | 12px | Control/card padding |
| `--space-4` | 16px | Standard page inset |
| `--space-6` | 24px | Major section separation |
| `--radius-control` | 8px | Icon and text controls |
| `--radius-card` | 13px | Rule and simulation cards |
| `--radius-panel` | 18px | Device/window shell and dialogs |
| `--radius-pill` | 999px | Mode, status, and action pills |
| `--orca-shadow` | `0 24px 80px rgba(10,10,11,.16)` | Desktop prototype window |
| `--orca-motion-fast` | 140ms | Hover, focus, pressed |
| `--orca-motion-medium` | 180ms | Mode and local content change |
| `--orca-motion-slow` | 320ms | Page and overlay entry |
| `--orca-ease-enter` | `cubic-bezier(.2,.75,.25,1)` | Entry and state reveal |
| `--orca-ease-exit` | `cubic-bezier(.4,0,1,1)` | Exit and dismissal |

## 2. Theme-safe state contract

All labeled interactive controls use the following state mapping.

| State | Background | Border | Label | Other |
|---|---|---|---|---|
| Default | transparent or `--orca-surface` | transparent or `--orca-border` | `--orca-ink` | No elevation |
| Hover | `--orca-surface-hover` | `--orca-border` | `--orca-ink` | Pointer cursor |
| Pressed | `--orca-surface-hover` | `--orca-border` | `--orca-ink` | Translate 1px |
| Focus | current state | `--orca-border` | `--orca-ink` | 2px `--orca-accent` outline, 2px offset |
| Selected | `--orca-surface-hover` | `--orca-border` | `--orca-ink` | 1px inset `--orca-accent-soft` ring |
| Disabled | `--orca-control` | `--orca-border` | `--orca-muted` | Not-allowed cursor, opacity stays 1 |
| Loading | `--orca-control` | `--orca-border` | `--orca-muted` | Label retained with progress glyph |

Selected and disabled states never use `--orca-ink` as a fill with an assumed inverse label token.

Contrast checks use the effective Tidal paper/surface composites. Essential selected labels and compact status metadata use `--orca-ink`; `--orca-muted` is reserved for supporting copy and never carries the only state meaning. Warning and danger copy are paired with explicit words/icons and are not placed on same-hue fills.

## 3. Component specifications

### Rule library row

**Purpose**: Discover and select one stable rule identity.

- Minimum desktop target: 44px; mobile picker target: 44px.
- Props: `ruleId`, `name`, `summary`, `status`, `revision`, `matchCount`, `selected`, `disabled`.
- Keyboard: Up/Down moves; Enter selects; search filtering preserves selection.
- Status uses text plus a dot. Dot color is supporting evidence, not the only signal.
- Long names use two lines before truncation; summaries use two lines on mobile and one line on desktop.

### Authoring mode switch

**Purpose**: Switch representations without changing rule identity.

- Options: Glass Box and Tide Table. Glass Box is default.
- Uses a grouped control with `aria-pressed`.
- Selected treatment follows the theme-safe state contract.
- Switching to Glass Box is blocked only by unparseable Tide Table source; source remains intact and the located error receives focus.

### Glass Box block

**Purpose**: Explain and edit one semantic rule part.

- Variants: Event, Predicate, Action, Reason.
- Content: fixed semantic label, human-readable value, typed projection, edit affordance.
- States: default, hover, focus, editing, validation error, disabled by authority.
- The full block is focusable; desktop edit affordance has a 32px target, while mobile editing uses a 44px sheet trigger.

### Tide Table editor

**Purpose**: Minute source-level editing for technical users.

- Uses the established body surface and a monospace fallback chain.
- Located errors expose line, column, message, expected type, and Glass Box counterpart.
- Source is locally retained on parse or network failure.
- Command/Control + Enter runs simulation; Shift adds activation only when the activation gate is enabled.

### Simulation result

**Purpose**: Prove impact before power.

- Required fields: snapshot revision, evaluated count, affected count, notification count, hidden count, representative samples, conflicts, risk, authority.
- States: loading, simulated, stale, conflict, error, no access.
- Conflict uses warning token plus the word “Conflict”; error uses danger token plus an alert role.
- Counts use tabular numerals. No decorative count-up motion.

### Action bar

**Purpose**: Keep Simulate and Activate reachable without obscuring content.

- Desktop height: 58px. Mobile height: 56px.
- Uses flex layout; never fixed positioning inside the prototype frame.
- A persistent sentence explains the activation gate on desktop. Mobile exposes the same explanation adjacent to the simulation status.
- Activate is disabled for unsimulated, stale, conflicting, invalid, unauthorized, or offline revisions.

### Trace chain

**Purpose**: Explain the complete precedence decision.

- Ordered steps: Safety Lock, Manual Override, winning Rule, Lane Policy, Workspace/Fallback.
- Each step exposes outcome, actor or rule identity where relevant, and reason.
- Missing Trace is an error, never an empty success state.
- Mobile displays Trace as a local tab; desktop keeps it adjacent to authoring.

### Audit history and revert dialog

**Purpose**: Provide append-only accountability and reversible change.

- Audit rows expose revision/change-set identity, actor, timestamp, event, and scope.
- Revert remains labeled in default, hover, focus, disabled, and loading states.
- Dialog width: 360px desktop and 326px mobile. It traps focus, names scope, and explains compensating behavior.
- Confirming revert requires the expected active revision and an idempotency key.

## 4. Responsive mapping

| Breakpoint | Width | Pattern |
|---|---:|---|
| Mobile compact | under 375px | One column; abbreviated supporting copy; full labels retained |
| Mobile baseline | 375px–759px | One column; rule picker; Trace/Audit tabs |
| Tablet | 760px–1023px | Workbench with library drawer and inline inspector |
| Desktop small | 1024px–1279px | Library + workbench; collapsible inspector |
| Desktop baseline | 1280px and above | Persistent library, workbench, and inspector |

- Prototype baselines are 390px × 844px and 1280px × 800px.
- Desktop side regions collapse before the authoring workbench loses its minimum readable width.
- Mobile and desktop share semantic tokens, rule data, state machine, and gate logic; only navigation and spatial arrangement differ.

## 5. Verification

- Structural tokens: complete.
- Color and font values: back-filled from Phase 6; no TBD placeholders.
- P07 components: 8 business components documented.
- Theme-safe states: default, hover, pressed, focus, selected, disabled, loading complete.
- Touch/click targets: 44px mobile and 32px minimum desktop.
- Dark mode mapping: complete.
- Status: PASS.
