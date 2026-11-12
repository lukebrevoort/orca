# BRE-457 additive query importance / canonical owner-read fence

**Prepared test-only baseline; NOT EXECUTED.** Base is exact merged main `7c97193688599e5996bb657c34227a63927c384c`. New local branch is `t3/bre-457-query-importance-read`, created directly from that commit in the existing checkout. The old PR320 branch/head is preserved; PR320 is merged/watch off and must not be amended or pushed for this extension.

ROOT approved decisions A–E as a FUTURE API extension. Current code does not implement importance opt-in or expected-user preconditions on canonical catalog/results. An ignored header returning200 is not support, and no deployment/client integration follows from this preparation.

## Approved future behavior

- Exact existing `x-orca-importance-version: 1` opts in; append Vary, private/no-store. Absent/other values retain basic JSON. Pass a trusted option to the existing final-page batched importance reader inside the current outer read-only snapshot.
- Existing optional full ImportanceResolution, with actual resolution for every enhanced returned row or503 mailbox_unavailable. Missing is not Unreviewed; unexpected corruption is non-success. No new shared schema/counts/global middleware/migrations/old Inbox behavior.
- Projection-independent cursor fingerprint: cross-mode continuation is explicitly accepted. Query object revision, definition digest, evaluation profile/effective predicate, order/keyset and HMAC bindings/format are unchanged.
- Explicitly attach existing OPTIONAL requireSessionOwner only to canonical catalog/results: absent remains compatible; matching continues; malformed400 invalid_request; mismatch409 session_owner_changed/private,no-store before domain open. Authentication still supplies owner; headers do not grant authority. No mutation/auth-module expansion.
- No per-row GET/SELECT enrichment, body/provider fallback, lazy DML, local definition evaluation or second resolver. Source predicts two extra metadata SELECTs on a nonempty enriched page, not an observed SQL/VM-work bound. Sender-preference ranking can scan more than its20-row-per-thread output.

The read-only design audit is external `/tmp/bre457-query-importance-contract-main7c.md`; baseline execution has not occurred. Its source pointers pin main7c. The local branch/task-name duplicate check found no query-importance branch and no active title/message match for `BRE-457 query importance` (search is not exhaustive). Related native/old saved-query branches were left intact. No other checkout, including ROOT's Calendar test file in WEB, was touched.

## Exact planned test counts and names

One shared test file runs twice, in separate fresh migrated SQLite fixtures:

| Stage | Concrete Bun test name | Baseline expectation after controls |
| --- | --- | --- |
| controls | BRE-457 importance baseline: real auth/catalog/default/Inbox/source-state controls | 1 pass /0 fail |
| extension | BRE-457 extension: version1 query rows project actual retained importance | existing200,3 rows,3 importance fields missing; assertion fails |
| extension | BRE-457 extension: cookie B own catalog rejects original owner U | actual200 as authenticated B vs approved409; assertion fails |
| extension | BRE-457 extension: cookie B own results rejects original owner U | actual200 in proven B scope vs409; assertion fails |
| extension | BRE-457 extension: mobile B own catalog rejects original owner U | actual200 as authenticated B vs409; assertion fails |
| extension | BRE-457 extension: mobile B own results rejects original owner U | actual200 in proven B scope vs409; assertion fails |

Thus the expected **planned** full baseline is controls1/0 then extension0/5. Nothing has run; these are source predictions. Owner cases are absent original-owner preconditions on B's own authorized scope, not anonymous/foreign-account disclosure. Projection is an additive missing-field assertion on the existing200 endpoint, not endpoint-absence404 or a reproduced old UI bug. Malformed/matching/cross-mode/paging/no-state/CORS checks are deferred to the allocated candidate matrix, not silently counted here.

## Nonvacuous controls and fixture boundaries

The fixture uses production `createApp`, real Hono handlers, actual committed migrations, file-backed SQLite, real cookie `createSession` and real opaque `createMobileSession`. It does not import the older query-results fixture because that older helper replaces global fetch and SQLite close; this helper patches neither. No reader/resolver/route response mock, Proxy, SQLite method replacement, global fetch replacement or altered constraints/triggers.

Two real users U/B own different accounts. U has Important, Not important and genuinely Unreviewed conversation witnesses; choices with explicit source revisions are inserted as test setup and production importance triggers maintain state. Real catalog responses discover query id/account/object revision and verify them against retained rows; URLs/revision expectations use those observed values. Definitions remain strict generated stored_mail, object revision distinct from definition schema revision1.

