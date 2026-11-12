# API320 after normal main97 integration

**Tested source:** `2ef7fb452d644a08afc1dac0ef154ac632310c55`, tree
`59ce77ceb4a781e31cd4f4fab1d8eea9a3504dc3`. Parents are published API320
`bfd47277a07b834740cd01547a5864f170395b7e` and current main
`97d0484d8358b8bf9207eca3b4ecf05012a0bac3`, which contains merged API319
`d8f66c7b2af3a4d7282621b42519efd906ac9b8f`. ROOT performed this normal merge;
this evidence-retention checkpoint does not alter product, fixture, runner or
workflow execution inputs.

The relative API/shared feature patch from main97 to tested2ef7 is byte-identical
to the reviewed old-base a6→bfd patch: SHA-256
`3fce22cb391293cf8e1ec3d41abfa170f508f6a73ee5155e476a654dceab0560`.
This is **relative patch equality**, not whole-branch/source identity with bfd or
f232. The inherited API319 changes required the fresh integrated run below.
[Original pre-runtime integration proof](integration-before-runtime.json) retains
its historical NOT RUN/NOT PUSHED fields; it is not the later runtime result.

## One fresh actual six-stage run

[Summary](summary.json), [complete manifest](raw/manifest.json),
[compiler events](raw/node-executions.jsonl), and [wrapper stdout/resources](wrapper.log)
record one actual root-owned run at exact clean2ef7 before and after, approximately
311.488 seconds, under the400-second work/450-second outer allocation. Pinned
Bun1.3.14, Node24.22.1 and TypeScript5.9.3 were observed. All six stages had both
actual child exit0 and checked exit0, with no execution-proof problems:

- All-workspace lint:22.611s, actual pinned compiler execution for each workspace.
- All-workspace typecheck:19.718s, actual pinned compiler execution.
- All-workspace tests:239.005s, **2376 passed / zero failed /12162 expect calls**.
  API1316/5774 expects, shared191/240, web869/6148. Complete summaries and run
  counts are in the [raw log](raw/test.log) and separately derived
  [NUL-escaped readable log](test-readable.txt).
- All-workspace build:22.371s, successful compiler and Vite execution/artifact proof.
- Focused query/mailbox/shared replay: **78 passed / zero failed**,5.532s.
- Current actual loopback HTTP/SQLite/work replay:1.558s, exit0.

Owned process groups were terminal and the owned temp root was removed. Retained
resource observations are measurements of this job, not a cross-version speedup
or system-wide memory guarantee. The complete driver is [retained here](driver-executed.py),
SHA-256 `579ff8db307c355ff873f93145e605071beded1f5972d3ebe942bb0ac8f957a2`.
Its [preparation snapshot](driver-preparation.json) and
[six offline summary guard controls](driver-summary-controls.json) remain separate
from workspace/API runtime evidence; they were not new semantic tests.

## Shell launch caveat: what proves the pass

The launch piped the wrapper through `tee` without explicitly enabling pipefail.
**The shell pipeline's reported0 is not used as pass evidence.**
[The original launch-status note](raw/launch-status-note.json) is retained verbatim.
Nothing retroactively adds pipefail to that command, and no duplicate run occurred
to repair reporting.

ROOT and this retention readback instead verified: manifest overallExit0; all six
actual raw/checked exits0; complete nonzero zero-fail workspace summaries; real
pinned compiler/Vite start+successful-exit records; exact clean start/end SHA;
and the wrapper's actual **AFTER event with direct driver exitCode0**. These
authoritative observations are all present. [Extracted resource records](wrapper-resources.jsonl)
are a derivative of the complete unmodified wrapper log. A `tee`0 alone would
never satisfy these conditions.

## Current API demo, read-only proof and honest work limits

[Actual current demo JSON](raw/demo-work.json) records three real loopback HTTP
requests: notify-only200 returns exactly `notify`; Unicode cross-field person
AND independent text200 returns exactly `person`; foreign-account404 returns no
rows. Catalog/query/auth/Inbox/All Mail preconditions and routing passed first.
Application external-network/provider-sync/transport counters were all zero;
the caller's three loopback requests are counted separately. All twelve request
connection change measurements were zero.

