# Code Review: BRE-457 query importance and canonical owner-read precondition

## Summary and verdict

**APPROVED WITH COMMENTS for the reviewed source change. No production correctness or security blocker found.** This is a read-only source/evidence review, not a candidate execution pass or merge approval. Candidate focused tests, project compilers, demo, full relevant workspace checks, and integration acceptance remain separate gates owned by ROOT.

Reviewed immutable comparison: baseline `a19a3bba31805d56263851cc800f8267e95db7b3` to candidate `3de619ce8a92dc52182638fe5ba94de5ac63f380`, against authoritative main base `7c97193688599e5996bb657c34227a63927c384c`. Checkout: `/Users/lbrevoort/.t3/worktrees/orca/t3-bf6ff789-f6f7314e6cf4e829`; observed clean at the pinned candidate. Independent reviewer: `/root/review_query_importance_3de`; precise underlying model identity is not exposed to this reviewer, and no different-model claim is made. No child reviewers were started.

Intent: exact existing importance-version header `1` requests complete existing per-row ImportanceResolution within the same authorized query-only snapshot; other versions preserve basic rows. Attach the existing optional expected-owner precondition only to the two canonical catalog/results reads. Preserve matching/evaluation, profiles, keyset ordering, cursor envelope/fingerprint, and all mutation semantics.

The entire production diff is 12 additions / 3 deletions across `routes.ts` and `query-results-reader.ts`. The other changes are candidate fixtures/tests/docs and retained baseline evidence. Shared schemas, auth modules, global middleware, mailbox reader, importance store, cursor implementation, migrations, web and native source are unchanged in this comparison.

## Findings

### CRITICAL / Act on: production blockers

None identified in the reviewed production patch.

### WARNING / Consider: timing field includes the fixture observer, not just the callback

`docs/verification/bre-457-query-importance/candidate-demo.ts:47-57`, together with `apps/api/src/organization/collections-pins/query-importance-baseline.fixture.ts:149-160`.

`callbackMs` starts before `f.request`, which snapshots every watched table before/after the request, serializes/sorts those rows, reads data_version, parses the response, emits a receipt, and runs assertions. It is a real measured interval around an actual Hono request, but it is not an isolated Hono callback or whole production request timing. The fixture work and later basic/enhanced ordering also limit attribution of differences to importance enrichment. RSS is process-wide before/after, not peak RSS or incremental allocation attributable to the route.

Suggested fix: label the existing interval explicitly as fixture-controlled request wall time, or separately bracket `app.request`/response consumption inside the fixture if an isolated callback metric is needed. Preserve the existing bookkeeping as correctness controls. Do not describe these results as speedups or route-only latency.

Counterargument: the current plan already disclaims speedups and universal resource bounds, and paired fixture overhead is comparable. Agreed; this is an evidence-labeling comment, not a production-code blocker.

### SUGGESTION / Consider: several proposed positive/work subcases are outside this candidate matrix

`apps/api/src/organization/collections-pins/query-importance-candidate.test.ts:135-150,250-284`; `docs/verification/bre-457-query-importance/candidate-demo.ts:43-84`.

The candidate does test actual important/not-important/unreviewed, override precedence, more than20 preferences, compatibility, tied pagination, missing/corrupt state, and account isolation. However, it does not explicitly compare a complete expected nested resolution for a null-choice revision tombstone, mixed inherited votes, or opposite exact-sender preferences in two accounts. Its two-account same-sender case uses opposing conversation choices. The freshness case writes the source choice directly as setup, exercising real triggers; it is not a supported mutation endpoint test. The finite work demo measures only first pages, not next/empty pages described in the original design audit. Its repeated rounds alternate basic then enhanced consistently; they do not counterbalance order effects.

Suggested fix: retain these as explicit limitations, or add narrowly scoped cases under ROOT's allocation before claiming the complete original positive/work matrix. A small tombstone/mixed-participant expected-object check would make full provenance stronger. No need to modify the reused resolver for these coverage comments.

Counterargument: the resolver/SQL are unchanged; strict production schema parsing already ensures valid shape, the source proves account-pair joins, and this is a seam extension rather than a resolver rewrite. Agreed; these are coverage/claim boundaries, not evidence that production behavior is wrong.

### PRAISE / Noted: narrow reuse preserves the important boundaries

