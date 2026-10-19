# Thread image metadata regression investigation

- Intent / playbook: bug-fix investigation; reproduce the reported strict reader validation error and make only an evidence-backed change.
- Status: **running** for CI diagnostic verification; Luke confirmed the stale loaded web build caused the email-opening incident and that incident is resolved.
- Updated: 2026-10-19 UTC.
- Owner: `/root`; independent reviewer: `/root/review_diagnosis` (model identity not separately exposed).
- Base: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`; branch `fix/thread-image-load-schema`; worktree `/workspace/orca-image-schema`.
- Final executable/test commit: `6cac95515379392b3bb8c465d28371093f7b8a0b`. Later documentation commits do not change executable files.
- Owned files: new shared thread-image contract tests; existing API image eligibility test now validates the whole wire response. PRs 235/252/253/260/261 excluded.
- Acceptance: a verified current-source failure and narrow repair, or honest diagnosis if current source already accepts the payload. No current-source runtime defect was found; no runtime repair is claimed.

## Findings

### October 19 follow-up: preserve the actual native failure assertion

The initial investigation below is historical. Luke subsequently confirmed the stale loaded web build, so no further user-session investigation is needed. PR262's remaining failure is the dark compose suite in run `39289592093`, job `118186455894`: 16 tests, one failure, exit 65. The exact failed test remains unidentified; `test36SentRecoveryStatusAtAccessibilitySize` explicitly passed. Artifact `12206618685` was prepared successfully but its bytes could not be downloaded here. Supported Library transfer also failed. No denied route was bypassed.

Baseline job `118148632271` in run `39278581139` passed on `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`, with the same reported macOS image and Xcode path. Native app/tests, API fixtures and CI sources were unchanged between that baseline and PR262's `0ba3b7b84e2e7a1076143a74bf1968b19f8f37d1`. This is existing-run comparison, not proof of flakiness or attribution to this patch.

The bounded exporter excerpt matched passing `0 failures` summaries and WebKit noise before reaching real XCTest failures. Its 20-marker budget omitted 265 later markers. Reuse only the assertion-priority hunk and its focused regression test from PR260 executable `ee0ee866d14d199d0d6986e5c1f8a05649cf55cb`, after that owner's final head `92839bd81ebe7df0b97e62560cf25585cb2a5a6a` reached all-green CI and the parent authorized this exact subset. Native helper corrections, search telemetry, reader product changes and workflow changes are excluded.

The diagnostic change prioritizes actual assertions/compiler errors while preserving redaction, the 20-marker budget, line-length limits, full sanitized logs, application assertions and test timeouts. The new regression fails against the prior exporter (11 pass / 1 fail), and all 12 exporter tests pass with the change. See [red](../../verification/thread-image-contract/diagnostic-red.log) and [green](../../verification/thread-image-contract/diagnostic-green.log). Independent review by `/root/review_diagnosis` recommended this minimal subset. This fixes evidence selection only: a subsequent green native run would not identify or prove a fix for the original failure.

No local native execution: this Linux executor has no Xcode; PR260's owner retains exclusive Homebase/native ownership. One push will trigger the existing checks; no manual dispatch or duplicate rerun. Final immutable revision review and automatic CI results are recorded in the draft PR body to avoid a documentation-only push restarting those checks.

The reported error is `unrecognized_keys`, key `imageLoadAvailable`, path `messages[0]`. The source at main accepts the optional boolean in `normalizedMessageSchema` (`packages/shared/src/schemas.ts:346`); `threadDetailMessageSchema` inherits it. Web `fetchJson` parses the thread response with `threadDetailSchema`. API `readThreadDetailSnapshot` both emits the flag and parses its returned response with the same schema. The shared package exports raw TypeScript; there is no checked-in generated schema to update.

Commit `e14aca2ac1eeda51ad02078c62b9021ca8692892` introduced the API flag and shared schema support together, merged by PR254 (`1230e92`). PR258 (`43d96d21d1f103d2097c7db9e3f0864afab27c11`) optimized eligibility scanning; it did not remove schema support. An older reader schema paired with the newer API reproduces the signature. Which bundle the user actually loaded remains unverified; stale tab/cache, different frontend deployment/alias, or another runtime artifact mismatch cannot be distinguished from this evidence.

Read-only Vercel inspection on October 19 returned production deployment `dpl_7BrFyEjnLTqp2gRNWcAzJX6sb6vx`, READY, source SHA `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`, with aliases `orca-mail.vercel.app`, `orca-mail-luke-brevoorts-projects.vercel.app`, and `orca-mail-git-main-luke-brevoorts-projects.vercel.app`. This is metadata, not verification of served bundle bytes. No API deployment SHA was established. No production settings or deployments were changed.

Refresh is a conditional troubleshooting step for an old tab, not a verified workaround for this incident. No user browser, live mail, session, or credentials were accessed.

## Evidence and reproduction

- [Historical red log](../../verification/thread-image-contract/historical-red.log): actual shared sources from `5baf7f3ea9e208001c607a7bc0f5c418fb056d58` (main immediately before PR254), with the new test copied in, produce 3 failures / 1 pass. Both boolean values reproduce `unrecognized_keys` at `messages[0]`; the third failure is the expected historical malformed-value error-path mismatch.
- [Final tests](../../verification/thread-image-contract/final-tests.log): `bun test packages/shared/src apps/api/src/mail/images`, 113 pass / 0 fail, 1,639 expectations on `6cac95515379392b3bb8c465d28371093f7b8a0b`.
- [Workspace typecheck](../../verification/thread-image-contract/typecheck.log): `bun run typecheck`, all workspaces exit 0 against the identical source tree committed as the test head.
- [Production build](../../verification/thread-image-contract/build.log): `bun run build`, all workspaces exit 0 on the test head. Local output includes `mail-contracts-BJO4ACGC.js`; this is not a fetched production asset.
- Tests retain strict unknown-field rejection; validate true/false/absent metadata and reject malformed metadata. API fixture still asserts cross-account denial, unauthenticated denial, inert sanitized bodies, and zero image downloads. These assertions do not imply generic schema parsing enforces account authorization.
- Historical reproduction: archive `packages/shared` from the historical SHA into a fresh directory; copy the new `thread-image-contract.test.ts` into its `packages/shared/src`; supply frozen-lockfile dependencies (this run reused the current installation via a node_modules symlink); run `bun test` on that copied test. Current tests run with Bun 1.3.14. Historical sources with current dependencies are not a reconstructed historical deployed bundle.
- Independent review of exact base/head: no blocking findings. Reviewer inspected source and recorded logs; did not independently rerun the final Bun tests. Historical/current execution is evidence of existing support, not a new runtime fix.

## Blockers and limitations

- Screenshot `libfile_e24e3bb9fc2081918c962eae04c9c7cb`: supported Library preparation succeeded, but the current Library transfer helper failed twice with `library file transfer failed: download failed`, including the approved expanded-permission attempt. No readable local image was produced; pixels were not independently inspected here. Parent-transcribed error is the incident input. No automatic-review denial was reported.
- Public HTML GET `https://orca-mail.vercel.app/` returned HTTP 403 both normally and with expanded permissions. No bundle bytes were read. Vercel deployment file-tree read returned 404 `File tree not found`. No protected-deployment bypass, credential change, or alternate denied route was attempted.
- GitHub CLI PR listing returned `Forbidden`; the documented connected read interface succeeded. Push/draft creation use existing authorization, no permission changes.
- Next diagnostic action: inspect the failing browser's loaded mail-contracts asset/version and actual page URL, or obtain supported readable production assets. Compare with the current deployment before asserting refresh recovery. This draft is a regression guard only and does not resolve the reported incident.
- No UI change, so new visual-state screenshots are not applicable. No native code changed; local native tests not run. No live mail tests, releases, migrations, deployments, or merge.
- No owned server processes launched. Synthetic API databases cleaned by tests. Historical scratch, worktree and logs retained for review.
