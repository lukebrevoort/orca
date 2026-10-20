# Image eligibility performance

- Intent / playbook: perf-issue; avoid unnecessary eligibility parsing without changing policy, consent, output or account scope.
- Acceptance: differential malformed/ordinary HTML tests preserve eligibility; unchanged API response signatures; fewer measured provider sanitizations on image-free workloads; paired immutable timing/resource evidence; independent review and final-head CI.
- Owner: /root; independent reviewer: /root/measurement_review (same inherited model; no diversity claim).
- Status: **running**. Updated 2026-10-18 UTC.
- Base: e9f928258479aa7b46f7489c6e3e100c254a064f. Branch perf/image-eligibility-negative-fastpath; worktree /workspace/orca-oct18-perf.
- Scope: image eligibility helper, focused regression tests, synthetic benchmark/evidence. PR235 search/Railway, PR252/253 and merge-owner final-main monitoring/fixes excluded.
- Baseline investigation: /workspace/orca-oct18-evidence, 84 A/A samples; large image-free HTML spends substantial time in repeated provider sanitization/DOM construction. Existing 21 tests pass.
- Next: publish reviewed draft and follow existing automatic CI. No policy/cache/network change.
- Final measured executable: a2c7940b987df63d944d2218d5fcb7333b9dadac; product/test source at a909fa009bf10dac2dbe6e528b7bd0768b87404c. Later source commits change benchmark only.
- Evidence: [full report](../../verification/image-eligibility-fastpath/README.md), 336 accepted ABBA samples with equal full response hashes; 50 × 100 KiB image-free median 713.01→379.34ms and 50→0 provider sanitizations. Positive workloads regress 5.12%/9.52%; this tradeoff remains explicit.
- Review: /root/measurement_review approved product/equivalence and recomputed evidence. Earlier alias false-negative and random-fixture-ID failures retained and corrected.
- Verification: final 25 focused tests / 1,558 assertions pass; independent 5,280-case corpus: 0 mismatches; all workspace and harness typechecks pass. Local full suite: 1,537 pass / 1 MCP cost-budget failure; isolated file: 9/9 passes on both revisions. No integration fixes.
- Hosted baseline main confirmed green by merge owner; run 39159075394 browser/API and unsigned compose success independently read. New PR checks pending publication; this task is not yet review-ready.
- Cleanup: all benchmark fixture directories removed after successful processes; raw records and worktrees retained. No production data or sockets.
- Limitations: synthetic/instrumented, two process replicates per role, positive-input regressions unresolved, no production/native performance claim. Final PR status supersedes this pre-publication snapshot without an extra CI-triggering documentation push.
- No live mail, production load, infrastructure, credentials, migrations outside owned disposable fixtures, merge/release or new schedules.
- UI changes: none; existing hosted native checks will be reused on this PR, no manual dispatch.
