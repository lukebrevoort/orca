# Saved-query result reader: final API demo and verification

Tested source: **`f232399bec5a73ec7159e443ac7746a8ee8313a9`**. Base:
`a6a8567e81dab98d7ee50b6ec263d94266ac3009`. The following delivery checkpoint
adds evidence/docs only; its selected execution inputs must match tested f232
exactly. No byte-identity claim is made against869: the approved10fb scan-bound
comment changes the source-input comparison, so the HTTP/work demo ran again
on actual f232.

## What opening a saved query now does

`GET /v1/organization/collections-pins/queries/:queryId/results?accountId=A&limit=30&cursor=...`
authenticates the existing session and resolves the raw saved query by ID and
owning selected account inside a query-only SQLite snapshot. It returns one
authorized account, existing bounded mail metadata, query object revision,
canonical definition digest/profile, mailbox freshness and authenticated
continuation. No client definitions/actors/URLs, body fetch, provider call, lazy
domain repair or mutation is needed. No aggregate matching total is claimed.

The three actual loopback requests in [final demo JSON](remaining-invocation/demo-work.json)
returned:

- Notify-only legacy query:200, exactly `notify`; notify and focus are distinct.
- Unicode cross-field person AND independent text:200, exactly `person`.
- Foreign selected account:404, no result rows.

The fixture's real auth/catalog/query/Inbox/All Mail preconditions and effective
routing passed before these requests. [HTTP log](remaining-invocation/http-work-replay.log)
and [precondition receipt](remaining-invocation/demo-receipts.jsonl) are retained.
The caller made three loopback HTTP requests; application external-network,
provider sync and transport counters were all zero. Twelve request-connection
DML measurements were zero. There is no live-provider or iPhone UI claim.

## Cumulative final gate: two invocations, same immutable source

[Combined ROOT verification](combined.json) records **six stages passed
cumulatively** at clean f232. It does not convert the original failed parser run
into a passing invocation.

1. First invocation: actual workspace lint16.679s and typecheck12.750s passed.
   Pinned Node24.22.1/TypeScript5.9.3 executed all three exact workspace configs;
   [compiler execution events](first-invocation/node-executions.jsonl) and hashes
   identify the actual commands. All workspace tests executed: API1300, shared191,
   web869 = **2360 passed / zero failed / 12111 Bun expect calls**. The test stage
   took193.542s. Its actual child exit was0, but the parser expected
   `@orca/api test:` instead of actual `@orca/api:test |` and rejected with2.
   **[Original manifest](first-invocation/manifest.json) remains overallExit2,
   a NONPASS.** [Complete raw test output](first-invocation/test.log), including its
   original NUL byte, is retained byte-for-byte. A separately labeled
   [readable derivative](first-invocation/test-readable.txt) escapes that NUL for
   GitHub viewing; it never replaces the original. No later stage ran in that invocation.
2. ROOT's second invocation checked the first source state, complete per-workspace
   zero-fail summaries, original logs/manifest/compiler-event hashes and preserved
   original driver before carrying those actual results forward. It did not rerun
   lint/typecheck/full tests. The [corrected parser/carry-forward manifest](remaining-invocation/manifest.json)
   retains both the original rejection and corrected complete summaries.
   Actual workspace build passed in16.986s, including successful pinned compiler
   and Vite events. Focused replay passed **78/78**, zero failures, in3.916s.
   The current HTTP/SQLite/work demo passed in1.044s. This invocation ended0.

Both invocations started and ended at exact f232 with clean Git status. The first
driver hash was `ec53e724262a1c8a9f86de5e6bd4a6cf787ba2edc04ca02903312fb66d743d27`.
The complete [first driver](drivers/full-executed-original.py),
[prepared full variant](drivers/full-prepared-current.py), and
[ROOT remaining-stage variant](drivers/remaining-stage-corrected.py) are retained.
No source edit, install, Apple command or concurrent local heavy job occurred.
Owned process groups were terminal; both task-owned temp roots were removed.
Per-invocation wrapper resources are retained beside the raw logs.

## Read-only, paging and work scope

