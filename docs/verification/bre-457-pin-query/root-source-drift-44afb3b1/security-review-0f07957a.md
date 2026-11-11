# Code Review: BRE-457 saved-pin query result reader

## Summary

No introduced product authorization, injection, cursor-integrity or domain-write vulnerability was found in the reviewed API/shared delta. One verification-runner correctness issue should be fixed before relying on that runner for a future immutable-head gate: end-of-run source drift is recorded but does not fail its exit status.

- Independent reviewer: `/root/review_saved_query_reader_security_0f` (separate from implementation; model identity not exposed in task metadata).
- Base: `a6a8567e81dab98d7ee50b6ec263d94266ac3009`.
- Head: `0f07957a637c06bfdcda32263779772b57400ab6`.
- Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829`.
- Product API/shared diff from `869ce35f8f0d0eb71902ad5433b27fbb00e7be05` to reviewed head is empty. Checkout was clean when checked.
- Method: read-only full production diff, shared schemas, new tests/fixtures/runners, relevant existing auth/session/mobile-store/mailbox/catalog code and revision triggers, and retained execution/type manifests/logs. No tests, compiler, browser, server, install or other heavy execution was performed by this reviewer. No checkout edits, child agents, push or external posting.

## Findings

### Act on — P2: the reusable candidate runner can report success after source drift

**Location:** `docs/verification/bre-457-pin-query/run-candidate.py:114–124` (particularly return at line 118 and final-state recording at 121–123).

**Condition:** Start at the requested clean head, let all child stages return zero, and change HEAD or leave an uncommitted edit before the runner exits. The runner unconditionally returns zero; its `finally` block merely writes `finalHead` and `finalStatus`. There is no comparison to the admitted head and empty starting status. Thus automation that treats terminal 0 as a verified immutable revision can publish a green result spanning different source states.

**Fix:** Preserve existing nonzero/exception results, but reject a successful run if ending HEAD differs from the admitted SHA or ending status is nonempty. Record the rejection explicitly. Do not mask exceptions or earlier failures with a `finally` return. A small isolated guard test can cover matching clean, changed head and dirty status without rerunning the feature suite.

**Evidence scope:** This is a source-established evidence-harness defect, not an executed mutation experiment and not a product attack path. The actual retained `869` and `f6d0` manifests have matching clean start/end states. ROOT's separate `type-only-driver.py` also asserts end-state equality. Those historical results are not invalidated by this finding.

### Noted — auth and account scope are re-established in the read snapshot

`query-results-reader.ts:36–49` enables query-only on a request-owned connection, enters the deferred snapshot, rechecks the current browser/mobile session row by session ID, user ID, expiry and revocation state, then resolves query ID through its owning account and current owner. Auth source comes from existing middleware, not request query data. Retained account conflicts are rejected at line 58; collection ownership is checked at line 59. Returned account/message correlation is enforced at lines 103–104. Bound SQL parameters are used for all user-controlled identities.

Missing/foreign targets fail before raw-definition execution and use the same generic 404. Only an owned malformed definition reaches 422. No cross-account existence oracle or metadata escape was found.

### Noted — cursor integrity precedes position consumption

`query-result-cursor.ts:31–46` bounds the envelope, checks canonical signature encoding, computes a domain-separated HMAC, and uses length checking plus `timingSafeEqual` before parsing the payload/embedded position. The fingerprint at `query-results-reader.ts:81–88` binds endpoint, user, session, auth source, selected account, query/object revision, normalized definition digest, evaluation profile/effective defaults/order, mailbox revision and page limit. Bare old cursors, valid-shaped tampering and scope changes fail closed. Existing public unsigned cursor behavior is unchanged, as required.

### Noted — read-only and work claims are appropriately limited

The reader does not call catalog construction/bootstrap, providers, body loading or mutation commands. Missing derived state yields explicit 503 at `query-results-reader.ts:61–69`. Route-owned connections close in `routes.ts:61`; query-only does not leak into middleware's separate renewal connection.

The streaming branch at `mailbox/read.ts:382–393` may scan the complete authorized candidate stream for an absent/sparse Unicode/person match. It retains accepted page/lookahead rows and one current candidate, with no per-candidate enrichment or arbitrary first-N cutoff. This is the explicitly authorized O(candidates) CPU/projection tradeoff, not a database-work or SQLite-memory bound. Existing aggregates/planning may also scan broadly. No unsupported speedup or denial-of-service conclusion is drawn from the finite fixture.

### Dismissed — paired-session/auth middleware writes do not contradict the stated domain-read-only guarantee

Existing near-expiry browser renewal can write the auth connection before the route. This is explicitly separated in source, tests and ROOT correction documentation. The new snapshot connection remains query-only, and the test checks domain/auth close-order changes `[0, 1]`. An absolute claim of zero writes for every expiring-session request would be wrong, but that is not the stated accepted contract.

## Verification evidence assessment

- Corrected baseline `1f9bbc97…` establishes authenticated catalog/query/mailbox preconditions and then missing-route 404. It establishes endpoint absence, not a historical semantic filtering regression. The earlier setup failure remains a separate nonpass.
- Inspected raw `869` focused log ends **78 pass, 0 fail, 199 expect calls**. The 28 named semantic counterexamples were first executed at the implementation, not semantic red-to-green proofs. Generated stored-mail parity fixtures, ownership/strict-definition failures, live revocation after middleware, mobile revocation, signature tampering, repeated paging, missing derived state, and query-only DML rejection are present.
- The actual HTTP demo records two successful semantic requests and a foreign-account 404; sparse work records candidate scans separately from retained rows. Provider/domain-DML claims are synthetic fixture claims with explicit renewal scope, not live-provider or native acceptance.
- Original `869` type commands printed Bun usage with exit 0 and did not run TypeScript. They remain nonpasses for type execution. Inspected `root-type-correction-f6d0/actual-types-manifest.json` records actual pinned Node/local-TypeScript shared/API project commands returning 0 at `f6d0e168…`; the usage-only regression records rejection 2. Product source is identical across these checkpoints.
- Full final sequential workspace lint/typecheck/tests/build, native integration/UI and final acceptance remain pending. Source approval does not complete those gates or authorize merge/release.

## Security assessment and verdict

**Product API/shared security assessment: no blocking finding identified in this immutable comparison.** Ownership, session-source binding, strict raw normalization, signed continuation, metadata-only projection and read-only execution satisfy the reviewed security intent.

**Overall verdict: CHANGES REQUESTED — narrow verification-runner fix only.** Resolve the end-state guard above before treating the reusable candidate runner's exit 0 as immutable-head acceptance. No product rewrite, broader auth change, cursor-protocol change or speculative work cap is requested. Retain the valid scoped `869`/`f6d0` evidence and perform the separately planned final integrated gates.
