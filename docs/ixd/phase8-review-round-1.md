# Phase 8 Review Round 1 — BRE-307

**Dispatch review**: 42  
**Persona**: `orca-web-review`  
**Initial result**: 7 findings; acceptance withheld  
**Remediation status**: Complete; awaiting persona verification

## Finding disposition

| Item | Finding | Correction | Evidence |
|---|---|---|---|
| #175 | Rule discovery, New rule, and Glass Box edits did not share one draft model | Both prototypes now render rule selection, creation, Glass edits, and Tide edits from `draftModel`; every edit calls `markSimulationStale` | Executed Happy DOM interaction tests verify changed content, stale revision metadata, disabled activation, and preserved theme switching |
| #176 | Operational states were underspecified | Desktop/mobile scenario controls now include loading, empty, no-access, partial-load, stale/edit, and offline in addition to the acceptance states | agent-browser exercised all six states in light and dark on both prototypes; every matching panel rendered and activation remained gated |
| #177 | Scenario metadata and gates could drift | One `scenarioModel` now drives status metadata, revision chip, audit event, Simulate/Activate/Revert gates, and `aria-live` copy on both platforms | Interaction tests verify active rule selection updates title/revision/revert/activate together |
| #178 | Invalid selection ARIA | Primary navigation is link-based with `aria-current="page"`; desktop rule rows use `aria-pressed`; mobile details use `tablist`/`tab`/`tabpanel` | axe-core reports no critical or serious violations for either artifact; structural contract tests prevent regression |
| #179 | Mobile controls and type were too small | Every mobile `button`, `select`, `input`, and `textarea` has a 44px minimum target; compact labels/body sizes were raised | agent-browser computed-size audit at 390px found no visible target below 44px |
| #180 | Prototype tokens diverged from production and compact state contrast was unproven | All existing tokens now exactly mirror `apps/web/src/styles.css`; only centralized `--orca-warning` is proposed; essential selected/status metadata uses `--orca-ink` | Primary/essential label contrast is 14.33:1 or better in both themes; component handoff records the source-of-truth rule |
| #181 | Trace omitted Workspace/Fallback | Both prototypes now render the exact five strata in order | Contract tests assert Safety Lock → Manual Override → Winning Rule → Lane Policy → Workspace/Fallback |

## Verification after remediation

- Focused prototype + axe suite: 18 passed, 0 failed, 125 expectations.
- agent-browser: all six added operational states rendered in light and dark on desktop and mobile.
- agent-browser: visible mobile controls at 390px were all at least 44px in both dimensions.
- Updated visual evidence: mobile dark stale edit and desktop dark offline/five-step Trace.

## Acceptance gate

The implementation gate remains closed until the `orca-web-review` persona re-inspects these fixes and resolves review 42.
