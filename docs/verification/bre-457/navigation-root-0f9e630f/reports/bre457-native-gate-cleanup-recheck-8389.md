# Independent recheck: native Phase B gate cleanup

**Verdict: CHANGES REQUESTED.** The retained controls establish that the original single-SIGTERM and single-SIGINT orphan paths are corrected for the cooperative substituted stage. One blocking source-level interruption hole remains during cleanup itself. This review does not approve native features, component behavior, publication or merge.

## Identity and scope

- Reviewer: `/root/recheck_native_gate_cleanup_8389`, fresh independent reviewer, separate from the prior Phase B security reviewer. Inherited model; no model override or additional reviewers used.
- Immutable base: `36ac2e844715ec202d4b20841866e35afc2788b1`.
- Immutable head: `8389fb7548aa56ce67586fac18cfd2369095ad85`.
- Repository: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`.
- Reviewed the complete immutable diff and numbered head source. Git confirms that only `apps/ios/Tools/ReviewRegressions/phase-b-gate.py` changed. Product source, 414-case inventory and 44 grammar inputs are outside this delta and unchanged by it.
- Read the actual heavy-slot wrapper, external interruption-control source, prior security report and retained red/green result JSON. Applied the repository `interrogate` rubric.
- No checkout changes, compiler/tests, application/API/browser/CI/heavy execution, children, posting or merge. Only this external report was written. Reading JSON and Git objects does not re-execute the controls.

## Act on — P2: a second supported signal can interrupt cleanup and strand the stage

**Location:** `apps/ios/Tools/ReviewRegressions/phase-b-gate.py:29–31,46–63`, especially the cleanup wait at line52 and handler restoration at line62.

The handler always raises `GateInterrupted`, and remains installed while the `finally` block sends cooperative SIGINT and waits up to three seconds. If another SIGTERM or SIGINT reaches the driver during that wait, the new exception escapes this `finally` before SIGKILL escalation, terminal-group verification, restoration of the previous handlers, and stage-exit bookkeeping. The outer exception handler can still write a nonpass manifest, but it does not retry cleanup. Thus an owned stage that needs more than one cancellation signal or a short cleanup interval can remain alive after the driver exits.

**Concrete control condition for ROOT; not executed by this reviewer:** substitute an owned stage that records ready and ignores SIGINT, using the same real-entrypoint interception as the retained controls. After ready, send SIGTERM to the driver PID. Observe the driver's recorded group receiving cleanup SIGINT; during its three-second wait, send a second SIGTERM or SIGINT to the driver PID. The source path skips lines54–63, so the stage is not escalated by this driver. An independent coordinator must retain the slot and clean that recorded stage. This also applies to a signal arriving during timeout or normal-completion cleanup; the first signal in that cleanup window is sufficient to escape its `finally`.

This is a static control-flow finding, **not an observed new orphan or overlapping heavy run**. The inherited lock descriptor is a useful additional protection: if the surviving direct stage retains it, it keeps the slot occupied rather than permitting overlap. That does not terminate the stage or complete bounded cleanup, and can instead strand the reservation until external cleanup.

**Required narrow correction:** make cleanup non-reentrant with respect to the supported cancellation signals. Once cleanup begins, record/defer repeated signals rather than raising through it; preserve a nonzero interrupted outcome. Use nested `finally` protection so handler restoration and stage bookkeeping run even if cleanup operations fail, while continuing bounded escalation of the recorded group. Then extend the existing no-application-work control with a noncooperative stage and cancellation during cleanup. Preserve both existing single-signal controls and terminal/identity/nonpass assertions. A pass must establish stage/group terminality, not merely a nonzero driver exit or retained lock.

## Noted — retained red-to-green evidence is valid within its scope

Read from `/tmp/bre457-native-gate-interrupt-red-36ac/results.json`:

- Exact base36ac, source hash `5d3dbc64841c85a700a3a66127cc0fb75a58cd9c43a6f20c1ec44ff86b674126`, source stable.
- SIGTERM driver exit -15, stage survived; gate manifest absent.
- SIGINT driver exit -2, stage survived; gate manifest lacked completed end identity/exit.
- External coordinator subsequently made both owned stages terminal. Its slot remained held throughout; this did not demonstrate actual overlap.

Read from `/tmp/bre457-native-gate-interrupt-green-8389/results.json`:

- Exact head8389, source hash `94b1a742fffe401408c0e45b02978c7b8d0d1dda64abea89765f356ccf36c637`, source stable.
- SIGTERM driver exit143; SIGINT driver exit130. Neither cooperative stage survived.
- Both real gate manifests record `cleanup: terminal`, matching clean start/end SHA, `identityUnchanged: true`, correct nonzero exit, and all six later stages not started.
- The external control runs the actual gate through `runpy` and replaces only its first controller process with an owned Python sleeper. It intercepts unexpected grammar launch instead of executing Swift. No 414-case, Swift, API or browser validation is established here.

The sleeper terminates cooperatively on cleanup SIGINT. These controls do not exercise timeout, forced SIGKILL escalation, descendants remaining after direct-child exit, repeated signals, or signals during process creation. Do not label those branches executed green.

## Noted — lock, ownership and evidence guards

- The actual `/tmp/orca-ui-heavy-slot.py:31–32` passes its open flock descriptor to the direct gate. Head8389 line35 uses `close_fds=False`, allowing that inherited descriptor to survive into the isolated stage. This addresses the original default-close descriptor gap for that direct child. The retained control coordinator also held its own descriptor, so its evidence is not an independent test that a stage alone preserves the lock after both coordinators exit.
- Cleanup signals only the process group recorded from its newly launched stage PID, rather than searching process names or touching unrelated Simulator processes.
- Normal completion, timeout and supported single interruption share cleanup. The timeout exit remains124; a caught interruption maps to128+signal. Stage metadata is created before launch.
- End-source/clean-SHA guards now run from top-level finalization after caught failures. Missing coverage, API receipt, failure rows, incorrect pass counts, source drift and explicit cleanup failure cannot yield exit0 through the ordinary path.
- A group still present after the direct-child wait is killed and explicitly marked `cleanupFailure`; that forces overall nonpass. Terminality after this final kill is not independently awaited in this delta, so that branch must not be described as verified terminal. Its forced-escalation behavior remains unexecuted in the retained controls.
- A handler/Popen acquisition race and late signals during final manifest writing were not dynamically tested. This review does not claim SIGKILL-proof finalization or a comprehensive process-supervision guarantee.

## Boundary and remaining gates

The earlier C1 Settings catalog-status issue remains **OPEN** and is not revisited or cleared here. No product/component approval, 414-case run, 44-file grammar run, fixture/type/witness acceptance, hosted UI or screenshots are supplied by this cleanup review. ROOT owns the narrow correction, exact-source recheck, execution allocation and any publication decision.
