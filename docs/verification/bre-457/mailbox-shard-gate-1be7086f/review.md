# Independent correctness and security/privacy review

## Summary and verdict

**APPROVED for the scoped CI/configuration candidate. No blocking correctness or security/privacy findings.** This is approval of the reviewed source and the limited synthetic evidence, not native acceptance, a successful hosted workflow, permission to publish, or a merge/release approval.

Reviewer: fresh independent reviewer agent `/root/review_native_shard_1be`, Reviewer role. The session does not expose an exact underlying model identifier; no model diversity is claimed. No children were spawned. Read AGENTS.md and `.agents/skills/interrogate/SKILL.md`. Review was read-only apart from this external report. No tests, syntax checks, application/runtime execution, Apple commands, network, CI, PR, staging or commits were performed by this reviewer.

Reviewed immutable comparison:

- Base/direct parent: `6cbf4fa5b325c18226b5a057b3fe4aec4b2e6e3e`.
- Head: `1be7086f6525b57b251e0afe0921869fc3566a90`.
- Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`, observed clean at the exact head.
- Actual full `git diff --binary` SHA256 matches supplied patch: `48f7e096fc373ff918d8f3d14e56f49664923f66a53b5bfd787c2bd4b8de2a22`.
- Actual diff contains seven executable/config/test paths and two candidate-specific documents. No product Swift, native assertions, API, web, shared, Tools, project, dependency, or agent-skill changes were found. All seven current source SHA256 values match the supplied immutable inventory.

Intent: split the existing mailbox CI suite into independent light and dark fixture/simulator jobs, keep the existing required aggregate check, preserve every existing selection and default/failure behavior, and add a fixed dark incomplete checkpoint using the existing publication/privacy boundary.

## Findings by disposition

### Act on — none

No concrete blocking source defect or new privacy/security vulnerability identified in this comparison.

### Consider — checkpoint export cost must be measured in hosted acceptance

`apps/ios/OrcaUITests/run-fixture-tests.sh:34` now exports a checkpoint after Dark as well as Light; `scripts/ci/export-evidence.py:236` re-exports every result bundle present. This is intentional, safe, and supplies a useful Dark-only checkpoint. It adds export work inside the unchanged deadline, including for default-both and other successful Dark scopes. The synthetic 30.043-second gate does not estimate real xcresult export cost or prove the 45-minute hosted step will fit. Keep timing/export completion as an explicit hosted acceptance gate; no source change is required on current evidence.

### Noted — evidence and coverage boundaries

1. `scripts/ci/test-ios-mailbox-shards.py:126` checks fixed workflow text and executes the real aggregate shell fragment with synthetic result strings. It does not execute GitHub's scheduler, verify branch protection, cancellation propagation, or hosted job isolation. The actual workflow source is consistent with the intended contract, but those remain hosted checks.
2. `scripts/ci/test-ios-mailbox-phases.py:19`, `scripts/ci/test-ios-mailbox-shards.py:65`, and `scripts/ci/test-evidence-checkpoint.py:181` execute extracted actual production blocks against mocks. This avoids duplicating the changed algorithms and supports shell orchestration claims. It does not execute the full Apple runner or establish UIKit/SwiftUI behavior, light/dark rendering, real test discovery, screenshot acceptance, or native durations.
3. The existing outer-kill test at `scripts/ci/test-evidence-checkpoint.py:221` exercises SIGKILL while default-both Dark is held and preserves completed Light. The new Dark controls exercise production Dark progress/export, failed final export, redaction and attachment rejection. They do not inject interruption at every Dark-only atomic-publication boundary or prove CI cancellation behavior. Killing before atomic checkpoint publication can still leave no checkpoint; that is an acknowledged partial-evidence limitation, not a pass.
4. Candidate documentation explicitly records authoring-time PLANNED/PENDING status. The later external ROOT gate is the execution receipt. The earlier baseline remains capped and incomplete; neither document nor this review upgrades it to a completed passing baseline.

### Dismissed objections, with counterarguments

- **An unselected failure might still determine a singleton result:** main phases are gated at runner lines 272 and 286; selected actual statuses are retained at 280/295 and checked at 311–315, with adoption failures also retained. Unselected phases remain internal zero defaults but are not printed as executed passes. Existing singleton assertions remain intact, and the added selected-success controls reject inherited unselected failures.
- **Default execution could silently become single-appearance or lose fail-fast behavior:** unset appearance resolves to `both`, while an explicitly empty/malformed value is rejected. The default mailbox Light/Dark order and first main failure are retained; non-mailbox main suites still exit on their original failing command (281/296). Single-appearance requests are rejected outside mailbox scope before ingress. Adoption still collects its first failure and runs both by default; the singleton filter at 194 restricts only explicitly selected runs.
- **Dark sharding could drop unit tests or modify test selection:** the entire existing literal selection block has identical base/head SHA256 `eb23fbd7f067fcd0e7abf297fc59867d0a7756faa179e120f9c14dcef9a87d74`. OrcaTests remains in the Light mailbox array only (`run-fixture-tests.sh:161–162`), and the fixed matrix requires Light and Dark. Product test bodies are outside this diff.
- **A successful shard could hide a failed/cancelled shard:** workflow lines 26–29 use fixed `[light, dark]` with `fail-fast: false`, and lines 66–76 preserve the old exact job/check name as an `always()` aggregate depending on the whole mailbox matrix, accepting only `needs.mailbox.result == success`. There is no `continue-on-error`. The shell contract rejects failure, cancelled, skipped and empty values. Real GitHub behavior still requires hosted evidence.
- **Artifact identity could collide or mislabel appearance:** each hosted job receives the fixed matrix appearance at workflow line 36; artifact names include appearance/run/attempt at line 61. Wrapper validation is before fixture or evidence startup (`fixture-check.sh:7–14`), records that allowlisted request at line 60, and forwards it at line 131. Each job retains the existing fresh fixture, private directory, derived data and owned simulator creation. No dynamic appearance is interpolated as shell code.
- **A Dark checkpoint might publish credentials or claim final success:** only the exact second fixed phase is added to the exporter allowlist (`export-evidence.py:308`). It reuses private staging, redaction and exact raw/URL-encoded credential byte scans (`203–263`, `315–323`); no raw xcresult or connection metadata is copied. The phase outcome is controlled static data with `exitCode: null` and `complete: false` (`324–328`), then atomically published. Final export removes an earlier final marker before replacement, scans privately and publishes `outcome.json` last (`312–357`). Existing validated checkpoints survive a later failed export. No new arbitrary phase/path boundary is introduced.
- **Dark-only execution restoring Light means a Light suite ran:** the EXIT appearance reset at runner line 144 is cleanup, not a suite. Initial and post-adoption restoration use Dark for Dark-only runs (145–149, 210–214), and main selection is separate. The reset deliberately preserves the existing cleanup contract.

## Security and privacy assessment

No new hardcoded credential, live-account access, provider side effect, arbitrary command execution, externally controlled artifact path, raw bundle publication, broader permission, or unsafe cleanup deletion is introduced. Workflow permissions remain `contents: read`; checkout remains pinned to the PR head with credential persistence disabled. Wrapper `.env` exclusion, `umask 077`, generated owned work directory, fresh evidence directory, simulator ownership, fixture shutdown and deletion are unchanged (`fixture-check.sh:16–55`, `79–109`). The runner still injects the synthetic bearer privately into the copied xctestrun (`run-fixture-tests.sh:104–127`). Fixed progress markers use the separate descriptor; raw output stays private until sanitized export (`27–37`, wrapper `130–132`). Hosted-only crash/container diagnostics retain their original ownership and environment checks (`export-evidence.py:156–200`).

The existing exporter and cleanup boundaries were read, not inferred solely from tests. This is a targeted static security/privacy review; it does not assert exhaustive repository-wide security or proof against malicious source code on an untrusted runner.

## Evidence inspected and provenance

Read actual retained files, not just claimed exit codes:

- Old receipt `/tmp/bre457-mailbox-appearance-red-4a0ba775-01/manifest.json` and raw `phase-tests.log`: exact old head `4a0ba775babb8f85988491c6f0ba82933895169f`, raw 124 after 12.009 seconds. Both original singleton regressions actually reached and requested one appearance but invoked both bundles/phases; Dark also returned the wrong selected status 65 rather than 66. Existing four default-mailbox combinations passed. The remaining non-mailbox method was interrupted; no complete old-suite pass is claimed. Raw log hash matches its manifest.
- Current `/tmp/bre457-mailbox-shard-1be7086f-01/manifest.json`, all seven logs and outer wrapper log: exact start/end candidate SHA, clean ending checkout, raw final exit 0, 30.042879584 seconds, no not-started stages, no owned remaining processes. All seven log SHA256 values match the manifest. The manifest's 6,352 before/after input hashes are equal; this was independently inspected as an evidence record, not recreated by rerunning the gate.
- Current raw unittest logs report 5 phase + 6 shard + 11 checkpoint + 25 sanitizer methods = 47 completed methods, all OK and no skips. The phase source inventory expands to 40 parameter invocations: 4 default mailbox + 2 original singleton failure + 2 selected-success + 32 other-scope combinations. Four explicit singleton call/bundle/status observations are visible in raw output; the other parameter counts are established by the unchanged loops and successful method completion, not 40 separately printed observations.
- Lifecycle raw log enumerates four synthetic scopes (`all`, `notifications`, `mailbox`, `compose`), each pass true, with default two-adoption/two-main installation isolation where applicable. Both syntax logs are empty and their manifest stages record exit 0. These were produced by ROOT's gate, not this reviewer.
- Base/head diffs confirm the four old phase test method bodies, including both original singleton failures, and seven old checkpoint method bodies are untouched. The only old helper adaptations are the allowlisted checkpoint argument and clearing inherited appearance; additions extend coverage without weakening the old assertions.

## Residual gates and delivery boundary

Before native acceptance, require the authorized exact-head hosted run to show both actual appearance jobs, the preserved required aggregate, distinct sanitized artifacts/identity, the intended real XCTest suites and Light-only units, successful owned cleanup, and actual per-shard duration/export fit within the unchanged deadlines. Retain real Light/Dark and standard/accessibility results and inspect required screenshots. Existing native failure/after-shot and Foundation acceptance gates remain as recorded by the owner; this source review does not close them. No deployment, release, merge, push, or external posting is authorized by this verdict.

No source fixes requested. Any subsequent patch invalidates this exact-head approval for changed code and needs the appropriate fresh verification/review.
