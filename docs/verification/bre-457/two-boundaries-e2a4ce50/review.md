# Code Review: BRE-457 native Settings identity and compose footer boundaries

## Summary

**APPROVED WITH COMMENTS for the new two-file source delta only. No blocking correctness or security finding.** Removing the ancestor Settings identifier addresses the concrete identifier override shown in the retained failure hierarchy. Collecting the two actual permission-label descendants removes the specific ambiguous single-element frame lookup while retaining both occlusion bounds and the existing user-interaction contract.

This is independent static review, not native compilation, UI acceptance, all-33 acceptance, publication, or merge clearance. No candidate runtime result or after-screenshot exists in the reviewed evidence.

## Identity, intent, and scope

- Reviewer: fresh independent combined correctness/security reviewer `/root/review_native_boundaries_e2a`. Actual runtime model identity was not exposed; no claim of model diversity.
- Worktree: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`.
- Full comparison: `99556ddeca231f73e5f69d76ecb09842407c2a90..e2a4ce5071c66bc2fbb4f38318457f63821c4b98`. HEAD is exactly the candidate and the worktree was clean.
- Intent: preserve Settings child control identifiers; safely collect actual permission-footer components for test stimulus geometry and failure diagnostics. Preserve Compose production, permission and Send policy, all assertions, deadlines, gesture budgets, and immediate caller typing.
- Reviewed local AGENTS and `.agents/skills/interrogate/SKILL.md`, full patch and JSON manifest, both complete `/tmp/bre457-{mailbox,compose}-724-triage.md` reports, retained evidence README, relevant callers and production source, raw first-failure log excerpts, and prior raw writing-area geometry.
- Actual diff: SettingsView 1 insertion/1 deletion; OrcaUITests 40 insertions/4 deletions. Source SHA256s and patch SHA256 match the manifest. `git diff --check` was clean. These are read-only source checks, not tests.
- Confirmed no diff from this base in Compose, Core, ViewportGeometry, ReaderUITests, native unit tests, or Tools. Only these two Swift files differ from `64b3308a2fb79a149f08f23a06f7578e85a35b3a`. ReaderUITests is also unchanged from actual 724.

## Severity levels

CRITICAL blocks source approval; WARNING should be addressed; SUGGESTION is optional; PRAISE records a sound choice. Interrogate dispositions below distinguish actions from evidence limits.

## Findings

### CRITICAL

None.

### WARNING

None in this source delta.

### SUGGESTION / Consider

1. **Keep the zero-match observation distinct from proven permission absence** — `apps/ios/OrcaUITests/OrcaUITests.swift:1415`.
   - Zero matches is a legitimate branch: production renders the Label only when `sendPermissionGate.guidance` is non-nil (`ComposeView.swift:216`), and granting Send yields nil guidance (`ComposeView.swift:447`). This shared focus helper is used by granted and read-only scenarios. Requiring two nodes unconditionally would break legitimate callers.
   - The empty array passing `allSatisfy` is therefore intentional. It does not itself prove that a visible footer was absent rather than missing from AX. The baseline also filtered absent permission elements; this patch introduces no new absence bypass or assertion removal. Test14 still asserts the refresh action and disabled Send, and retained read-only test05 asserts guidance existence.
   - No source change requested. In hosted evidence, explicitly show count=2 and both component frames for the actual read-only 14/17 boundary, and a genuine count=0 granted case. Do not describe generic zero-match success as proof of permission-banner correctness.

### PRAISE / Noted

1. **Root-cause Settings identity correction** — `apps/ios/Orca/SettingsView.swift:28`.
   - Raw mailbox checks at 5883 and 5957 show visible Settings section, Mailbox, Writing choices, and Visible views buttons all exposed as `settings.root`. The only product edit removes that broad ancestor identifier. Explicit `settings.section`, `settings.visible-views`, save/discard, field, and notification identities/actions remain intact. Repository search found no remaining `settings.root` consumer requiring a replacement marker.
   - Counterargument retained: source reasoning does not prove the resulting native Picker element type, unique reachability, or later save/leave/adoption behavior. Those remain hosted checks.

2. **Ambiguous query removed without choosing an arbitrary match** — `OrcaUITests.swift:1412` and `:1452`.
   - Raw compose checks at 7179 and 7674 independently show exactly an Image and a StaticText with the same permission identifier. Both failures occur while resolving the original footer frame, before body tap/type. Teardown then repeats the same ambiguous query and aborts diagnostic collection.
   - The new helper accepts only zero or exactly two matches, rechecks returned count, verifies the constant identifier and exact one-image/one-static-text shape, and uses individually index-bound elements. Unexpected count/type/identity causes an explicit test failure and return. Each present rectangle must be finite and nonempty before geometry use. No title matcher, hidden marker, or firstMatch workaround was added.
   - Both component rectangles enter the unchanged fixed-boundary calculation. `ViewportGeometry.content` uses the earliest intersecting component minY, so an icon above the text cannot be silently discarded. Strict >=44-point writing width/height, original 12 attempts, owned pan geometry, single body tap, and immediate caller `typeText` are unchanged. No second tap, post-tap probe, wait, timeout increase, or content assertion removal appears in the full diff.
   - Counterargument retained: separate AX queries are observations, not an atomic application snapshot. Shape changes between reads may fail the test. That conservative behavior is acceptable here and must not be labeled native compatibility proof.

3. **Failure capture no longer reissues the known ambiguous permission query** — `OrcaUITests.swift:2531`.
   - Capture adds only numeric count/shape metadata and the validated individually bound permission targets. Invalid shape leaves no ambiguous target to resolve. Existing synthetic-loopback output gating, bounded structural diagnostics, and omission of message labels/values/identifiers remain unchanged. Capture remains after original failure or before exhausted-area failure; nothing was inserted between successful body tap and caller typing.

## Security assessment

No new authentication, permission grant, delivery, account ownership, storage, network, subprocess, or filesystem behavior exists in the source delta. Production Compose/auth/Send code is unchanged. Diagnostic additions are constant target names, numeric metadata, and public geometry; they add no message content, addresses, credentials, or arbitrary identifiers. No new credential or cross-account concern found within this narrow scope.

## Evidence and remaining hosted proof / Noted

- Actual 724 evidence proves the earlier failure boundaries, not candidate success. Permission-specific numeric geometry was not retained successfully because the old teardown also threw on the same multi-match query; no missing geometry is invented here.
- Prior raw standard-path geometry at compose checks 11941/11969/11978 rejects a ~43-point intersection and later taps a ~156.33-point intersection. This supports the meaning of the preserved strict geometry; it is not a new candidate result or read-only-footer measurement.
- Run the separately allocated exact-head minimal 44-file grammar check and report its actual scope. This reviewer ran no parse/compiler/test/build/Apple/browser/server/CI/remote operation.
- At this exact candidate, hosted native proof must show Settings child identities and actual original taps, then retain all original persistence/dirty/save/Stay/Leave and adoption assertions. The identity edit alone does not certify all grouped failures resolved.
- Hosted compose 14/17 must reach body tap plus immediate typing and all original failure/upgrade/foreground preservation assertions, with both footer frames retained. Exercise the granted/no-footer path and failure diagnostic output as well. Theme/AX coverage remains native evidence, not inferred from static approval.
- Existing 64b bridge/test04/three UIKit cases still require their separately scoped hosted proof; prior approval/grammar does not transfer runtime acceptance. Search49/50/55, menu41, initial AX43/54, sender10/51, P04 oversized-row stimulus and header readability remain outside this patch and unresolved as recorded. No all-33 or full native gate pass follows.
- Original retained images have no unique failure-to-export ordinal mapping, and no candidate after-shots. No independent screenshot inspection or candidate visual acceptance is claimed by this reviewer.

## Verdict

**APPROVED WITH COMMENTS — scoped source approval only.** No blocking source change requested. Continue to the explicitly allocated grammar and hosted validation gates; publication and merge remain held under ROOT's authorization boundaries. Rollback, if separately chosen, is reverting only source commit `e2a4ce5071c66bc2fbb4f38318457f63821c4b98` while retaining evidence commit `99556ddeca231f73e5f69d76ecb09842407c2a90`; no rollback performed.

Only this external review report was written. No repository edits, staging, commits, child agents, tests, compilation, runtime, remote queries, pushes, or external posts were performed.
