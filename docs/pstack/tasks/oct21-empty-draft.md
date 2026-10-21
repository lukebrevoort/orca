# October 21 bug sweep: cleared draft persistence

- Status: **running**. Owner: Codex /root; independent reviewer pending.
- Playbook: bug-fix, one owner plus independent review.
- Base: b1d3c3e8f4e8c75c0b9d7a64ba458366784ef86c. Isolated worktree /workspace/orca-oct21; branch fix/oct21-empty-draft-persistence.
- Rechecked main and open PRs before edits: only held #235/#262. Their specified files are excluded.
- Scope: web compose controller, focused autosave regression and existing synthetic browser compose harness.
- Acceptance: clearing all fields of an existing saved draft reaches its API record; interrupted/repeated Close and remount do not restore removed writing; untouched new empty composers create no remote records. Existing conflict/account behavior must pass.
- Root cause: content-presence gates suppress empty updates and mistake a versioned empty local checkpoint for absence during hydration.
- Baseline regression: test-only e007d04 (full SHA recorded in final evidence). Two failures, six passes. [Retained log](../../verification/oct21-empty-draft/baseline-regression.log).
- Privacy: synthetic example.com recipients, fresh loopback fixture/database/browser; no real mail. No API/schema/native/UI styling change.
- Next: focused and aggregate checks, exact committed browser trial, independent review, draft publication and hosted checks. No merge/deploy.

## Verified checkpoint

Final executable: `e863e1358358fba87afa1aee2f9480c511ea6d7a`. Independent reviewer `/root/review` approved this exact diff; 8 independent tests/53 assertions. Owner 34 focused tests/195 assertions, all workspace typechecks/build and exact-commit browser trial passed. See [evidence](../../verification/oct21-empty-draft/README.md) for failures, screenshots, limits and review dispositions. Initial aggregate had one unchanged Undo-test failure; baseline/candidate isolated suites both passed 46/46. Fresh aggregate and hosted checks pending; status remains running. No held work modified.
