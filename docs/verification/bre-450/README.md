# BRE-450 composer actions

Base: `9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311`. Product commit: `95cc1e87`.

CSS hid List/Quote/Attach text and substituted unrelated clock/arrow/diamond glyphs; a delivery-bar pseudo-element advertised Later without an action. The fix uses visible Bulleted list, Quote, and Attach files labels, matching accessible names/titles, a visible plain-text formatting explanation, and a 2px focus ring. No handler, API, storage, recipient, send or recovery logic changes. Rollback: revert the product commit.

## Reproduction and visual evidence

Owned Vite on localhost:5190, fresh Playwright contexts, `/dev/inbox` demo data, all API/external requests blocked. Bun 1.3.14, Node 24.22.1, Playwright 1.62.1, headless Chromium 151.0.7922.34.

`compose-toolbar-e2e.mjs` failed on the untouched base with **28 visual failures** across light/dark × 390/1024/1440. Actual list and quote DOM insertion, attachment chooser, and text preservation into Zen already passed. Baseline machine results are committed here. The same script passed on the fixed working tree with zero failures; final committed execution is recorded separately below.

Selected before/after PNGs and focus crops are committed beside this file. All six before/after viewport/theme combinations and light/dark focus/hover/pressed crops were visually inspected. Screenshots are illustrative pre-final-commit captures of the identical product source. Full captures: `/tmp/bre450-before/`, `/tmp/bre450-after-draft/`. This is responsive web evidence, not native iOS evidence. Momentary active states are tested; these commands do not represent toggle selections.

## Final committed verification

Run after the evidence commit; the PR handoff records the exact SHA and actual outcomes:

- `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`: `/tmp/bre450-final-{lint,typecheck,tests,build}.log` and `/tmp/bre450-final-checks.txt`.
- `node apps/web/scripts/compose-toolbar-e2e.mjs http://localhost:5190 /tmp/bre450-final`: exact SHA, browser, six cases and failures in `results.json`; screenshots alongside it.
- `PATH=<existing Node24 bin>:$PATH ORCA_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' python3 scripts/pstack/verify.py trial /tmp/bre450-compose-final`: committed archive, owned synthetic SQLite/API/browser, full compose lifecycle. `manifest.json` records exact SHA, hashes, outcome and cleanup. This uses installed Chrome rather than the focused test's headless shell; browser version is in its results. Doctor passed readiness; readiness alone is not a journey pass.
- `python3 scripts/pstack/verify.py evidence /tmp/bre450-compose-final --commit <final SHA>` validates provenance; it does not execute product checks.

No existing harness is weakened. Independent review and final integration gate belong to the parent coordinator; no approval or Done claim. Linear get_issue returned “MCP tool codex_apps/linear.get_issue is not available to the model”, so full ticket/comments and issue-state updates were blocked; supplied acceptance criteria were used. No live mail, OAuth, credentials, sending, release or deployment is part of this work.
