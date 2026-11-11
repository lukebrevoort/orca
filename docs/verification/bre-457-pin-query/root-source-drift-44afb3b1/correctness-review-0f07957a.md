# Independent correctness review: saved-pin query results

**Verdict: APPROVED WITH COMMENTS for the scoped source change. No Act On finding.** This is not approval to merge or a claim of completed native/integrated acceptance.

## Immutable scope and method

- Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829`.
- Full comparison: `a6a8567e81dab98d7ee50b6ec263d94266ac3009` → `0f07957a637c06bfdcda32263779772b57400ab6` (19 files, 1,696 additions / 8 deletions).
- Independently checked that `869ce35f8f0d0eb71902ad5433b27fbb00e7be05` → reviewed HEAD has no `apps/api/src` or `packages/shared/src` differences. Checkout remained clean.
- Read full production delta, shared schemas, route/auth composition, effective destination/Inbox/latest/keyset helpers and revision triggers, semantic fixture/tests, baseline/candidate verification runners, demo instrumentation, retained runtime logs/manifests, and ROOT's actual compiler correction.
- Source-only review: no tests, compiler/build, server/browser, other agent, repository edit, push or external post. This report is the only file created.

## Findings

### Act On — none

No reachable correctness blocker was identified against ROOT's expressly approved deterministic semantics and streaming adaptation.

### Consider C1 — qualify the mailbox loop's inherited bounded-work comment

**Reference:** `apps/api/src/mailbox/read.ts:327-328`, with the new execution path at `:372-393`.

**Reachable condition:** a saved query has legacy text/person or retained stored-mail sender. `streamContent` omits SQL LIMIT and iterates ordered candidates until enough exact JS matches or genuine exhaustion. The inherited comment says the streams keep projection bounded “without sorting the complete mailbox”; that is no longer a safe unqualified statement for this path. An ORDER BY may require SQLite to sort/materialize candidate metadata even though retained application row objects are bounded.

**Suggested change:** restrict that comment to the default limited mailbox path, and state that saved-query streaming bounds retained application rows while candidate work and SQLite sort/cache memory can grow. The implementation checkpoint already makes the correct distinction. No runtime failure or performance regression is claimed; this is nonblocking source-comment precision.

### Consider C2 — add a current verification entry point without rewriting historical receipts

**References:** `docs/verification/bre-457-pin-query/README.md:3-8` and `implementation-checkpoint.md:3-5`; current correction is under `root-type-correction-f6d0/README.md` and `actual-types-manifest.json`.

**Reachable condition:** someone opens the directory's README or implementation checkpoint at the reviewed HEAD. Both top-level status paragraphs still describe preparation/unexecuted checks, although the current tree contains first semantic execution and successful actual compiler receipts. Their historical details are useful, but not obvious as historical headings.

**Suggested change:** prepend a small current-state index linking source869's 78 focused passes/demo and f6d0's actual types, label the earlier status paragraphs as pinned checkpoint history, and retain every failed/usage-only receipt unchanged. Keep full sequential/integration/reviews pending. This avoids an ambiguous handoff; it is not a fabricated pass or a product blocker.

## Correctness assessment

### Ownership, validation and snapshot

- The additive route rejects unknown/duplicate query parameters and uses the existing auth middleware (`routes.ts:42-61`; new strict shared query schema). No existing request/response definition is widened.
- `query-results-reader.ts:36-48` places the actual cookie/mobile session check and raw saved-query/account ownership lookup inside the read-only snapshot. Middleware authentication alone does not authorize a later disconnected account or revoked credential. The raw record is fetched by query ID + selected owning account + user.
- `:50-59` strictly normalizes current/legacy definitions before execution, checks saved-object revision independently of schema revision, rejects retained account conflict, and returns the same missing-scope error for absent/foreign collections. It does not execute the catalog's fallback definition.
- `:63-69` explicitly detects missing mailbox/workspace/thread-lane roots and returns unavailable rather than constructing catalog/domain state. Effective-destination joins, fallback lane, and current Inbox policy remain existing machinery.
- `PRAGMA query_only` intentionally remains on this request-owned connection until the route closes it; it is separate from auth renewal. Nested mailbox reads remain in the outer deferred snapshot. No new domain write, provider, body, read-state, placement or notification call is present.

### Evaluation and compatibility

- ROOT's regularizations are explicit and correctly reflected in named counterexamples: legacy global latest before predicates, exact notify/normal/focus union, conjunctive explicit clauses, deterministic classification defaults, and broad person independently ANDed with field text.
- Latest representative uses the existing received/created/ascending-ID helper. Metadata projection/order/keysets remain the shared mailbox reader; legacy unread is conversation-aware. Generated stored-mail queries avoid the extension, and their five-profile parity test compares actual existing mailbox rows, account metadata, freshness and ordering.
- Exact JS Unicode lowercase is applied in one narrow predicate (`mailbox/read.ts:550-566`), rather than substituting SQLite's ASCII lower or inventing a second classifier. The fixture exercises expanding Turkish lowercase, contextual Greek lowercase, non-ASCII text, person field boundaries, and historical-only text.
- No web/native product, migrations, saved definition rewrite, date interpretation, arbitrary actor/definition input, or provider fetch has entered the patch. The agreed semantic extensions are not misrepresented as exact old-web parity.

### Continuation and sparse matches

- HMAC is domain-separated; canonical signature decoding and timing-safe verification precede payload/position parsing (`query-result-cursor.ts:15-47`). Fingerprint binds user/session/auth source, owned account, query ID/object revision/digest/profile/effective defaults, mailbox revision and limit/order (`query-results-reader.ts:76-88`). Inner mailbox position remains validated by the existing reader.
- Streaming consumes candidates to limit+1 accepted matches or true exhaustion, without per-candidate queries/enrichment. Continuation uses the last returned row, so the lookahead or rejected candidates do not skip later matches. Existing rank/keyset ordering is preserved.
- Sparse/tied fixtures page limits 1/2/3, repeat pages, exhaust the stream, compare complete order, and reject valid-shaped position tampering and scope/revision changes. The count SQL is a pre-content superset used for safe group skipping; those facet counts are deliberately not exposed as saved-query totals.
- Reviewed revision triggers cover content/attention/classification/placement and Inbox-policy changes used by existing mailbox revision validation. Production Collection apply/revert advances the workspace revision (`collections-pins/sqlite-repository.ts:827,888`), whose existing trigger advances the account mailbox revisions; raw test-only membership insertion is not itself a new invalidation mechanism. New query object revision and canonical digest additionally bind definition edits.

## Evidence assessment and limits

- Corrected baseline `1f9bbc97`: real auth/catalog/query/mailbox/routing prerequisites followed by missing route404. Candidate failures at that baseline establish endpoint absence only, not executed semantic red-to-green. The earlier fixture CHECK failure is correctly retained as setup failure.
- `/private/tmp/bre457-pin-query-candidate-869ce35f-01/`: inspected manifest, focused test source/log context, actual demo JSON and runtime boundaries. Reported 78 focused passes include the 28 first-executed semantic counterexamples. HTTP demo has three loopback requests, two semantic successes and foreign-account404.
- The source869 manifest records two incorrect Bun argument-order commands that printed usage with exit0. These are **not typecheck passes**. ROOT's tracked `root-type-correction-f6d0/actual-types-manifest.json` records direct pinned Node24.22.1/TypeScript5.9.3 project invocations with actual shared/API exit0. The exact prior bad output is separately rejected by the usage guard; no semantic repeat was asserted.
- The work demo alternates dense/sparse on the same 330 added synthetic rows and limit3: sparse104 iterator candidates, three returned rows, four retained accepted/lookahead rows; 15 SELECT preparations. These counters describe their exact instrumentation, not all SQLite VM work. RSS/timing samples are finite noisy observations, not a speedup or memory bound. No provider call/domain DML is claimed from absent ledgers; actual fixture tripwires and query-only/total_changes checks support the scoped zeros.
- Fresh-session zero DML is separated from near-expiry auth renewal's one write. Tests also cover real native bearer revocation, between-middleware/snapshot revocation, missing derived state/no repair, strict raw corruption/conflict, foreign ownership and cursor/session/account isolation.
- Full relevant sequential workspace gates at the final integrated SHA, a separate security review, native client retrieval/UX, screenshots and ROOT final acceptance remain pending. I did not independently execute any runtime check during this review.

## Security summary

No additional security blocker found in this correctness pass: SQL values are parameterized, authorization is rechecked within the snapshot, missing/foreign scopes fail closed, signed continuations are session-bound, and the route exposes only existing authorized metadata. This does not replace the separately assigned independent security review.

## Delivery

Approval covers only the immutable source comparison stated above, with nonblocking comments C1/C2. No merge, deployment, wire publication, native acceptance or full-task completion is authorized by this report.
