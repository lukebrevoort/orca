# Prepared full-workspace gate: frozen3de; no execution authorized yet

Exact source:3de619ce8a92dc52182638fe5ba94de5ac63f380, branch t3/bre-457-query-importance-read, clean. External preparation only. No checkout/source/docs/staging/commit/dependency changes, no new validation/compiler/parser replay/server/CI/push/PR/merge. Closed/mergedPR320 remains untouched and watch off. ROOT owns freeze, allocation, client workers and formal gates.

## Existing evidence and scope

ROOT's actual /tmp/bre457-query-importance-candidate-3de619ce-01 manifest was read: overall0; control1/0, focused106/0, real shared/API compiler stages, metadata demo; all raw/checked exits0; before/ending tracked hashes identical, final head3de clean, ownedRemaining[], scratch removed. These are the completed focused gates, not new runs by this preparation. The independent full source review /tmp/bre457-query-importance-review-3de.md is APPROVED WITH COMMENTS, with no production blocker. Its source-only verdict remains separate from later actual ROOT execution and formal approval.

The5 original additive regression assertions/control and all a19 actual red plus earlier2b setup NONPASS remain retained at their original scope. No historical result is rewritten. Prior saved-query869 usage-only0 type stages were unexecuted; f232 raw test0/original parseroverall2 remains NONPASS despite later cumulative proof; main97's launch without explicit pipefail is preserved and was justified only by manifest/stage/compiler/source/wrapper-direct-exit observations, never a tee exit0. This new driver uses direct subprocess returncodes and binary log capture; no shell pipeline or tee is involved.

## Actual workspace scripts inspected