[Current focused receipts](raw/focused-receipts.jsonl) independently retain actual
`inTransaction=true` and `query_only=1`, an UPDATE rejected as read-only, and
zero final changes. Existing cookie renewal remains a separately labeled
**one auth write / zero domain writes** exception. Session/mobile revocation,
including between middleware authentication and the domain snapshot, account/query
deletion, corrupt definitions, stale/tampered/cross-scope cursor, missing state
without repair, repeated sparse/tied pagination and Unicode predicates passed.

The finite330-row work addition retains three alternating dense/sparse pairs on
the same account/order/limit. All three sparse rounds scanned**104 candidates to
return3 rows**, metric maxRetainedRows4, one-row iterator batch, three candidate
SELECTs and15 total SELECT preparations. Actual timings/RSS are in JSON. These
are not VM steps, matching totals, a speedup, or a bounded database/memory claim.
Worst-case streaming remains **O(candidates)**; existing SQL aggregates, state
checks, sort and page-cache work can grow independently of the response limit.

The strict route/schema/profiles/cursor/error semantics are unchanged relative to
the reviewed feature. Resolve owned raw query IDs, not client definitions. Query
revision is the saved object revision, not schema revision1. Generated stored_mail
delegates unchanged; legacy global-latest/explicit-clause/Unicode regularizations
remain the named approved semantics, not exact historical browser bug parity.
No live provider, native client, browser UI, local Apple or all33 acceptance is
implied by this API branch's full workspace checks.

## Historical scopes remain intact

The [f232 evidence](../final-f232399/demo.md) is still the actual **two-invocation**
old-base gate:2360/0,12111 expects, plus78 and current-at-that-time HTTP/work.
Its original overallExit2 parser NONPASS is unchanged; actual raw test0 was later
validated by ROOT's corrected prefix parser before remaining stages. It is not
relabeled as this new one-invocation2376/0 run. The initial bfd delivery has795
selected input entries; this new snapshot has798 because main changed.

Earlier bc fixture setup failure,1f9 authenticated endpoint-absence404 with zero
semantic comparisons,869 first-executed semantic checks and usage-only0 type
NONPASS, actual compiler correction and runner boundary red2/4→green4/4 remain at
their original hashes/scopes. No new semantic red-to-green claim is made here.
No old manifest, driver, raw log or historical checksum was rewritten.

Historical checksum lists refer to their original delivery blobs (including the
older current-index README). Compare them with their recorded old Git head,
not the later mutable current index. The new [hash manifest](hashes.json) covers
this retained bundle and current index; [retention provenance](retention-provenance.json)
identifies every unmodified raw source copy. [Execution inputs](execution-inputs.json)
must remain exactly equal to tested2ef7 in the subsequent docs-only delivery head.

## Publication, ancestry, reproduction and rollback

PR320 remains published at old bfd until ROOT reads this checkpoint and explicitly
clears a coherent push. The integrated source and this new evidence checkpoint
are not yet pushed. Verified inherited heads now include
**303/309/311/314/315/316/318/319**, plus own320. Current supplied310/312/313 heads
are not inherited; see [ancestry proof](ancestry.json). PR316's head is inherited
even though that PR closed without its own merge. API319 is inherited through
formal main97; it is not a new API320 feature change.

Portable focused and HTTP/work commands remain in the parent
[contract/evidence index](../README.md). No new install/run was performed during
retention. Shared-Mac reproduction requires an explicit ROOT allocation and one
cooperative wrapper. ROOT owns next hosted/formal/native/all33 gates and merge;
native36ac's separate review/acceptance is not changed by this run. No native wire
integration or physical-device/live-mail/release/deployment claim is made.

Rollback removes the additive saved-query route/exposure while retaining saved
definitions/customizations and inherited main97/API319 ownership protections.
Do not treat rollback of this leaf as permission to undo its merged base.
