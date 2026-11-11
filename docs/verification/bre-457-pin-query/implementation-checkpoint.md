# Source candidate: saved-query result reader

Status: source implementation only, not yet executed or typechecked. ROOT has
approved the contract and the server-side streaming adaptation described below.
Independent reviews and final integrated full sequential gates are pending.

## Immutable baseline evidence

- Initial test-only `bc6b447240dea2d0a0ca354fe62724a9a98b26a9` is a setup failure,
  not a regression pass. Its manifest remains at
  `/private/tmp/bre457-pin-query-baseline-bc6b447-20261111T171918Z/manifest.json`.
- Corrected test-only `1f9bbc979681c8bf5e5c3c10fd8704a26a8f1e2b` established real
  auth/catalog/query/mailbox/routing preconditions, zero measured request DML and
  provider calls, then authenticated missing-endpoint 404. Baseline 1 pass;
  candidate 39 failures, 35 explicit expected-200/actual-404 receipts, zero semantic
  comparisons. Manifest/logs remain at
  `/private/tmp/bre457-pin-query-baseline-1f9bbc97-20261111T172333Z/`.
- First candidate semantic assertions will therefore be first executed checks,
  not historical-semantic red-to-green evidence. Preserve new failures verbatim.

## Implementation and authorized differences

`query-results-reader.ts` resolves the existing raw query by ID + owning selected
account, strictly normalizes the current/legacy schema, checks retained account
and collection scope, and uses a single deferred SQLite snapshot. It rechecks the
actual cookie/mobile session row inside that snapshot. `PRAGMA query_only=ON`
enforces read-only SQL on the new request-owned domain connection. Existing
middleware renewal uses its own connection and is measured separately.

Missing mailbox revision/workspace root/thread-lane state is an explicit 503
`mailbox_unavailable`, with retry-after-sync meaning. Nothing bootstraps or repairs
domain state on GET. The old catalog fallback is never used by execution.

Generated stored_mail profiles use the mailbox reader without the trusted saved
profile extension. Legacy/retained extra clauses opt into a trusted internal
profile unavailable from public inbox query parameters. Shared effective routing,
classification, destination/Inbox policy, collection membership, latest SQL
selection, ordering/keyset, bounded final enrichment and freshness remain the
existing mailbox machinery. All approved differences in the README's named
counterexamples still apply; legacy definitions and public responses/cursors
remain untouched.

Legacy content matching uses exactly JS `.toLowerCase()`, independent field text,
and the old broad space-concatenated person predicate. Null fields use their
existing serialized mailbox defaults. SQL applies current ownership, global latest
representative, supported attention/classification/collection and keyset before
the content predicate. Generated stored_mail text retains the old SQL witness
semantics; the migrated-person extension tests its returned representative.

## Pinned Bun compatibility and streaming

Local installed `bun-types/package.json` is version **1.3.14**. Its
`node_modules/bun-types/sqlite.d.ts` SHA-256 is
`b5a907deaba678e5083ccdd7cc063a3a8c3413c688098f6de29d6e4cefabc85f`.
The supported Database API in that file has no JS function-registration method;
lines 1244–1257 expose only an explicitly unstable untyped native escape hatch.
This candidate does not use that escape hatch, an extension, a new dependency, or
an upgrade. The allocated runner will retain the local type proof; no runtime
capability probe has run for this source candidate.

ROOT explicitly approved server-side streaming on pinned Bun rather than ASCII
lowercase approximation. For content predicates, the existing per-rank/account
page SELECT becomes an ordered SQLite iterator without an arbitrary LIMIT cap.
It consumes candidates until limit+1 exact matches or genuine exhaustion.
One candidate is live in addition to accepted page/lookahead rows; only accepted
rows are retained. No per-candidate SELECT, label enrichment, provider/body fetch,
complete mailbox `.all()` or arbitrary first-page filtering is used. Final labels
and serialization are batched over accepted rows. The signed continuation uses
the **last returned** key, never the last scanned/rejected/lookahead key.

Worst case is O(candidates) time and projected candidate metadata, plus existing
SQL aggregate/planning/state checks. Retained application row objects are bounded
by the page/lookahead plus a one-row iterator batch. SQLite sort/page-cache memory
is not claimed bounded by this count. The old `pageRowsProjected` field tracks
accepted retained rows on the new streaming path; `savedQuery.candidateRowsScanned`
separately exposes actual iterator candidate work. SELECT counts are not VM steps.
No complete result counts are returned by the new endpoint.

`query-result-cursor.ts` seals the old mailbox position in a domain-separated HMAC
envelope using the existing configured secret, without creating secret or domain
state. Its fingerprint binds original user/session/auth source, selected owned
account, query ID/object revision/canonical digest/profile/effective defaults,
mailbox revision and limit/order. Integrity is checked before parsing position.
Old unsigned cursors continue to use their existing reader unchanged.

## Focused execution allocation requested

Warm estimate **20–45 seconds** for focused regressions, real API/shared types,
and a small owned loopback HTTP/SQLite demo. This is an estimate, not a result;
native retains priority. No install is needed and none is in this runner.

One wrapper, after explicit allocation, with a fresh directory and the committed
candidate's exact full SHA:

```sh
python3 /tmp/orca-ui-heavy-slot.py python3 docs/verification/bre-457-pin-query/run-candidate.py /tmp/bre457-pin-query-candidate-NEW EXACT_HEAD_SHA
```

Sequential stages, stop on first nonzero exit, no retry:

1. Focused API query-result + existing mailbox-reader + new shared wire + existing
   saved-query-definition tests (90-second hard cap).
2. Actual shared project `tsc` via its typecheck script (60-second cap).
3. Actual API project `tsc` via its typecheck script (90-second cap).
4. Owned `127.0.0.1`, ephemeral-port HTTP demo (60-second cap), with two successful
   semantic examples and foreign-account 404. Then three alternating dense/sparse
   pairs on the same finite 330-row synthetic addition, page limit 3, recording
   iterator candidates, SELECT preparations, retained rows, timings and RSS.

The HTTP caller's three loopback requests are separate from zero external-provider
calls. The demo stops its own server and removes only its own SQLite directory.
The wrapper preserves terminal/resource records; the runner preserves raw stage
logs, JSONL receipts, exact source/end state and demo JSON. Exit 75 is not started,
never a pass or retry instruction. No runtime/source edits happen during the gate.

New candidate scenarios include query/session/account deletion/revocation,
revocation after middleware but before snapshot, native bearer ownership,
explicit renewal exception, same-revision digest change, malformed/tampered cursor,
actual query-only transaction DML rejection, missing derived-state/no repair and
repeated sparse Unicode/tied-key paging beyond the first candidate batch.

Full relevant lint/typecheck/tests/build at final integrated clean HEAD and
independent correctness/security review remain separately allocated ROOT gates.
No children, push, CI dispatch/watch, merge, release, deploy, live mail/credentials,
native/web/auth/MCP/Outlook edits or migration changes are included.

Rollback remains removing the additive route/exposure while preserving all saved
definitions, original APIs and user customizations. API319 D8 remains separate.
