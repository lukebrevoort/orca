# Orca Organization — Visual Direction

**Direction**: Quiet instrument panel. The Organization page borrows Orca’s reading-first calm and makes causality visible through fine structure rather than decorative color.

## 1. Color system

The effective final Tidal `--orca-*` variables in `apps/web/src/styles.css` remain the source of truth. The August 2026 cascade near the end of the production stylesheet overrides earlier compatibility definitions. BRE-307 introduces no new brand palette.

| Role | Light | Dark | Usage |
|---|---|---|---|
| Ink | `#0f2422` | `#edf3f1` | Primary text, selected labels |
| Paper | `#f7faf8` | `#111a22` | Main page and panels |
| Muted | `#5f7470` | `#9cafb1` | Metadata and disabled labels |
| Accent | `#0e9f8a` | `#8fb7ad` | Focus, active evidence, Trace nodes; not compact text |
| Danger | `#b44c42` | `#e7a197` | Error only |
| Warning | `#8a672e` | `#d8bb83` | Conflict/stale only |

No gradients are used. Color occupies less than 10 percent of the page and always carries behavior.

### Accessibility checks

| Combination | Approx. contrast | WCAG AA |
|---|---:|---|
| Light ink on paper | 15.42:1 | Pass |
| Light muted on paper | 4.74:1 | Pass |
| Light accent on paper | 3.15:1 | Pass for focus rings/nodes; do not use as normal-size text |
| Dark ink on paper | 15.65:1 | Pass |
| Dark muted on paper | 7.68:1 | Pass |
| Dark accent on paper | 7.5:1 | Pass |

Selected controls do not place white text on the accent. They preserve ink on a surface-hover background.

## 2. Typography

- Display and body chrome: effective Tidal `Sora` / ui-sans-serif / system UI chain.
- Reader prose: existing `Newsreader` / Georgia chain; Organization does not use reader typography for tool chrome.
- Code: SFMono-Regular / Consolas / monospace for Tide Table only.
- Numerals in simulation and audit use tabular figures.
- Desktop body baseline is 12px–13px; mobile primary control copy is 10px–12px. Long explanatory copy uses at least 15px line height.
- Rule names truncate after two lines on mobile and one line in the desktop library. Tide Table never visually truncates source.

## 3. Iconography

- Use Orca’s existing restrained outline character: 1.5px stroke on a 20px or 24px grid.
- Navigation target: 50px desktop rail and 46px mobile bottom navigation.
- Glass Box edit icon: 16px in a 32px desktop target or a 44px mobile target.
- Icons supplement visible labels for Organization, Simulate, Activate, Trace, Audit history, and Revert.
- No new icon library dependency is required for the prototype; production should reuse the existing Orca glyph system.

## 4. Illustration system

Organization uses diagrams rather than illustrations. Empty and error states use a small rule-chain glyph built from borders and dots, paired with direct copy. There are no characters, mascots, decorative 3D art, or full-page marketing imagery.

| State | Asset direction | Copy direction |
|---|---|---|
| No rules | Four-node rule chain | “Describe what deserves your attention.” |
| No results | Filtered chain | “No rules match this search.” |
| Trace unavailable | Broken trace node | “The explanation did not load. The outcome remains unchanged.” |
| Simulation error | Paused chain | “Draft preserved. Retry before activation.” |
| Revert success | Compensating arrow | “Reverted without rewriting history.” |

## 5. Elevation

- Level 0: page, library, workbench, inspector; boundaries are 1px borders.
- Level 1: Glass Box blocks and simulation surfaces; no shadow.
- Level 2: menus and local popovers; existing Orca subtle shadow.
- Level 3: revert dialog and prototype device frame; `--orca-shadow`.
- Dark mode uses border and surface separation before stronger shadow.

## 6. Radius

- 8px: icon and compact text controls.
- 12px–13px: rule rows, Glass Box blocks, simulation and source surfaces.
- 18px: dialog and prototype window shell.
- 999px: mode switch, statuses, and action buttons.
- Radius communicates hierarchy; the page does not apply one uniform rounded-card treatment.

## 7. Spacing and grid

- 4px base rhythm with 8px, 12px, 16px, and 24px steps.
- Mobile: one content column with 16px page inset.
- Desktop prototype: 1280px × 800px window; 68px Orca rail; 236px rule library; flexible workbench with a minimum 420px width; 292px inspector.
- Production browser grid: 12 columns at 1280px and above. The authoring workbench receives the remaining flexible width.
- Tool content is allowed to fill the available viewport; there is no centered marketing maximum width.

## 8. Page-type annotation and exception table

### Workspace representative — P07 Organization Studio

**Atmosphere**: A quiet, precise control room whose structure explains itself.  
**Background**: Solid Orca paper; no gradient or texture.  
**Chrome**: Existing Orca navigation and title hierarchy. Organization receives a readable, theme-safe selected state.  
**Cards**: Borders and subtle surface shifts, not floating dashboard cards.  
**Primary action**: Simulate precedes Activate spatially and logically. Activate never becomes a high-contrast filled hole.  
**Brand element**: The Glass Box rule chain is the memorable visual—When, If, Then, Because connected as one causality path.

**Desktop differences**: persistent rule library and Trace/audit inspector; hover, focus, keyboard shortcuts, and a revision-aware action bar.  
**Mobile differences**: rule picker, local Trace/Audit tabs, stacked semantic blocks, and a flex action region above existing bottom navigation.

### Visual exception table

| Page | Exception | Description |
|---|---|---|
| P07 Tide Table mode | Typography override | Monospace source editor replaces structured body copy inside the workbench only |
| P07 Conflict state | Color override | Warning token adds a 3px leading border and explicit “Conflict” label |
| P07 Error state | Color override | Danger token adds a 3px leading border and alert semantics |

All other P07 states follow Orca’s standard variables and workspace annotation.

## 9. Dark mode

- Full adaptation; prototypes begin in light mode and expose an explicit theme toggle.
- Production follows the existing Orca system/in-app preference and listens for system changes.
- Dark mode uses Tidal foam `#111a22`, not pure black, and current `#edf3f1`, not pure white.
- Borders strengthen from .12 light alpha to .14 dark alpha; selected surface alpha increases to .09.
- Labels stay ink-colored in selected states. Disabled controls retain readable muted labels at full opacity.
- Windows high-contrast mode should replace subtle alpha surfaces with system canvas, border, highlight, and highlight-text tokens.

## 10. Motion

Principles: purposeful, local, restrained.

| Motion | Duration | Curve | Use |
|---|---:|---|---|
| Hover/focus | 140ms | Orca enter | Surface, border, label |
| Mode or local panel change | 180ms | Orca enter | Glass Box ↔ Tide Table, Trace ↔ audit |
| Overlay entry | 320ms | Orca enter | Revert dialog |
| Overlay exit | 180ms | Orca exit | Revert dialog dismissal |

- Simulation results reveal locally; counts do not roll.
- Activation and revert update status, Trace, and audit without a full-page animation.
- Reduced motion sets transitions to .01ms and removes transforms.

## Verification

- Ten visual dimensions: complete.
- Existing Orca token alignment: complete.
- Light/dark mapping and selected-state legibility: complete.
- WCAG AA critical combinations: pass.
- Prototype lookup: Workspace representative plus three documented exceptions.
- Phase 5 back-fill: complete; no TBD placeholders.
- Status: PASS.