Each run must first prove anonymous401; real U-cookie/B-cookie/B-mobile `/v1/auth/session` owners; both users' account-scoped catalogs and nonempty default query200; default omitted importance; version2 still basic; existing Inbox version1 matches independent persisted choices/state/account revision for all three importance witnesses. Setup/import/constraint/auth/unknown-state failure stops without regression classification.

Supported injected provider dependency seams deny/count client/body/sync/transport calls. The production Gmail OAuth app/capability adapter remains real and untouched; no OAuth requests are made. Counters are provider-boundary observations, not a universal global fetch/packet monitor. No provider credentials or environment files are inherited by the prepared runner. No server/listener/browser is launched: `app.request` exercises actual Hono callbacks in process.

Fresh-session GET controls observe SQLite `PRAGMA data_version` on the fixture's persistent observer plus selected source-table equality (including auth sessions). They prove no committed changes and unchanged selected persisted state, not that a closed request connection attempted zero rolled-back DML. Fixture writes/session creation happen before these measurements. Real `readSavedQueryResults` also runs a separate existing observe callback inside its query-only transaction: PRAGMA=1, attempted UPDATE rejected, connection total_changes=0. This direct-reader control is labeled separately from routed GET observations. No near-expiry renewal test is in this first baseline; existing renewal evidence stays historical/separate and no new zero-auth-DML claim includes renewal.

The new test asserts future owner mismatches409/no-store with only the auth connection opened. Actual current status/scope/connection counts are recorded before assertions; future1-connection behavior is not claimed today. No new production instrumentation is introduced.

## Prepared command, limits and stop rules

ROOT must inspect the exact committed SHA/driver hash and allocate the shared slot before anyone executes:

```sh
python3 /tmp/orca-ui-heavy-slot.py python3 docs/verification/bre-457-query-importance/run-baseline.py --head FROZEN_FULL_SHA /tmp/bre457-query-importance-baseline-FRESH
```

Use direct wrapper output capture; do not infer success from tee or a pipeline. No install is included. Pinned Bun1.3.14 and Node24.22.1 are checked only when allocated. Each stage executes actual `bun test <exact-file> --timeout 15000`; named tests and receipt controls reject usage-only0. beforeAll has20s maximum. Stage hard caps: controls30s, extension30s; total driver work allowance90s and proposed outer allowance105s only for final source/owned cleanup. Warm estimate **10–20s**, not the hard maxima. Versions/import/setup may invalidate this estimate; no automatic retries.

The driver requires the actual shared wrapper's inherited lock FD, fresh external evidence path, exact clean --head, correct branch/direct parent main7c, and only the two new test files plus assigned docs in the diff. It sanitizes environment, refuses auto-loaded env files, retains stdout/JSONL, exact driver/wrapper/raw hashes, runtime versions, per-stage elapsed times, and exact clean ending head. Wrapper resource snapshots and15s stage progress keep updates under60s during any later job. It never runs install/types/build/other tests, watch, CI or provider calls.

Controls must complete1/0 before the extension stage. Only raw extension exit1, complete0/5 summary, successful real preconditions, a200/missing-importance receipt and four distinct200/B-own-scope owner receipts classify ACTUAL EXPECTED EXTENSION RED. That remains overall nonzero1, never a pass. Any setup/control/timeout/usage/guard/source drift/unknown/mixed outcome becomes2/inconclusive and is retained, not called red. Wrapper75 is NOT STARTED; no spin/retry. Fixture afterAll removes only its own SQLite directory; the runner removes only its own fresh evidence scratch and terminates only its owned stage process group on interruption/timeout. Raw logs/manifest remain.

## Source freeze and later work

[source-inventory.json](source-inventory.json) records all798 selected main7c execution inputs. The baseline adds only its new fixture/test and assigned docs; unchanged base inputs must be verified against Git blobs at the frozen test-only head. [preparation.json](preparation.json) records planned files/counts and actual source hashes; it is preparation evidence, not a runtime pass. Exact final freeze SHA and all tracked file hashes belong in the external ROOT readback to avoid a recursive self-hash commit.

After actual red is inspected and ROOT authorizes production: implement only approved narrow route/reader changes; candidate validation must include the existing78 plus new complete importance/owner/security, cross-mode paging, missing-state/no-repair, CORS and actual metadata-work controls; then actual types/full relevant sequential gates and independent reviews under separate allocations. No implementation, final all33/device/UI acceptance, new PR, publish or merge is authorized by this checkpoint.
