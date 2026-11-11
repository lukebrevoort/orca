# BRE-454 / BRE-461 — incremental importance writes

Status: source candidate and focused semantic/work checks pass; fresh independent reviews and final hosted/root gates remain required. The public API/shared contract is unchanged from `2ebee41d`. This is API/database/synthetic Gmail persistence evidence, not client UI, provider network, notification or physical-device acceptance.

## Exact sources

- Historical semantic implementation / performance baseline: `2ebee41d73e3601610ef00dd39e5b81a60f486e2` (0052).
- Required coordinator checkpoint integrated **before product edits**: `ac8eba208d56a643a40772ecefef5c7e4e7c159a`, including the fixture identity fix `3d66783a102236c8052576b4c4998699262a80be`, review follow-ups and two exact-path whitespace exceptions. Those files and both original raw baseline logs remain byte-identical to the coordinator checkpoint.
- Stored paired benchmark/API artifacts: clean committed candidate `26b52c9b1b50805c4e7f3d0a6c5e72e8f6d5e3fe` (0053). Each JSON identifies its actual executed revision; **these stored receipts are historical when the final evidence commit has another SHA**. The PR reports final full-head reruns and their separate raw paths; do not relabel these files as that later head. Subsequent source changes in this follow-up are evidence/docs only.
- [Red replay](baseline-red-work.json): immutable Git SQL baseline `2ebee41d73e3601610ef00dd39e5b81a60f486e2` versus coordinator `ac8eba20`, before 0053 edits. All four <=2.5 doubling-work assertions fail: insert 3.59/3.77× and label refresh 3.84/3.92×. Actual callback failure log: [baseline-red-work.log](baseline-red-work.log).

[Open comparison charts and demo](comparison.html) · [raw SQL work/timing/CPU/peak RSS](paired-sql-work.json) · [actual production Gmail persistence samples](paired-gmail.json) · [API→DB→mailbox transcript](demo.json) · [read SQL and index plans](query-work.json) · [focused checks](focused.log).

## Root cause and final behavior

0052 deleted/regrouped all participants and recounted all messages after each email or label-association write. Gmail's actual `persistGmailMessages` path replaces changed-message label associations wholesale, amplifying the repeated work even for ordinary non-eligibility labels.

Additive 0053 backfills a body-free per-message metadata table once, then uses exact-address reference counts and incremental conversation votes. New/changed/deleted messages adjust only their cached membership, participant boundary votes and retained/time metadata. Same-sender duplicates do not re-aggregate the conversation. Latest retained time uses an index seek, preserving null/negative dates and out-of-order updates. Body/read-only edits do not write this cache.

INBOX/UNREAD/STARRED label refreshes cannot affect inbound eligibility and do not rebuild importance. SENT/DRAFT association changes recompute only the referenced message; real eligibility changes immediately update reference counts/votes. Label role/account edits use linked-message indexes; catalog deletion computes post-delete eligibility before cascading links disappear. Owner-address changes touch only messages from the old/new exact address using the metadata sender index. Thread/account cascades have indexed child probes. Explicit preferences still fan out proportionally to actual matching conversations, and read provenance still scales with returned conversations' distinct participants; no constant-work claim covers those operations.

0052 SQL remains unchanged. User choices, receipts and tombstones are preserved; 0053 rebuilds derived metadata once inside the normal migration transaction and advances each account revision. It does not change wire fields, routes, preview/confirmation/Undo/replay semantics, retention, HumanSignal, read state, rules, destinations, permissions or provider behavior. No `providers/gmail/sync.ts` edit and no notification migration/feature was added; 0054+ remains reserved for the parent.

## Actual paired SQL work

SQLite 3.53.4; callbacks at interval one, **not a VM-instruction or latency claim**. Both revisions load only immutable Git SQL with per-file SHA256 records. Separate fresh subprocesses take three callback-free timing/CPU/peak-RSS samples per size/phase/revision, alternating pair order. Migration/setup occurs before the timed phase. Peak RSS includes process setup and migration, not just the timed phase.

| Phase | Messages in one thread | 0052 callbacks | 0053 callbacks |
|---|---:|---:|---:|
| insert | 100 | 352,104 | 55,436 |
| insert | 200 | 1,264,004 | 110,636 |
| insert | 400 | 4,767,804 | 221,036 |
| labelRefresh | 100 | 2,996,440 | 47,312 |
| labelRefresh | 200 | 11,512,440 | 94,512 |
| labelRefresh | 400 | 45,104,457 | 188,929 |

The 0053 doubling ratios are near 2× in both workloads and satisfy the same <=2.5 gate that fails on 0052. This demonstrates bounded synthetic work scaling, not a universal user-visible speedup. Raw callback-free SQL timing/CPU/RSS samples and repeat ranges are retained.

## Actual production Gmail persistence path

