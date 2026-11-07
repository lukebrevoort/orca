# BRE-443 web image latency

- Intent / selected playbook: perf-issue; reproduce synthetic delay, implement the smallest supported improvement, independently review and deliver a draft PR with video.
- Status: **running** — local implementation/evidence complete; final aggregate and hosted checks next. This record is the pre-publication checkpoint; the PR description records subsequent check results.
- Base: main 2f4b2f8e216635696cf09f5dc8cf7c64e6f11204. Branch codex/bre-443-image-loading-latency; /workspace/orca-image-latency. Remote main rechecked through GitHub immediately before publication preparation and unchanged.
- Owner: root; independent reviewer latency_design_review (requested model gpt-6.1-sol, high).
- Executable: e9ad28001c301dbfd3134cb5155f3178e7c320a1. Later changes are documentation/evidence only; final PR head and checks are recorded in its description.
- Scope: image renderer/route, shared image task permits, web stream consumer and targeted reader slots, synthetic fixtures/measurement scripts/tests. #295, #298, Summary race work, live sender/mailbox requests, merge/release/deployment/migration and security-setting changes excluded.
- Evidence: [measured findings and reproducible commands](../../performance/bre-443-image-latency.md), [24 final samples](../../performance/bre-443-measurements.json); local complete build proofs/videos at /workspace/bre443-release-matched. Matched baseline/candidate source identities remain explicit.
- Independent review: full candidate plus subsequent source delta reviewed at exact executable; no blockers, 43 tests/276 assertions passed. Fixed the review's long-alt-text protocol cap issue, including whole-stream bound arithmetic and regression.
- UI: light/dark actual-app flows passed, frames and labels inspected. Video saved as Library libfile_ff32bde3bdd881918bb97f26342fda1d version1. Named demo skill source unavailable; prior supported recording workflow used without installation.
- Cleanup: both comparison servers and browser were owned and cleaned by the runner; light/dark flow runners also exited0 and cleaned. Intermediate hung harness was stopped through the verified child browser; its logs/video retained. No unrelated fixture was stopped.
- Next: applicable aggregate checks on final documentation head, authorized push/draft PR, then existing hosted checks through success or a concrete blocker. CLI Git authentication failed during a read-only fetch; the connected GitHub read confirmed unchanged main. No credential configuration was changed.
- Limits: synthetic small samples, no production proxy or actual newsletter diagnosis, no new native client protocol. See performance note for phase-measurement limits and preserved legacy exception.

## Hosted iOS diagnostic follow-up

PR #302 at 8968adc passed unit, browser/API and native reader/image checks, but its general iOS fixture was cancelled at the configured 60-minute limit. The visible log confirms simulator boot finished; the subsequent private checks log was not exported, so neither a boot timeout nor a Photos-picker failure is established. No unchanged retry was performed. The shared Photos-picker work in PR #301 now has a green run at 4d63cf2; its test changes are not copied into this branch without a matching failure.

Add fixed live stage markers around boot, Swift contract, Xcode discovery/build, light/dark tests and evidence export. Raw command output, launch arguments and fixture credentials remain in private logs for the existing sanitizer. Tests, assertions, timeout and product code are unchanged. Shell syntax, 11 readiness tests and 25 evidence-export tests passed before review; the next automatically triggered exact-head fixture must pass before merge. Preserve the existing Library demo identity and measured application commit because this follow-up changes diagnostics only.
