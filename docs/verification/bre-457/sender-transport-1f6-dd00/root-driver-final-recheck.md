# External navigation driver — final narrow recheck

**Verdict: APPROVED WITH NOTED LIMITS for the driver guard correction under normal, nonoptimized Python invocation.** The previously blocking failed-case-row path is closed at the reviewed driver hash. No remaining blocking finding was identified in this narrow delta. This verdict does not approve Phase B, product behavior, native UI, API acceptance, cleanup validity, merge, release, or deployment.

Reviewer: `/root/recheck_navigation_driver_failed_rows_final`, independent from ROOT's correction; inherited model, no model-diversity claim. Applied the Orca `interrogate` rubric. Read-only inspection of source, full retained driver diffs, harness, and saved JSON receipts; no tests, compiler, browser, server, heavy checks, CI, children, or checkout edits. Only this report was written. These are external temporary scripts, so immutable artifact hashes identify the reviewed revisions rather than repository commits.

## Reviewed artifacts

| Artifact | SHA256 |
| --- | --- |
| Final `/tmp/bre457-navigation-phase-a-driver.py` | `2399c9803b9c14d1abaff0088b9dd5dd2ba75a79e26cb20364a6c9a89dba412f` |
| Original `/tmp/bre457-navigation-phase-a-driver-before-guard.py` | `7a4131524e1315560f4a267ce911b2d03bf14d495b8f006b8ecfdd6675e33481` |
| Intermediate `/tmp/bre457-navigation-phase-a-driver-count-guard-only.py` | `11e0459f2df9472886ac4bdabe24fc99d21e475789124290590383ed5cedb67e` |
| `/tmp/bre457-navigation-driver-guard-tests.py` | `4571d1090b61f07439d954792265ef0c8c73db7e3b9b31a52d4a9091acb9e845` |
| `/tmp/bre457-navigation-driver-failure-row-red.json` | `ecb39faacc28aedaf2263e8ab494e9319e266eb51dcbb6023675f5ec3a34c19d` |
| `/tmp/bre457-navigation-driver-guard-final-green.json` | `eddf074738c8ad8a712646925d8f1330cdb94cce51c8cb4cf626651ab850d3dc` |

## Findings

**Act on — closed: failed row with controller exit zero.** Final driver lines 35 and 38 require all expected rows to pass and no recognized failed rows before permitting a zero exit. In the controlled regression, 267 distinct rows with 266 PASS and one FAIL still satisfy coverage, but now yield exit 2 despite controller and grammar exits zero. The saved intermediate red receipt records the old false zero (11/12 controls matched expectations); the final receipt records exit 2 and 12/12 matched expectations. Both receipts name the corresponding driver hash. The harness runs the actual driver via `runpy` while mocking subprocess, git, and selected file observations. I inspected this evidence and did not rerun it.

**Noted — raw child failures remain visible.** Driver lines 12–23 append each child exit and timeout to `stages` before admission decisions. Line 36 keeps controller nonzero status ahead of grammar status; a missing grammar stage becomes 124 when the controller succeeded. The new failed-row predicate only changes a zero final exit, preserving controller exit 1 in the supplied controller-failure and failed-row/child-one controls. Identity, coverage, or receipt rejection may still set the final exit to 2, while the stage record retains the child result. The saved harness receipt checks final exits, not the stage arrays; raw-stage preservation is supported by source inspection. Timeout/signal paths were not exercised by these twelve controls.

**Noted — existing admission guards remain intact.** Driver lines 31–38 require unchanged HEAD, clean end git status, identical hashes for the captured Swift inputs, expected completed count, recognized PASS/FAIL count, unique case IDs, and presence of `controllers/api-evidence.json`. Saved controls cover missing, extra and duplicate rows; end HEAD/status/source-hash drift; missing API receipt; and grammar failure. The all-pass control remains zero. Empty or unrecognized result inventories fail coverage for a positive expected count by source inspection.

**Noted — optional expected count supports a separately frozen 275-case run.** Line 3 defaults to 267, accepts an explicit integer third argument, and requires it to be positive under normal Python execution; line 10 records it in the manifest, and lines 34–35 use it consistently. The twelve supplied controls exercise only the default 267. There is no saved executed 275-case proof here. Before that run, freeze the correct inventory and pass `275` explicitly. This guard checks count and uniqueness, not equality to a named inventory manifest; the caller owns selection of the correct expected inventory.

**Consider — invocation and evidence boundaries.** Initial expected-SHA/clean-status, source-count, and positive-count preconditions use Python `assert` (lines 3, 6–7). Invoke normally, without `-O` or `PYTHONOPTIMIZE`; optimized execution is outside this approval because it removes those checks. Source identity covers the captured 37 Swift files, not every dependency. The API guard checks path existence only and does not validate JSON contents or establish successful cleanup. Exceptions can leave partial/running evidence but do not constitute successful completion. These limits must accompany any admission claim.

## Security and delivery boundary

No introduced credential exposure, destructive cleanup, or new product authority appears in this guard delta. Its benefit is evidence admission correctness. Saved control proof does not run the Swift compiler, API, browser, or provider and is not product runtime acceptance. The historical actual 461 run remains **267 completed / 264 PASS / 3 FAIL, NONPASS**; this recheck neither reran nor invalidated that result. All product, integration, Phase B, UI, and external-action gates remain with ROOT and the user.
