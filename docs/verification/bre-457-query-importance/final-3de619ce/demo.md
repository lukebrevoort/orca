# Verified BRE-457 query importance / owner fence — tested3de

Tested source `3de619ce8a92dc52182638fe5ba94de5ac63f380`, main base `7c97193688599e5996bb657c34227a63927c384c`. This is a new additive follow-up on merged PR320. A future publication must create a distinct draft PR; merged320 is not reused. Only two production files changed (12 additions/3 deletions): canonical catalog/results routes and saved-query reader. All source/testing results below refer to3de; the subsequent delivery commit contains docs/evidence only.

## Behavior and actual regression proof

Exact existing x-orca-importance-version:1 now enables the existing complete ImportanceResolution on every returned saved-query row, using the same final-page batched mailbox reader inside the current authorized query_only snapshot. Absent/unknown versions preserve basic JSON; Vary appends the version header. Missing returned-thread state503, unexpected corrupt state non-success; no invented Unreviewed/partial success, per-row GET/SELECT fallback, body/provider or lazy DML. Shared schema/default endpoints/evaluation/order/definition/object revision/digest/profile/HMAC/cursor format are unchanged. Cross-mode continuation is intentionally projection-independent and passed in both directions.

The existing OPTIONAL x-orca-expected-user-id precondition is explicitly attached only to canonical catalog/results reads. Absence remains compatible; matching200; malformed400; mismatch409/no-store before domain open. It compares against authenticated identity and never grants an owner/account. Cookie/mobile B's own valid scope with expectedU was the actual additive baseline witness; it was not anonymous disclosure or a missing endpoint.

[Original actual a19 red](../baseline-a19a3bba/summary.json) retains controls1/0 then extension0/5. The same original assertions are byte-identical at3de: actual enhanced200 now has all3 real Important/Not important/Unreviewed projections; all4 cookie/mobile×catalog/results owner mismatches now409 with1 auth connection rather than200/Bscope/2connections. [Focused raw receipts](focused/candidate.jsonl), [manifest](focused/manifest.json), [summary](summary.json). The23 new candidate checks were first executed at3de, not represented as earlier reproduced reds.

## Two separately allocated successful runs at the same clean source

ROOT's first gate: controls1/0(.968s), focused106/0(4.821s), actual shared project compiler1.727s, actual API project compiler7.580s, current finite Hono/SQLite/work demo1.487s. [All focused raw files](focused/manifest.json) include actual compiler observer/events and source hashes; no usage-only pass.106 includes original78 + unchanged5 regressions +23 new checks. These overlap full tests; do not sum as unique tests.

ROOT's subsequent full workspace gate ran only four serial stages, no standalone focused/demo replay:

| Stage | Raw/checked exit | Actual seconds |
| --- | --- | --- |
| lint | 0/0 | 14.380 |
| typecheck | 0/0 | 13.664 |
| test | 0/0 | 200.157 |
| build | 0/0 | 15.963 |

Actual complete test summaries: API1344/0/5774 expects/154files; web869/0/6148/70; shared191/0/240/23. **Total2404 passed,0 failed,12162 expect calls, no skip/todo.**251.244s guarded wall. Exact clean3de start/end; all5534 tracked execution-time inputs match; ownedRemaining[]; owned temp removed. Actual pinned Node24.22.1/Bun1.3.14/TSC5.9.3;3 actual successful project compiler witnesses per lint/types/build and a successful actual pinned Vite build/artifact. Raw/checked exits0, usagefalse, notStarted[]. [Full manifest](workspace/manifest.json), [compiler events](workspace/compiler-events.jsonl), [start](workspace/inputs-start.json), [end](workspace/inputs-end.json).

Complete unmodified stdout is [test.log](workspace/test.log); [full.log](workspace/full.log) is a byte-identical review alias, not another invocation. Binary/NUL bytes were retained. [Full wrapper stdout/resources](workspace/wrapper.log) and [extracted resources](workspace/wrapper-resources.jsonl) show actual direct AFTER exit0, memory48% before/45% after with46–47% samples during. This job's resource snapshots are observations, not a system/route memory guarantee. Direct wrapper exit was used; no tee/pipeline ambiguity. [Exact executed full driver](preparation/full-driver-executed.py) SHA3a623d5d0d661a02c0b0a6716b7aa8746d42222614f80043eeeb3b1a85edf85d. No new install or validation occurred during retention.

