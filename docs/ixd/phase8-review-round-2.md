# Phase 8 Review Round 2 — BRE-307

**Dispatch review**: 44  
**Persona**: `orca-web-review`  
**Initial result**: 1 prior item independently verified; 6 findings open  
**Remediation status**: Complete; awaiting persona verification

## Finding disposition

| Item | Correction | Evidence |
|---|---|---|
| #188 | Tide Table source is now a first-class `draftModel.source`; Glass edits serialize into it, Tide input persists it, rule selection restores it, and New rule creates/selects its own source on both platforms | Interaction tests round-trip custom source through rule changes and assert New rule picker/source coherence |
| #189 | No-access now disables New rule and every Glass edit, makes Tide source read-only, preserves read-only while browsing rules, guards mutation handlers, and ignores Command/Control+Enter simulation or activation shortcuts | Desktop/mobile tests dispatch Ctrl+Enter and Cmd+Shift+Enter and prove the read-only scenario and disabled gates cannot change; agent-browser confirms both actions remain disabled |
| #190 | Rule name, title, priority, revision, source, Trace winner, every visible audit revision, revert label, dialog copy, and confirmed revert result all render from one selected model | Desktop/mobile tests select revision 12, confirm its revision 11 revert, and assert the revision chip, three audit labels, next revert target, and live result together with no hard-coded revision 6 |
| #191 | Mobile tabs implement roving `tabindex`, ArrowLeft/Right, Home, and End; both revert dialogs have `aria-labelledby` and `aria-describedby` | Keyboard interaction tests pass; axe-core reports no serious/critical violations on desktop/mobile with dialogs both closed and open |
| #192 | All visible mobile labels and body copy, including simulation headings and prototype/device chrome, use an 11–12px minimum baseline | Static contract rejects 8px/9px/10px; agent-browser computed-size audit over every visible leaf-text element returns none below 11px at 390px |
| #193 | Both artifacts and the handoff now use the effective final Tidal cascade (`#f7faf8`/`#111a22`, Tidal surfaces, lagoon accent, Sora chrome), including the final light/dark elevation values | Static tests assert both cascades and exact light `0 18px 54px…` / dark `0 22px 64px…` shadows; agent-browser computed properties match production in both themes |

## Verification after remediation

- Focused prototype + axe suite: 27 passed, 0 failed, 204 expectations.
- axe-core: desktop/mobile, dialog closed/open, 0 critical or serious violations.
- agent-browser: no-access mutation attempt preserved source/title/scenario; all authoring controls were disabled/read-only.
- agent-browser: computed Tidal tokens matched the final production cascade in light and dark.
- agent-browser: targeted mobile state-bearing text had no computed size below 11px.

## Acceptance gate

The implementation gate remains closed until the `orca-web-review` persona re-inspects these fixes and resolves review 44.
