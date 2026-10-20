# iOS UI failure investigation and patch

## October 20 integration

The diagnostic implementation and its regression tests are already on main via commit `743d8ffbec4e87ce39d9aeefcb6acd7c04ec23d9`, which reused the exact PR #253 files. Main also contains assertion prioritization from `ee0ee866d14d199d0d6986e5c1f8a05649cf55cb` and newer fixture telemetry. The #262 exporter changes are therefore already present in main as well; its native changes remain separate.

Refreshed against main `6fa05f9cd6891a58a986fc922ebc4d94b3ac5efe`, this PR adds only the seven historical task/evidence files. Every pre-existing main blob is preserved; no exporter, test, workflow or application code is replaced. The original logs are unchanged. The sections below describe the October 16 checkpoint, not fresh execution or a fix for the unidentified original UI failure.

Current review/check status is maintained in [PR #253](https://github.com/lukebrevoort/orca/pull/253). #263 merged before this refresh; #253 remains held for parent sequencing. The cloud executor is unavailable during this refresh; repository comparison and integration use GitHub's supported APIs. No local test execution is claimed.

## Historical October 16 checkpoint

- Playbook: bug-fix with runtime-forensics diagnostic prerequisite.
- Status: running; diagnosis checkpoint before hosted native execution.
- Base: `5baf7f3ea9e208001c607a7bc0f5c418fb056d58`; isolated branch `fix/ios-fixture-diagnostics`, worktree `/workspace/orca-ios-patch`.
- Owner: `/root`; independent reviewer `/root/pilot_review` (separate agent, model diversity not claimed).
- User finish condition: diagnose and patch the iOS UI failure with assertions/coverage preserved, independently review, publish a focused draft and follow exact-head CI. No merge/release permission.
- Original evidence: [run38916549300](https://github.com/lukebrevoort/orca/actions/runs/38916549300/job/117026371921), UI16 tests/1 failure, exit65. `test36` passed; the failed assertion is absent from the final80-line tail. Light-mode failure stopped the runner before dark mode. Native unit totals are unavailable in the exposed tail.
- Access blocker: uploaded sanitized artifact download returns403 in this cloud environment; connector does not support annotations. No bypass or sign-in attempted.
- Concrete diagnostic defect: successful sanitization exports the full log but cleanup prints only its tail; earlier assertions can disappear behind later successful tests.
- First patch: print bounded failure context from the complete sanitized log only after its credential scan succeeds. Prefix every line; preserve exit code, raw log artifact, selections and UI assertions. No product/test synchronization change is justified yet.
- Verification: new regression against baseline fails for missing early assertion; eight exporter tests and eight lifecycle tests pass after patch. Original red log retained under `docs/verification/ios-fixture-failure`.
- Next: independent review, draft publication, existing automatic native CI. If it fails, use the new context to identify and repair the actual cause. A green run without reproduction does not establish a fix for the original UI failure.
- Exclusions: PR252 Reader web fixture and PR235 performance untouched. Synthetic data only; no local native execution on Linux, live mail, production migration, persistent credentials/security changes or infrastructure.
