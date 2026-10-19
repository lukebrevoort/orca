# API lease-abort timeout diagnostics

The original hosted unit run for PR261 failed the API lease-abort test after 5000 ms. This follow-up adds stage traces to that test; it does not claim to fix the timeout or identify its cause. All original waits, abort action, assertions and the default five-second test timeout remain unchanged. No product/security implementation or native files changed.

## Revisions and existing evidence

- Immutable baseline: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`.
- Original PR head: `9172959a38929f2c55fa3508784ac29672857b38`.
- Diagnostic executable: `a6f3b1b9f181b9a55a05f215eb63d8a71e2a8b83`.
- Original hosted synthetic merge: `450703d24dea3e37eb228538ecba6c9c3e3a8383`.
- [Original failed unit job](https://github.com/lukebrevoort/orca/actions/runs/39287652704/job/118179373790): shared 95 and web 675 passed; API 778 passed and lease-abort timed out. [Original browser/API and iOS compose workflow](https://github.com/lukebrevoort/orca/actions/runs/39287652656) subsequently passed both jobs.

`comparison/` preserves the earlier bounded baseline/head evidence: isolated base/head/head/base runs passed; import-inclusive filtered runs passed on each; full API suites each passed 779 tests and 3044 assertions. API/shared source, dependencies and lockfile were unchanged. These establish local non-reproduction only, not flakiness, a speedup, or a proven host-timing explanation.

## Diagnostic scope

The original timeout cannot distinguish waiting for tool entry, a MessageChannel callback after abort, the second exchange, or first-exchange cleanup. An early response can leave tool entry pending; cleanup can obscure an earlier assertion. Fixed stage labels plus synthetic call counts, status, settlement state and error type now expose the last stage reached. Tokens, request bodies, response bodies, account data and error messages are not logged. Logging itself adds overhead and may affect scheduling; a green run cannot prove the previous failure is fixed.

Independent reviewer `/root/evidence_review` reviewed exact delta 9172959→a6f3b1b and found no blocking issue; model identity unavailable. This is not merge approval.

## Local verification

Bun 1.3.14, frozen existing dependencies, cleared environment containing only PATH and temporary HOME, and `--no-env-file`; synthetic test data only. No live mail or provider calls. `focused.log` records all 9 request-guard tests passing. `typecheck.log` records workspace typechecking. `api-final.log` records all 779 API tests passing with 3,044 assertions on the diagnostic executable. The trace shows first exchange status 499 after abort, second status 200, two tool calls and completed cleanup.

`probe.py` is the exact scratch fault-probe driver; its paths identify the owned scratch checkout and output used here. To reproduce elsewhere, create a detached diagnostic checkout with the same dependencies and change only those two paths. It mutates only the scratch test and restores it in finally. Each case has a 12-second outer process bound; Bun retains its 5000ms test timeout. No injected fault is committed to the test.

- Entry, MessageChannel, second-exchange and cleanup probes each fail at the original 5000ms timeout with their expected stage marker.
- Omitting abort fails the original assertion that the first exchange settles before deferred work completes.
- `probes.json` and individual logs retain all five expected nonzero exits. These red probes validate diagnostics and assertion strength; they do not reproduce the unknown hosted cause.

No hosted workflow was manually dispatched or rerun. A single push of reviewed diagnostic/evidence commits triggers normal PR checks; their final results belong in the PR body with exact head/merge SHA. Until those complete, local results do not establish hosted success.
