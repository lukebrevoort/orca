---
name: create-verification-skill
description: Create or maintain an Orca verification skill and feature map grounded in runnable synthetic fixtures.
---

# Create or maintain verification

Adapted from pstack `create-verification-skill` and `maintain-verification-skill`; see `docs/pstack/PROVENANCE.md` and `LICENSE`.

1. Interview the repo: inspect AGENTS, package scripts, CI, fixture CLI, feature map and current harnesses. Identify real user surfaces, launch prerequisites, isolation, selectors and observable side effects.
2. Extend `.agents/skills/verify-orca/` and its map instead of duplicating an existing harness. Keep Launch, Doctor, Drive, Evidence and Cleanup instructions concrete. Choose 3–5 grounded features, each with Sub-features, How to get to it (user POV), Driving it with Playwright, and Gotchas sections.
3. Prefer fixture changes at the established provider boundary; never enable live mail. Keep work confined to verification tooling/docs unless product changes were separately requested. Product regressions are findings, not reasons to weaken assertions.
4. Execute the documented trial from a clean committed source with fresh scratch data; validate exact-commit evidence, inspect screenshots and verify cleanup after both success and a safe induced failure. An unexecuted generated skill is a draft.
5. For maintenance, source-review every map entry, drive every mapped feature, reconcile gaps and report `clean`, `changed` or `blocked`. Missing platform coverage stays explicit. No automatic maintenance schedule is created.
