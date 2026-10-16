# iOS UI failure investigation and patch

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