[Focused raw output](remaining-invocation/focused-replay.log) and
[focused JSONL receipts](remaining-invocation/focused-receipts.jsonl) retain current
ownership/session revocation, stale query/digest/mailbox revision, valid-shaped
cursor tampering, repeated/tied/sparse paging, corrupt raw definitions and missing
derived-state cases. The actual transaction asserted `inTransaction=true`,
`query_only=1`, rejected an attempted UPDATE and finished with zero changes.
Near-expiry cookie renewal is separately labeled: **one auth write, zero domain
writes**. It is not silently included in fresh-session zero-DML claims.

The exact JS Unicode predicate ran server-side in the same authorized snapshot,
after SQL latest-representative and supported predicates, before constructing the
final page. It streams to limit+1 matches or true exhaustion. Only final accepted
rows are enriched in batch; no arbitrary first-page filtering or per-row SELECT.
The continuation seals the last returned key and the original owner/session,
account, query ID/object revision/digest/profile/defaults, mailbox revision,
limit and order. Old public mailbox cursor/JSON behavior is unchanged.

In the finite 330-row work addition, the sparse profile scanned **104 candidates
for three returned rows**, with metric `maxRetainedRows=4`, a one-row candidate
batch, three candidate SELECTs and15 total SELECT preparations. All three sparse
rounds recorded the same work counts. The actual sparse timings were9.337,7.707
and7.641ms; RSS readings are preserved in JSON. Three alternating dense controls
used the same account/order/limit. This is a finite synthetic work observation,
not a speedup, VM-step measurement, complete result count, heap limit or bounded
database-work claim. Worst-case scanning remains **O(candidates)**; SQL aggregates,
state checks, sorting and page-cache memory can grow independently of limit.

## Historical results remain their own results

- [bc6b447 setup failure](historical/bc6b447-setup-failure/manifest.json): frozen
  install passed, then a fixture attempted unsupported notify conversation
  override; no auth preconditions or endpoint red. It remains a setup NONPASS.
- [1f9bbc endpoint absence](historical/1f9bbc97-missing-endpoint/manifest.json):
  real auth/catalog/query/mailbox/routing/zero-DML/provider0 preconditions passed,
  then authenticated saved-query results404. Candidate39 failures included35
  explicit expected200/actual404 receipts and **zero semantic comparisons**.
- [Source869 first candidate](../focused-869ce35f/manifest.json):78 focused and
  HTTP/work checks executed, including28 named first-executed semantic cases.
  These were first executed semantic checks, not historical browser-semantic
  red-to-green. Original usage-only type stages remain unexecuted, with complete
  raw type logs now retained. [ROOT's real compiler correction](../root-type-correction-f6d0/README.md)
  is separate from those invalid stages.
- [Runner boundary red/green](../root-source-drift-44afb3b1/scope.json): real
  runner main with final Git observations simulated;2/4 then4/4. It proves the
  source-drift exit boundary, not API/native execution. Independent re-check
  closed the sole blocking security finding. The original review verdicts remain
  retained, not rewritten as unconditional approval.

## Reproduction and review

From a frozen-dependency Bun1.3.14 checkout, the portable focused command is:

```sh
bun test apps/api/src/organization/collections-pins/query-results.test.ts apps/api/src/mailbox/read.test.ts packages/shared/src/organization-saved-query-results.test.ts packages/shared/src/organization-collections-pins.test.ts
```

The synthetic HTTP/work command is:

```sh
bun docs/verification/bre-457-pin-query/candidate-demo.ts /tmp/new-saved-query-demo.json
```

On the shared Mac, run heavy reproduction only after ROOT allocation through its
single cooperative wrapper; no install is part of either command. The demo owns
an ephemeral loopback server and temporary SQLite state and cleans them in finally.
The saved-query route does not repair missing state; it returns503 unavailable.

Named approved semantic regularizations and counterexamples are in the parent
[contract README](../README.md). Independent correctness approved with nonblocking
comments resolved by10fb; security's runner source-state request was fixed at44afb
and its fresh narrow re-check approved. These are source/evidence assessments,
not formal GitHub review/merge approval. Full native/client integration, all33
combined requirements, real-mail/physical-device/OS acceptance and current hosted
native failures remain separate. No local Apple execution, release/deploy or
native wire integration is claimed by this API branch.

[Retention provenance](retention-provenance.json), [all retained content hashes](hashes.json),
[execution-input tree](execution-inputs.json) and [verified inherited PR heads](ancestry.json)
support readback. Rollback removes the additive route/exposure while preserving
all saved definitions, old APIs and customizations. API319 is not inherited.