Root package.json defines apps/* and packages/*, packageManager bun@1.3.14. Three workspaces define all four scripts:

- @orca/api (apps/api): lint/typecheck/build = tsc -p tsconfig.json; test = bun test.
- @orca/shared (packages/shared): lint/typecheck/build = tsc -p tsconfig.json; test = bun test.
- @orca/web (apps/web): lint/typecheck = tsc -p tsconfig.json; test = bun test; build = tsc -p tsconfig.json && vite build.
- @feedback-kit/core and @feedback-kit/react have no gate scripts. They are recorded, not assigned fabricated compiler/test passes.

The command bypasses root shorthand ordering that previously produced usage-only0:

    /opt/homebrew/bin/bun run --sequential --elide-lines=0 --filter '*' --no-install --no-env-file STAGE

It runs exactly lint -> typecheck -> test -> build. No standalone control, focused106, HTTP/metadata demo, Python metadata replay, browser or Apple stage repeats. Full workspace API tests naturally include the feature's registered tests as part of the required all-tests run; this is not a separate focused invocation.

Caps120/120/300/180 seconds; global work600 seconds overrides summed stage caps; proposed outer620 seconds is for preflight/final full source hash observation and owned cleanup only. Expected wall roughly4–6 minutes based on earlier full workspace execution, not the hard maxima.2404 tests (API1344/shared191/web869) is ONLY a source-derived estimate. Runtime pass/fail/expect/Ran counts from each workspace are authoritative and recorded even if they differ from this estimate.

## Exact prepared invocation, pending explicit ROOT allocation

Driver /tmp/bre457-query-importance-full-3de619ce.py and inventory /tmp/bre457-query-importance-full-3de619ce-inputs.json must match the SHA256 values in /tmp/bre457-query-importance-full-3de619ce-prepared.json immediately before allocation. The output path must be fresh; no retry/overwrite.

    python3 /tmp/orca-ui-heavy-slot.py python3 /tmp/bre457-query-importance-full-3de619ce.py --head 3de619ce8a92dc52182638fe5ba94de5ac63f380 /tmp/bre457-query-importance-full-3de619ce-01

Optional direct stdout/stderr redirection to a fresh .wrapper.log retains the wrapper's real command exit (there is no pipeline). Do not start the driver, parser checks, runtime versions or compilers until ROOT inspects and allocates. Install is excluded. No automatic continuation/retry after any failure/75: wrapper75 is NOT STARTED. Capture actual wrapper AFTER direct exit and the complete manifest/raw logs, not a shell tee status. Terminal allocator must inspect raw evidence, final source/owned cleanup and explicitly release the queue.

## Source/runtime/actual-execution proof

Mandatory inherited shared heavy-wrapper FD, exact frozen head/branch/clean status, no implicit env files and matching wrapper hash before any validation child. Prepared inventory includes all5534 Git-tracked inputs, each with mode/blob oid/size/SHA256, checked against actual working bytes and Git blob SHA1 framing. Input sets/hashes are checked before/after every stage and at terminal, including failure/interruption paths. inputs-approved/start/end artifacts, raw current Git tree hash, endSHA/endStatus and unknown/unobserved failures remain explicit. Ending source mismatch always overrides an otherwise successful result.

Seven execution-tool files are source-hashed and pinned: Bun/Node binaries; TypeScript entry/implementation/package; Vite entry/package. At allocation, actual Bun1.3.14/Node24.22.1 CLI version commands run as owned children; TypeScript package5.9.3 and entry/implementation hashes are recorded. PATH starts with the pinned Node directory. No provider/OAuth credential env is inherited. Lock/package.json/tsconfig/workflow/source data are in the complete tracked inventory; this is not a claim to inventory every node_modules byte.

Each runnable workspace's real script compiler must produce exactly one start/successful exit with pinned Node execPath, real TypeScript entry and exact resolved --project. Observer events retain actual argv/cwd/project/PID/stage, not test arguments or environment credentials. Compile usage-only0 is rejected; missing actual events is failure even if raw0. Build additionally requires a successful actual pinned Vite build event in apps/web and records current dist artifacts/hashes. Existing artifacts alone cannot prove build success.

Full raw stdout/stderr is captured as binary, retaining NUL and all workspace output with --elide-lines=0. The summary parser accepts the actual @orca/api:test | and earlier @orca/api test: prefixes, then requires exactly one complete positive pass/expect/Ran-files summary per runnable workspace,0 fail, no skip/todo, and consistent Ran/pass counts. Missing/duplicate/usage-only/zero summaries cannot pass. Actual counts replace the source2404 estimate; a count difference alone is recorded, not silently forced to match. No parser self-test/replay or syntax/compiler execution was performed during preparation; ROOT should inspect the new driver before allocation.

Raw and checked exits are separate. Source/cleanup/witness/summary problems turn raw0 into checked2 and stop further stages; real nonzero is retained. Setup/import/timeouts/signals are nonpasses, not regressions. Stage logs/receipts, manifest, observer/compiler events, artifact hashes, runtime metadata, source inventories, owned process receipts and not-started stage list survive failures.

## Ownership, signals and resource reporting

Every launched runtime-version/stage child has its own new session/group, inherits the actual wrapper FD, and is tracked by PID, PPID, PGID, birth and command hash. The tracker retains the newly created group after its coordinator exits and follows discovered descendant groups. Terminal parent exit does not establish descendant exit. Cleanup signals only these owned groups (never the driver's/shared parent group), checks remaining identities, records all observed owned processes, and fails if ownedRemaining is nonempty or unobserved. Only the fresh job's own temp subtree is deleted; source, evidence and existing outputs remain.

SIGTERM/SIGINT during spawn/wait are recorded and handled through owned cleanup/final source observation. SIGKILL cannot be caught; no cancellation-injection or uncatchable-signal resilience test has been performed on this new driver. Existing ROOT guard evidence is distinct, not relabeled as a test of this external driver. The driver prints stage starts/actual terminal times and15s progress; shared wrapper resource snapshots remain separate, allowing<=60s user updates during a later allocated job. No background watch/poll/dispatch is installed.

## Evidence comments and still-open claim gaps

Do not edit frozen3de to address comments in this task. Existing callbackMs includes f.request's table snapshots/serialization/data_version/JSON/assertion/receipt observers: label it fixture-controlled request wall time, not isolated callback latency or route allocation. RSS is process-wide before/after snapshots, not peak RSS or route-attributed allocation. Basic always precedes enhanced; timings are not counterbalanced and do not establish speedup.

The source-reviewed candidate covers important/not-important/genuine-unreviewed, conversation override, truncation, compatibility/tied/cross-mode paging, missing/corrupt state and account isolation. It does NOT explicitly compare complete expected nested null-choice tombstone or mixed inherited vote resolutions, or opposing exact-sender preferences in two accounts (the opposing-choice case uses conversation choices). Freshness uses direct source-choice setup/triggers, not a supported mutation endpoint test. Finite metadata work measured first pages only, not next/empty continuation work, and separate Python SQLite SQL replay is not Bun VM/endpoint SQL work. Keep these coverage/work limitations explicit; this full gate does not invent their evidence or repeat/expand that demo.

Existing query stream/count/root/contributor work can grow beyond output limits. No speedup, bounded DB/VM/heap claim, native/device/browser credential delivery/all33/deployed acceptance, release or merge approval follows from these local workspace scripts. ROOT owns any next coverage decision, independent review follow-up, source changes, publication and formal final integration/merge.
