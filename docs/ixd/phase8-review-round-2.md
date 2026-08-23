# Phase 8 Review Round 2 — BRE-307

**Dispatch review**: 44  
**Persona**: `orca-web-review`  
**Initial result**: 1 prior item independently verified; 6 findings open  
**Remediation status**: Complete; awaiting persona verification

## Finding disposition

| Item | Correction | Evidence |
|---|---|---|
| #188 | Tide Table source is now a first-class `draftModel.source`; Glass edits serialize into it, Tide input persists it, rule selection restores it, and New rule creates/selects its own source on both platforms | Interaction tests round-trip custom source through rule changes and assert New rule picker/source coherence |
| #189 | No-access now disables New rule and every Glass edit, makes Tide source read-only, preserves read-only while browsing rules, and guards every mutation handler | Desktop/mobile tests attempt button and source mutations and prove scenario, title, and source do not change; agent-browser confirms disabled/read-only controls |
| #190 | Rule name, title, priority, revision, source, Trace winner, audit event, revert label, and dialog copy all render from one selected model | Desktop/mobile active-selection tests assert the pull-request rule’s title, revision 12, priority 24 Trace, revision 11 revert target, matching dialog, and enabled revert gate together |
| #191 | Mobile tabs implement roving `tabindex`, ArrowLeft/Right, Home, and End; both revert dialogs have `aria-labelledby` and `aria-describedby` | Keyboard interaction tests pass; axe-core reports no serious/critical violations on desktop/mobile with dialogs both closed and open |
| #192 | All state-bearing mobile labels and body copy use an 11–12px baseline | Static contract rejects 8px/9px; agent-browser computed-size audit returns no targeted element below 11px at 390px |
| #193 | Both artifacts and the handoff now use the effective final Tidal cascade (`#f7faf8`/`#111a22`, Tidal surfaces, lagoon accent, Sora chrome), not obsolete early-file values | Static tests assert both cascades; agent-browser computed properties match production in light/dark, including Sora fallback chain |

## Verification after remediation

- Focused prototype + axe suite: 25 passed, 0 failed, 183 expectations.
- axe-core: desktop/mobile, dialog closed/open, 0 critical or serious violations.
- agent-browser: no-access mutation attempt preserved source/title/scenario; all authoring controls were disabled/read-only.
- agent-browser: computed Tidal tokens matched the final production cascade in light and dark.
- agent-browser: targeted mobile state-bearing text had no computed size below 11px.

## Acceptance gate

The implementation gate remains closed until the `orca-web-review` persona re-inspects these fixes and resolves review 44.