Bun 1.3.14, bundled SQLite 3.51.0; same unchanged production `persistGmailMessages`, normalization and schema bindings, with each revision's immutable migration SQL. Fresh Bun subprocess per sample, three samples per size/sender set/revision. No provider fetch or transport is called. The second persist changes every message's ordinary label set; `changedEmailCount==N` and association rows 2N→3N prove that the real wholesale refresh path ran. Same-sender and all-distinct inbound sender sets are independently checked against materialized counts after both phases. Wall and process CPU include this persistence/normalization phase; RSS is a before/after snapshot, **not peak**. Background OS activity, JIT/GC and warm filesystem effects remain noise; samples are synthetic and in-memory.

| Senders | Messages | Phase | 0052 median wall ms | 0053 median wall ms | 0052 median CPU ms | 0053 median CPU ms |
|---|---:|---|---:|---:|---:|---:|
| same | 100 | insert | 58.68 | 21.14 | 76.47 | 36.74 |
| same | 100 | labelRefresh | 90.54 | 12.08 | 96.53 | 17.94 |
| same | 200 | insert | 167.01 | 30.04 | 190.24 | 52.91 |
| same | 200 | labelRefresh | 294.29 | 22.07 | 367.81 | 47.32 |
| same | 400 | insert | 529.59 | 53.05 | 608.34 | 96.76 |
| same | 400 | labelRefresh | 1025.95 | 45.04 | 1101.07 | 95.40 |
| distinct | 100 | insert | 104.74 | 23.59 | 123.96 | 42.67 |
| distinct | 100 | labelRefresh | 179.78 | 13.16 | 185.39 | 18.53 |
| distinct | 200 | insert | 423.95 | 34.70 | 413.98 | 56.33 |
| distinct | 200 | labelRefresh | 747.90 | 28.22 | 825.90 | 64.23 |
| distinct | 400 | insert | 1349.61 | 60.36 | 1432.57 | 114.08 |
| distinct | 400 | labelRefresh | 2686.79 | 48.79 | 2757.70 | 95.94 |

These are measurements of this finite fixture, not full Gmail sync/network timings or a general speedup factor. All three samples, min/max wall ranges, RSS snapshots, engine versions, preparation counts and migration hashes are openable in the raw report. Memory reduction is not claimed.

## Correctness, read bounds and reproduction

Focused suite: **20 tests / 948 assertions** at the stored candidate. New independent source-table oracle checks participants, refcounts, every aggregate/effective value, retained/time state, metadata row count and foreign keys after mixed incoming changes, drafts, multiple blocking labels, label catalog/account changes/deletion, sender/owner address changes, cross-account/thread moves, body/read edits and deletes. An existing-0052 upgrade test proves byte-for-byte preserved mail, threads, choices, receipts, reset tombstones and effective projections, then verifies future messages and rerun stability. Existing tests retain ownership, preview expiry, current reset inheritance, stale Undo/replay, ambiguous writes, thread recreation and legacy strict decoding coverage.

The API demo still passes eight independent assertions with zero provider calls. Important pages remain five/six SELECTs for first/next 50 items on 1,000/5,000 conversations, including indexed metadata probes and batched provenance, without bodies or per-row request/SQL fanout. Session middleware is excluded from those reader counts. Stored query plans expose actual work; output bounds alone are not used as proof.

```sh
python3 /tmp/orca-ui-heavy-slot.py python3 apps/api/scripts/importance-write-work.py <full-committed-candidate-sha> /tmp/NEW-work.json --assert-near-linear
python3 /tmp/orca-ui-heavy-slot.py bun apps/api/scripts/importance-gmail-work.ts <full-committed-candidate-sha> /tmp/NEW-gmail.json
python3 /tmp/orca-ui-heavy-slot.py bun test apps/api/src/importance packages/shared/src/importance.test.ts
python3 /tmp/orca-ui-heavy-slot.py bun apps/api/scripts/importance-fixture.ts /tmp/NEW-api-demo
```

Outputs refuse replacement. SQL scripts read/hash Git blobs, not mutable worktree SQL. The fixture keeps the coordinator's Git-C/full-SHA/untracked-source provenance guard. Full lint/typecheck/tests/build must run sequentially at the final committed/pushed head; prior `2ebee41d` gates and reviews are historical. No local Apple/browser acceptance is claimed.

## Rollback and limits

Rollback application code while retaining applied 0052+0053 metadata/triggers and user data; API wire semantics are identical. Do not drop the new metadata table or remove its triggers piecemeal, and never delete choices/receipt tombstones. A deliberate DB-level reversal needs an atomic reviewed migration restoring the 0052 triggers and rebuilding their derived state; that reintroduces the measured scaling problem. Existing pre-feature code ignores additive tables; no legacy/provider data needs reversal.

The new table/indexes add metadata storage and one upgrade/backfill pass proportional to retained mail. This is an explicit write-work/storage tradeoff. Very large preference fanout, migrations, label catalog changes and account-address changes still do proportional necessary work. Unknown unlabelled outbound aliases retain the existing model limitation; no sender/domain/AI generalization is introduced. Owned temporary databases are removed; raw evidence remains. The cooperative wrapper logs priority/resource snapshots and prevents concurrent heavy work.
