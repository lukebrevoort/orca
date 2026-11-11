# BRE-457 saved-query results: approved contract and test-only baseline

## Current verification index

**Current tested source: `f232399bec5a73ec7159e443ac7746a8ee8313a9`.** Actual
workspace lint/typecheck/**2360 tests / 12111 expect calls / zero failures**/build,
focused78 and the current HTTP/SQLite/work demo passed cumulatively over **two
serialized invocations of the same clean source**. The original full invocation
remains NONPASS2: actual tests exited0, but its summary parser rejected Bun's
real prefix. ROOT verified original raw evidence and corrected that external
parser, then ran only build/focused/demo. No lint/type/full-test repeat or
product change occurred between those invocations.

[Open final demo, exact stages, limitations and historical scopes](final-f232399/demo.md)
· [combined verification](final-f232399/combined.json)
· [original NONPASS manifest](final-f232399/first-invocation/manifest.json)
· [remaining stages and corrected summaries](final-f232399/remaining-invocation/manifest.json).
This evidence-retention checkpoint adds docs only and must retain execution inputs
exactly equal to f232. Source equivalence to869 is FALSE because of the approved
10fb read.ts comment; final f232 HTTP/work replay is actual new execution, not a
byte-identity inference. Wire publication/native-client integration, hosted/native
UI and combined all33 acceptance remain separate. No push or PR is claimed here.

### Earlier checkpoints (retained at their exact scope)

Source869ce35f passed78 focused tests, including28 first-executed semantic counterexamples, and an actual three-request HTTP/SQLite demo. Sparse work scanned104 candidates for3 returned rows and4 retained rows; SELECT counts are not VM work or a database-memory bound. Provider/domain-write tripwires passed; auth renewal is separately recorded. [Exact source869 receipts](focused-869ce35f/manifest.json) and [demo/work](focused-869ce35f/demo-work.json).

Both type commands in that original manifest printed Bun usage with exit0 and DID NOT run TypeScript. ROOT corrected the runner; actual shared/API project types passed at f6d0e168 using pinned Node24.22.1/TypeScript5.9.3, and the retained usage-only0 is rejected by the new guard. [Actual type receipts and scope](root-type-correction-f6d0/README.md). Do not relabel the original usage-only stages.

Independent correctness review approved0f07957a with nonblocking comment/entrypoint clarity findings now addressed by ROOT. Separate security review found no product security blocker but requested a fail-closed runner end-state guard. ROOT reproduced two false-success cases at8e55183d and fixed them at44afb3b1; all four boundary regressions then passed. [Exact runner-only scope and retained reviews](root-source-drift-44afb3b1/scope.json). Fresh independent narrow re-check approved44afb3b1 and closed the runner finding. At that checkpoint final sequential lint/types/tests/build remained pending; their later actual f232 results are indexed above. Wire publication and native-client integration remain pending. The inherited scan comment is clarified without changing executable behavior. No PR, native retrieval, full product, live-provider or OS completion is claimed.

## Historical checkpoint below

Status: corrected source/test preparation only; rerun awaits a new ROOT allocation.
At the previous frozen test-only SHA `bc6b447240dea2d0a0ca354fe62724a9a98b26a9`,
frozen install passed in 1.95 seconds and baseline failed during fixture seeding
in 1.26 seconds. No auth/catalog/query/mailbox precondition or missing-endpoint red
was established, and candidate tests did not run. No execution has run at this
corrected checkpoint; no evaluator or production change has been made.

The original setup-failure evidence remains separate and unchanged:
[/private/tmp/bre457-pin-query-baseline-bc6b447-20261111T171918Z/manifest.json](/private/tmp/bre457-pin-query-baseline-bc6b447-20261111T171918Z/manifest.json)
and its adjacent `baseline.log` / `frozen-install.log`. The failure was inserting
`notify` into `thread_attention_overrides`, whose production migration 0041 CHECK
accepts only `normal/quiet`. This is a fixture defect, not evaluator regression.

Base: `a6a8567e81dab98d7ee50b6ec263d94266ac3009`, verified as local and remote
`origin/main` before preparation. Branch: `t3/bre-457-saved-query-results`.
The corrected test-only commit directly follows frozen `bc6b447`, preserving that
failed checkpoint rather than amending it; both are above exact a6. Runtime
receipts record the corrected SHA and previous failure SHA. The base has no
evaluator endpoint. Its absence cannot establish runtime
parity or reproduce a historical browser filtering bug.

## ROOT-approved additive contract

`GET /v1/organization/collections-pins/queries/:queryId/results?accountId=A&limit=30&cursor=...`

Required account; limit integer 1–100, default 30; optional bounded opaque cursor.
No arbitrary definition, actor, workspace, URL, date or author-language input.
All existing endpoints, strict JSON and saved definition bytes remain unchanged.
No migration, auth/MCP/Outlook product, native or web edits are included.