- `routes.ts:43-64,94-109`: exact version comparison feeds a server-owned boolean; results append Vary and retain private/no-store. Existing requireSessionOwner runs before opening the domain connection. The header compares against authenticated identity and cannot select an owner/account. Absent remains compatible, malformed remains400, mismatch409; catalog's existing foreign-account403 remains distinct from results404.
- `query-results-reader.ts:38-50,101-120`: the original session recheck, account/query ownership and all enrichment/response parsing share the existing outer deferred query-only transaction. The new undefined-importance check throws503 before any successful partial response is emitted. Empty pages satisfy completeness vacuously. Missing returned state remains distinct from valid unreviewed; present malformed data is rejected by existing schema validation and reaches non-success rather than being fabricated or mislabeled invalid_saved_query.
- `mailbox/read.ts:409-446`, `importance/store.ts:49-78` (unchanged dependencies): trim lookahead before the single batch call, authorized account/thread pair keys, two metadata SELECTs for nonempty unique targets, zero for empty targets, no bodies/providers/per-row fallback or repair. Preference-window output is capped, but its visits/sort work can exceed20 per target.
- `query-results-reader.ts:73-100`, `query-result-cursor.ts:31-48` (unchanged cursor dependency): importance is excluded from effective matching/fingerprint as approved. HMAC integrity is checked before consuming the inner position; user/session/auth source/account/query/revision/digest/profile/effective scope/limit/mailbox freshness bindings remain intact. Both cross-mode continuation directions are explicitly prepared as positive tests.

## Security and adversarial assessment

No new injection, credential, authority, provider-network or write primitive is introduced. Actual selected account remains constrained by the authenticated owner join and mailbox authorization; the importance helper's lack of its own user authorization is safe here because its targets come exclusively from those final account-correlated rows. The owner precondition is an additional stale-owner fence, not authentication or a claim to stop same-user session changes.

Revocation before the results snapshot remains rechecked by the unchanged session query for cookies and opaque mobile sessions. A mutation committed after the snapshot starts is not promised to be observed. The new candidate revocation tests revoke before middleware authentication; the historical focused tests additionally exercise the middleware-to-snapshot boundary through their existing fixture factory hook. Historical instrumentation must remain labeled historical/scoped: the old fixture replaces fetch/close, whereas the new fixture does not patch reader/SQLite/global fetch methods.

Session renewal is still an auth-layer write on the auth connection before route access; adding the owner fence does not promise that a rejected near-expiry request performs zero auth DML. The historical near-expiry case explicitly separates auth changes1/domain changes0. Fresh-session routed observers prove no committed DB changes plus unchanged selected tables/provider seams; they do not audit every attempted/rolled-back statement on closed request connections. The direct-reader query_only/inTransaction/rejected-UPDATE/total_changes control is separate evidence, appropriately described as such.

CORS tests prepare actual in-process OPTIONS callbacks for the existing headers. They are not browser credential-delivery evidence and do not expand the unchanged global CORS policy. Catalog has no new results-style snapshot/session-recheck/query_only guarantee; this patch correctly does not claim one. Optional owner fencing on these two reads does not imply mutation-route fencing.

## Evidence actually inspected and limits

Read root AGENTS and `.agents/skills/interrogate/SKILL.md`, the full external main7c contract/design audit, candidate plan/README/source inventory, all production changes, the original baseline assertions and fixture, new candidate tests, driver/demo/Python helper, and relevant auth/global registration/catalog/mailbox/importance/schema/cursor/trigger source. Inspected the actual retained a19 extension JSONL and manifest, not just prepared expectations: controls1/0; extension0/5; successful projection200 with all3 importance fields missing; four distinct cookie/mobile B-own catalog/results200 with expectedU, B scope, and2 opened connections. These are additive contract-extension reds, not absent endpoints, old UI reproduction or unauthorized disclosure to the authenticated B user. Earlier setup failures remain nonpasses.

Candidate106 and controls1 are planned counts at this frozen source, not independently observed passes. The driver requires clean exact head, unchanged original baseline assertions, inherited lock FD, pinned runtimes, actual project compiler events and strict nonzero test summaries; it stops on first failure and retains raw evidence/source hashes. New-driver cancellation injection remains explicitly untested. No test, compiler, parser self-test, build, server, browser, CI, remote action or push was run by this reviewer.

Python metadata replay executes the exact two extracted source templates with actual returned account/thread pairs on the disposable fixture under read-only/query_only mode, using trace counts and interval1 progress callbacks. This is Python SQLite metadata-statement work, not Bun VM work, not the callback request's SQL count, and not an entire endpoint resource bound. The helper records SQLite version, source/SQL hashes, statement output rows and zero changes. Source deductions of +2 SELECTs/nonempty and0/empty must remain deductions until appropriate observations exist; limited output rows and RSS snapshots do not establish universal work/memory bounds.

Approval covers this pinned source comparison only. ROOT's later observed focused/type/demo results may resolve execution gates, but cannot retroactively turn this source-only review into runtime validation. Full relevant lint/typecheck/tests/build, final revision rechecks after any edits/base drift, UI/native/deployed acceptance, all33 readiness, publication, merging and release remain outside this review. Review approval grants none of those actions.
