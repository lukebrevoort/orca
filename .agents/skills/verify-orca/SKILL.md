---
name: verify-orca
description: Launch and verify Orca synthetic compose browser/API journeys with exact-commit evidence and owned cleanup.
---

# Verify Orca

This Codex verification adapter reuses `apps/api/scripts/compose-fixture.ts`, `apps/web/scripts/compose-fixture-e2e.mjs` and the existing evidence exporter. Read the [feature map](features/README.md) before claiming coverage. Source of truth for flags is `python3 scripts/pstack/verify.py --help`.

## Doctor

From the repo root run `python3 scripts/pstack/verify.py doctor`. This is a read-only environment preflight; it does not attach to a running user session or install dependencies. Prerequisites: Python 3.12, git, Bun **1.3.14**, Node **24**, the repo's frozen-lockfile dependencies, and separately provisioned Playwright Chromium plus OS dependencies. A missing prerequisite is blocked, not a pass. Within a trial, launch readiness must be checked before driving the owned fixture.

## Launch

Commit the code you intend to test, then run `python3 scripts/pstack/verify.py trial /tmp/orca-pstack-first-try` with a path that does not exist. The CLI owns the whole lifecycle: clean `git archive HEAD` scratch checkout, existing dependency reuse, production build, fresh SQLite fixture on loopback and fresh browser profile. It tests committed HEAD, not uncommitted product changes. No live OAuth or mail credentials are needed. This is source/data isolation, not a hermetic dependency installation.

## Drive

The trial drives the existing compose e2e harness in light and dark themes. User actions enter through UI controls; `/v1/drafts` and the fixture's synthetic delivery ledger independently verify persistence and provider calls. Fixtures replace the external provider boundary, so “sent” means a synthetic delivery, never Gmail delivery. Read `features/*.md` for selectors, preconditions and assertions. Do not weaken failing scenarios or use a different surface as proof.

## Evidence

Record `git rev-parse HEAD` before the trial and run `python3 scripts/pstack/verify.py evidence /tmp/orca-pstack-first-try --commit <full-tested-sha>`. Supply the actual 40-character SHA in place of the placeholder. Preserve sanitized logs, manifest/hashes, browser scenario results and PNG screenshots after cleanup. Validate the exact tested commit, not merely a patch-id. Inspect screenshots for visible labels and expected state, and inspect failure logs before claiming success. Failed trials remain failures even when they produced screenshots. The evidence command checks integrity/provenance; its output is not a new product execution.

## Cleanup

The trial owns cleanup on success and failure: stop only processes it started and remove only its scratch checkout/database/profile. Evidence remains at the requested path. Never kill by process name, attach to the user's browser, remove another task's artifacts, or reuse an existing evidence directory. If interrupted by a non-catchable kill, inspect owned scratch metadata and process identity before manual recovery; do not use blanket `pkill` or directory globs.

## Other surfaces

Hosted `.github/workflows/fixture-checks.yml` already exercises browser/API and unsigned iOS compose. `.github/workflows/native-reader.yml` covers native reader on its path triggers using hosted macOS/Xcode. Use those runs' exact source SHA and artifacts when relevant; don't redundantly dispatch jobs. A Linux trial does not run native checks. Search/performance and long-thread reader work need their existing dedicated harnesses; this integration does not duplicate their benchmarks or claim their evidence.