## Read-only/provider and work scope

Fresh-session routed request observers measured unchanged SQLite data_version/selected persisted tables and zero injected provider client/body/sync/transport calls. This is no committed-state change/provider-seam proof, not a universal network monitor or audit of every attempted/rolled-back statement on closed request connections. Separate actual reader callbacks observed inTransaction/query_only1, rejected UPDATE and total_changes0. The unchanged legacy fixture separately records near-expiry renewal1 auth write/0 domain writes. Catalog does not acquire the results reader's stronger snapshot/session-recheck/query_only guarantee merely from its owner fence. Mutation routes are unchanged.

[Raw finite demo](focused/demo.json):120 conversation work rows,40 contributing participants, limit3,3 rounds.12 actual Hono HTTP callbacks plus12 separate production reader calls, no listener/browser. Dense/sparse separate reader metrics scan4/76 candidates, retain4 and return3 on this fixture. callbackMs includes the fixture observers and is fixture-controlled request wall time; RSS is process-wide before/after, not peak or route allocation. Basic always precedes enhanced; timings are not counterbalanced. No speedup or DB/VM/heap bound.

[Dense](focused/dense-metadata-work.json)/[sparse](focused/sparse-metadata-work.json) replay the exact2 production metadata SQL templates with actual final authorized row pairs. Python SQLite3.53.4 observed2 SELECTs,3 state rows and20 preference rows; interval1 progress callbacks3184/4603; query_only1/changes0. SQL/source hashes and input statements are retained. This is actual Python SQLite metadata-statement work, not Bun VM/whole-endpoint SQL counts. Preference ranking can visit/sort more contributors than output20/thread; query counts/root checks and Unicode stream remain O(candidates) plus contributor work. Source +2 batch SELECT reasoning is not promoted to a measured entire Bun endpoint count. Work covers first pages only, not next/empty continuation work.

## Source review, gaps and historical truth

[Independent full source review](review/source-review.md) is APPROVED WITH COMMENTS, no production blocker. [Disposition](review/disposition.md) preserves timing/RSS labels and explicit gaps: complete nested tombstone/mixed inherited vote/opposite exact-sender preference cases at this seam, source-setup freshness versus mutation-endpoint proof, and next/empty/counterbalanced work. These are not silently marked covered by full-suite success. No tested product/fixture/runner source was changed for comments. No cancellation-injection test ran for these drivers.

Both2b setups remain NONPASS, not product red: missing dependencies, then invalid mailbox-without-attention seed masked by catalog normalization and rejected422 by the strict reader. ROOT's strict-schema+attention-all correction and ancestry guard are retained with original a19 red. Oldf232 parseroverall2/rawtest0 and cumulative same-source two-run proof, main97 direct-child proof despite omitted pipefail, old869 usage-only0/unexecuted types and all earlier source evidence remain unchanged under their original commits/scopes. Historical checksum lists must be compared to their recorded Git blobs, including old README versions, not this mutable current index.

## Delivery identity, client context and rollback

[Selected execution inputs](execution-inputs-tested.json) include851 product/runtime-source/config/lock/workflow/fixture-driver entries at3de; the docs-only delivery must match them exactly. [Tool hashes](tool-inputs-tested.json) cover the seven actual execution tool files. The whole5534 executed inventory is preserved as raw execution evidence; it does NOT remain the whole current inventory after new docs are added. Subsequent readback separately reports docs additions/index changes and selected input equality.

[Actual Git ancestry](ancestry.json): inherited303/309/311/314/315/316/318/319/320. Specific recorded310/312/313 heads are not ancestors; no current/pending client head is guessed. New own PR has not been created. Desktop/native consumers remain separately ROOT-owned pending integration work; unpublished client code is not inherited or accepted by this API leaf. No standard/AX light/dark, browser credential delivery, physical device, live mail, native/full33/deployment/release acceptance is claimed.

Rollback removes this leaf's opt-in/owner-fence wiring and completeness check while retaining merged320's result reader, saved definitions/choices/tombstones and inherited ownership protections. ROOT owns future publication, hosted/formal review and merge; no push/new PR/CI/watch/dispatch/merge occurred during retention.