Strict new response:

```ts
{
  query: {
    id: string;
    accountId: string;
    revision: number; // positive saved-object revision, not definition schema 1
    definitionDigest: string; // stable SHA-256 of strictly validated canonical definition
    evaluationProfile: "stored-mail-v1" | "legacy-pin-v1";
  };
  accounts: MailAccount[]; // exactly selected authorized account
  messages: InboxMessage[]; // each account-correlated; existing metadata projection
  nextCursor: string | null;
  freshness: { revision: string; lastSyncedAt: string | null };
}
```

No aggregate count: loaded rows alone are not a complete matching total.
Response cache policy: `private, no-store`.

Original user/session, selected authorized account, saved ID/object revision,
canonical digest, profile and effective defaults, mailbox revision, limit/order,
and full keyset position must be bound by the new authenticated cursor. Verify
integrity before consuming position. Old unsigned mailbox cursors stay unchanged.

Strictly parse raw current or legacy definitions; reject corruption and unknown
fields/dates. Never execute the catalog repository's fallback-empty definition.
Missing/foreign account/query/collection returns indistinguishable 404. Retained
definition account must equal selected/owning account; conflict or corrupt data
returns 422 `invalid_saved_query`. Invalid/stale cursor returns 400
`invalid_cursor`; unauthenticated/expired/revoked session returns 401.

## Approved deterministic differences and concrete counterexamples

These are new evaluator semantics, not blanket historical parity claims. Named
candidate tests sit beside `query-results.fixture.ts` in the owned API module.
At this baseline their semantic assertions cannot run past the missing route.

| Contract | Fixture/counterexample and expected candidate outcome |
| --- | --- |
| Generated stored-mail subset is unchanged | Five mailbox profiles compare actual rows/order/account/freshness directly with existing `/v1/inbox`. `history-old` witnesses `needle`, while Inbox returns `history-new`. `right\nleft` retains existing newline-concatenated search. Existing non-Inbox row semantics remain authoritative. |
| Legacy global latest before predicates | `history-new` replaces historical `needle`; legacy query excludes that thread. `quiet-old`/`hidden-old` mention Maya, latest rows do not; legacy person queries exclude them. This deliberately changes old quiet/hidden person-before-dedup. |
| Deterministic SQL ties | `tie-a` and `tie-z` have identical received/created timestamps. Ascending SQL ID chooses `tie-a`, which does not mention Maya; this deliberately replaces old JS descending-ID selection. |
| Independent attention | `notify`, `focus`, `normal` share content/classification/timestamps but have differing production-supported routing provenance and sender addresses. Notify-only returns notify; normal-only normal; focus is notify/focus union, unlike old strict-focus preview. Quiet + notify is empty, rather than dropping attention. This does not claim an otherwise-identical-sender impossibility witness. |
| Retained collection is conjunctive | Only `notify` belongs to collection A; legacy All Mail collection query excludes matching nonmembers. Old web selection cleared collection. |
| Explicit classification is conjunctive | Legacy All Mail human excludes `bulk-focus`; quiet tideline cannot resurrect historical `quiet-old` after choosing human `quiet-new`. Old web ignored these clauses. |
| Classification defaults are deterministic | Inbox absent classification returns human; Focus absent classification includes bulk. Explicit Focus tideline returns `bulk-focus` independently of prior browser UI state. |
| Person is broad and independent from text | `person` has name ÉLODIE, address other@..., subject Launch, snippet MAYA outcome. `sender="élodie other@" AND text="maya"` matches across name/address plus an independent content clause. `sender="maya" AND text="launch"` matches without author identity. |
| Exact JS lowercase for legacy person/text | `İSTANBUL` matches `i` + combining dot + `stanbul`; Greek `ΟΣ` matches final-sigma `ος`; legacy text `élodie` matches ÉLODIE. No locale folding or SQLite ASCII-lower parity claim. |
| Legacy text is field-by-field | Subject right and snippet left do not satisfy legacy text `right\nleft`. Person uses the exact existing broad space-concatenated predicate, including field boundaries and independently lowercased name/address alternatives. |
| Stored-mail extensions are explicit | Retained notify is conjunctive; retained sender means migrated broad person, not exact author. Generated stored-mail text continues using the existing mailbox predicate. |
| Inbox eligibility remains intact | `archived` has notify attention but no INBOX membership; `moved` is normal but explicitly placed elsewhere. Both stay outside legacy Inbox. All Mail retains archived mail. |
| Ownership and raw-data integrity | Same-owner conflicting account is 422; foreign/missing account/query/collection is indistinguishable 404. Unknown current/legacy date keys, malformed JSON and schema revisions never become all mail. Strict valid legacy raw JSON remains byte-identical. |

