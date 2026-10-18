# Image eligibility performance

- Intent / playbook: perf-issue; avoid unnecessary eligibility parsing without changing policy, consent, output or account scope.
- Acceptance: differential malformed/ordinary HTML tests preserve eligibility; unchanged API response signatures; fewer measured provider sanitizations on image-free workloads; paired immutable timing/resource evidence; independent review and final-head CI.
- Owner: /root; independent reviewer: /root/measurement_review (same inherited model; no diversity claim).
- Status: **running**. Updated 2026-10-18 UTC.
- Base: e9f928258479aa7b46f7489c6e3e100c254a064f. Branch perf/image-eligibility-negative-fastpath; worktree /workspace/orca-oct18-perf.
- Scope: image eligibility helper, focused regression tests, synthetic benchmark/evidence. PR235 search/Railway, PR252/253 and merge-owner final-main monitoring/fixes excluded.
- Baseline investigation: /workspace/orca-oct18-evidence, 84 A/A samples; large image-free HTML spends substantial time in repeated provider sanitization/DOM construction. Existing 21 tests pass.
- Next: conservative fast-negative check, policy equivalence review and frozen base/head measurements. No policy/cache/network change.
- No live mail, production load, infrastructure, credentials, migrations outside owned disposable fixtures, merge/release or new schedules.
- UI changes: none; existing hosted native checks will be reused on this PR, no manual dispatch.
