# Independent native Phase B security and verification-boundary review

**Verdict: CHANGES REQUESTED — one Act on finding in the new gate's interruption cleanup.** No introduced product authorization or cross-account disclosure exploit was established by this static review. This verdict does not approve runtime behavior, hosted UI, publication or merge.

- Reviewer: `/root/review_native_navigation_security_36ac`, independent security/boundary reviewer; correctness review is separate.
- Worktree: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`.
- Immutable base: `93000c6116b61c80684fb8dd337ff28eb1793389`.
- Immutable reviewed head: `36ac2e844715ec202d4b20841866e35afc2788b1`.
- Feature source: `c65f303a469efd7f1e120208f21fced95a049edb`; main integration: `d9848cdd2e4335b03f850f3cd8ce10d07acbba07`, incorporating `97d0484d8358b8bf9207eca3b4ecf05012a0bac3`. Prepared integration/source manifests were read; final readback remained clean at exact36ac.
- Scope: source/diff, production callers, regression source, fixture/probe/driver and evidence claims. No tests, compiler, API server, browser, simulator, CI operation, provider call or controlled interruption was executed. No checkout file, staging or commit was changed. Only this external report was written.
- Applied review instructions: repository AGENTS and `.agents/skills/interrogate/SKILL.md`.

## Act on

### P2 — Interrupted gate can release the heavy slot while its isolated stage continues

**Location:** `apps/ios/Tools/ReviewRegressions/phase-b-gate.py:24–31`, with top-level finalization at `:58–60`. Composition checked against the actual `/tmp/orca-ui-heavy-slot.py:31–42` wrapper.

The new driver creates each stage with `start_new_session=True` at line24. Its `wait()` handles only `TimeoutExpired`. There is no signal handler or `finally` that terminates and waits for the active stage on coordinator interruption. A SIGTERM to the driver uses Python's default termination and does not run its top-level `finally`; KeyboardInterrupt can run the top-level manifest writer but still bypasses child cleanup. The child stage's new session prevents ordinary coordinator/process-group interruption from necessarily reaching it.

The wrapper passes its lock descriptor to its **direct** driver child and waits only for that child. The driver's stage `Popen` uses default `close_fds=True`, so the isolated stage does not retain that lock descriptor. When the driver exits, the wrapper can finish and release the slot although `run.py`, its compiler/regression executable, or its API fixture continues in the isolated stage group. A subsequent allocated heavy job can overlap it. On SIGTERM there may also be no final driver manifest or cleanup record to distinguish this interruption from an unexplained partial directory.

**Narrow controlled reproduction for ROOT, not executed by this reviewer:** start the approved driver through the heavy wrapper; after its `controllers-api` stage is demonstrably active, signal only the `phase-b-gate.py` PID with SIGTERM. Observe whether the stage's recorded process group still contains owned work after the driver/wrapper terminates and whether the heavy lock is acquirable. Repeat the interruption path with SIGINT if desired. Use explicit recorded owned PIDs/groups and disposable output; do not identify ownership by executable name or touch unrelated Simulator processes. This is a deterministic control-flow concern from the source, not a claim that a real orphan or overlapping workload was observed.

**Required correction:** give the coordinator an explicit active-child lifecycle. Convert supported interruptions into a common nonpass path; terminate, wait and if necessary escalate only its recorded stage process group in a `finally`, including interruption while waiting. Preserve interrupted/timeout/nonzero distinctions, mark subsequent stages not started, retain identity/resources and cleanup outcomes, and exit nonzero. Close the heavy-slot ownership gap before allocating the native gate. An owned controlled interruption regression should demonstrate both terminal child ownership and retained nonpass evidence. A passing ordinary run alone does not close this finding.

This finding concerns verification/resource ownership, not a demonstrated mail-data authorization bypass. It is blocking for use of this newly proposed gate under the established single-heavy-slot and owned-cleanup contract.

## Product boundary assessment

### Verified owner, connection and origin

Reviewed new APIClient authorization hooks, AppState's real context factory, catalog/results controllers and actual SwiftUI callers. The relevant new paths use an authenticated-user result and a verified connection/origin, rather than treating a cached account or editable server field as authority. `AppState.nativeMailContext` requires ready state, matching verified connection generation and origin, a current nonempty user, a selected owned account and unique owned account IDs. Configure/logout rotates the connection boundary; cold cached fallback does not invent a verified context.

APIClient binds the endpoint before its first suspension, checks the supplied authorization before dispatch, rechecks after token lookup and after response, and checks final response origin. The new closures combine captured client identity/origin and current context/generation. The existing redirect delegate removes Authorization when redirect origin changes. I found no concrete path in the new integration that sends a newly authorized request to a later edited origin or publishes an old owner's response into a new context. The actor's `updateBaseURL` has no new production caller; origin ABA and held-token cases are regression **source**, not executed proof.

Legacy API methods retain optional-hook defaults; this review does not relabel all inherited requests as uniformly opted into the new callback. Existing mutation protocols and the separately reviewed main API319 changes are not independently reapproved here.

### Catalog, typed routes and API320

Reviewed `NativeMailCatalog.swift`, `NativeMailWire.swift`, browser/results controllers and their production integration against the inherited published shared API320 schema and evaluator metadata contract. New decoders reject unknown object keys and validate account, query identity, object revision, canonical definition digest, evaluation profile, row ownership/provider, freshness and continuation scope before accepting query pages. The query definition canonicalizer follows the published field/default/profile shape and has actual-server/JavaScript golden-vector test source. Limits and opaque continuation are carried to the endpoint rather than reconstructing a saved query as generic Inbox search.

Typed resource targets distinguish collection, query, thread, legacy mailbox view and sender; an arbitrary URL is not a target family. Sender resources are labeled/routed as an All Mail name/address substring query rather than exact sender-importance identity. Literal plus encoding is handled at URL construction. The historical actual server raw-query versus percent-encoded positive control establishes the earlier plus mismatch; new candidate execution remains absent.

Internal mailbox navigation goes through current typed identities and the shared dirty-Settings leave guard, revalidating captured context before applying a pending transition. I found no new external-URL-to-native-resource authority path. Existing notification handling is not transformed into a generic externally supplied catalog route.

### Stale responses, cache and local visibility

New catalog/result keys include original origin, verified user, connection nonce, account and owned-account set; results additionally bind route/query provenance and read revision. Publication rechecks current generation and scope after suspension. Account/scope changes invalidate active result state. The results view's identity changes with context and route, preventing intentional reuse of an old account's StateObject for a different route.

Transient errors can retain accepted owned rows or same-context offline data. Auth/ownership/malformed/query-change failures clear or block affected result cache instead of silently replaying it. Continuation freshness changes are rejected. Typed `invalid_cursor` alone receives the bounded restart policy; ordinary errors are not treated as a generic restart/unlock. Required catalog reload is exposed separately. These are static control-flow observations; availability and all rendering/error states still require execution.

Hidden choices use local device preference storage scoped by owner, with account-bearing typed identities for account resources. Fixed Important/All Mail cannot be hidden. The new state is a presentation preference and is not used as an authorization decision. No global cache purge or remote organization write was introduced as part of Hide/Restore.

## Fixture and cleanup-compensation assessment

Reviewed the explicitly authorized `apps/api/scripts/mobile-fixture.ts` addition, `RoutingCompensation.swift`, test10 callers, compensation regression source and `routing-witness-probe.py`.

- Witness access requires the real fixture Bearer and permits only fixed synthetic owned thread targets. SQL reads use bound fixed owner/account/thread values. The receipt list is bounded at128 and reports truncation; it contains whitelisted command/ack/revision/timing fields, not tokens or arbitrary mail bodies.
- The wrapper clones the **real** PUT response after `app.fetch`, validates its actual strict result shape and only records a successful ack when account/thread/undo-target match. It returns the original application response; it does not manufacture an acknowledgement or substitute a success route.
- Compensation pre-registers original explicit selection, global revision and receipt ordinal before the UI mutation. The used planner requires a complete, untruncated, contiguous successful command/ack chain; exact account/thread, allowed destination, expected revision, incremented ack revision and inverse undo target must match. Missing, rejected, extra or ambiguous chain data fails closed.
- The final compensation PUT uses the last exact acknowledged revision and the original explicit null/ID. A later GET is not used to acquire a newer revision for an overwrite. A no-command path verifies original revision, and successful test10 cleanup occurs before later View authoring can advance the organization revision. This is synthetic sequential-fixture attribution, not a new production transaction-ID authorization guarantee.
- The13-check witness probe source includes real successful mutation/undo, stale409, unauthorized access, independent synthetic SQLite state and provider/delivery invariants. It starts and terminates its own fixture and validates output coverage. None of those checks has executed for36ac, so the probe is a planned check rather than retained green evidence.

No new production API route, schema authority or credential handling is introduced by this fixture exception. The gate interruption finding above still applies when its probe is run as an isolated stage.

## Evidence and remaining gates

The prepared README, source/integration manifests and expected case inventory honestly describe source preparation. Reviewed test source covers new strict model rejection, catalog/result ownership, connection/origin changes, cursor/freshness failures, independent real-API positive controls, query golden vectors and compensation planning. The fake AppState regression adapter is distinguished from separately authored real-AppState hosted unit coverage.

The gate checks exact414 unique case IDs, missing/unexpected coverage and real pass/fail rows rather than accepting an exit code alone. Its44-file grammar stage is independently recorded even after controller failure. Fixture/transitive TypeScript is invoked directly, and the witness/runner/project checks fail closed in the ordinary completion path. Those useful normal-path checks do not repair the interruption hole.

**Noted, not acceptance:** all new414 cases,44 grammar inputs, fixture types,13 witness checks and updated lifecycle selections remain unexecuted at the reviewed revision. Seven new hosted units and UI54/55, current native geometry/event handling, screenshots, physical-device behavior and integrated hosted acceptance remain pending. Existing historical223/275 and viewport receipts do not establish the new features. Reader/Tools/Compose/DraftStore and viewport product boundaries were kept outside this new implementation scope; inherited failures are not cleared by this review.

No additional product-security Act on or independently supported exploit was established. This is a scoped static review, not an exhaustive repository security certification. ROOT owns correction/recheck of the interruption finding, independent correctness closure, exact final-source execution and the publication/merge decision.