The test fixture has two owned accounts and a foreign owner. It uses production
migrations, real browser sessions and the real `createApp` route wiring. All
provider tokens are null; the synthetic provider registry rejects sync/transport,
and a network tripwire rejects/counts fetch. Pure capability projection is allowed.
No real OAuth route is mounted by the fixture provider.

Corrected routing seed: normal/quiet use supported conversation overrides;
notify/focus/hidden use existing exact sender rules with per-thread synthetic
addresses. No CHECK constraint is disabled, schema altered, or production resolver
replaced. The ordinary person/Unicode rows retain their explicitly supplied sender
fields. Preconditions now also read the real account-scoped All Mail endpoint and
assert effective notify/focus/normal/quiet/hidden values, plus Inbox archive/move
exclusion, before accepting the later missing-route 404. These extra assertions
remain unexecuted until allocation; they test fixture fidelity, not saved-query
evaluation semantics.

Every request checks SQLite `total_changes()` on each request-owned connection
before closure, including trigger and rolled-back writes, plus provider/network
counters. Fixture seed/session creation uses a separate connection and is outside
the read measurement. Fresh browser sessions avoid renewal; this is the intended
zero-DML scope, not a claim that existing near-expiry session renewal never writes.
Native bearer/session-renewal cases need separately labeled evidence.

## Bounded allocation requested from ROOT

Warm-dependency rerun estimate: 10–20 seconds, based on the actual 1.95-second
install and 1.26-second failed baseline, allowing for now-reaching preconditions
and candidate failures. This is an estimate, not a result. Stage hard timeouts
remain 180/60/90 seconds (330 total); they are failure caps, not expected duration.
One newly allocated wrapper invocation, no nesting. Native has priority. No rerun
has started; exit 75 means NOT STARTED with no retry/spin.

```sh
python3 /tmp/orca-ui-heavy-slot.py python3 docs/verification/bre-457-pin-query/run-baseline.py /tmp/bre457-pin-query-baseline-NEW
```

The runner requires the clean corrected test-only commit directly above frozen
bc6b447 (which is directly above exact a6), validates
Bun 1.3.14, pins the supplied Node child PATH, refuses local automatic `.env`
loading, and does not inherit provider/OAuth environment variables. It runs:

1. `bun install --frozen-lockfile` (180 seconds), then checks checkout drift.
2. `BRE457_QUERY_STAGE=baseline bun test .../query-results.test.ts` (60 seconds):
   prove unauthenticated catalog 401, authenticated catalog/query and mailbox
   200, then actual proposed-route 404. This proves endpoint absence only.
3. `BRE457_QUERY_STAGE=candidate bun test .../query-results.test.ts` (90 seconds):
   run candidate assertions against the same immutable source and record actual
   failures. Their primary expected-200/actual-404 failures are missing-route red;
   semantic comparisons are explicitly unexecuted until the candidate returns 200.

Raw stage logs, JSONL receipts, stage exit codes, timings, source SHA and final
checkout state remain in the new evidence directory. Expected red preserves its
nonzero terminal status; installation/import/setup/timeout failures are not
relabeled as evaluator regressions. The wrapper records resource/terminal release
in `/tmp/orca-ui-heavy-resources.jsonl`. Only test-owned temporary SQLite directories
are removed; installed dependencies and retained receipts remain.

## Later implementation/verification gates

Production evaluator work starts only after actual red. Reuse the current
effective attention/classification/destination SQL, ownership, read snapshot,
metadata projection, keyset/order and mailbox revision machinery. No second
classification engine, per-row network fanout, first-page JS filter, lazy catalog
bootstrap, mail/body/read/placement/notification/catalog write or provider call.
The legacy exact-JS predicates may use a narrow deterministic SQL function.

Prepared candidate tests also cover unchanged definition bytes, canonical digest,
strict requests, session revocation/expiry, repeated/tied paging, wrong endpoint/
query/account/limit/session, valid-shaped timestamp tampering, stale object
revision, same-revision changed definition and mailbox changes. Intermediate
account revocation/deletion, missing precomputed-state/no-bootstrap, mobile bearer,
renewal exception, and interrupted requests remain explicit follow-up cases.

After implementation, rerun the same tests at the candidate SHA; retain SELECT
counts and real VM work if instrumentable. A bounded response is not bounded DB
work. Final relevant lint/typecheck/tests/build run sequentially at the final
integrated clean SHA under one allocated wrapper. Independent reviews remain
ROOT-owned; no child agents. No push, CI dispatch/watch, merge, signing, release,
deployment or paid infrastructure is authorized here.

Rollback: remove the additive route/client exposure while retaining every saved
definition and all legacy APIs. Native/web owners retain their product files.
API319 D8 remains separate and pending; this work does not integrate it.
