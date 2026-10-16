# Task handoff

Copy this record into `docs/pstack/tasks/<task-slug>.md` in the task worktree.
Keep it concise; link logs rather than pasting them. Replace every placeholder.

- Intent / selected playbook:
- Observable acceptance criteria:
- Owner / independent reviewer (agent identities; model if known):
- Status: **running**
- Updated (UTC):
- Base SHA / branch / worktree / draft PR:
- Scope and files owned; adjacent active PRs excluded:
- Dependencies / next action / blocker (with original failure log):
- Synthetic fixture and privacy/account-boundary assertions:
- Before-fix reproduction and log (or why not applicable):
- Final executable commit / final PR head:
- Verification: command, exit status, tested full SHA, artifact or CI link:
- Independent review: exact base/head, findings, dispositions, re-review:
- UI evidence: screenshot/demo links and visually inspected states, or not applicable:
- Hosted checks: head, merge SHA where applicable, run links and terminal results:
- Owned process/scratch cleanup; retained evidence:
- Limitations / skipped steps with reasons:

Status meanings:

| Status | Required meaning |
| --- | --- |
| running | Owner is executing a named next action. |
| blocked | State the concrete failure, preserved log, and prerequisite to resume. |
| review-ready | Acceptance, independent review, matching-surface final-revision checks and relevant hosted checks passed. Remaining nonblocking limits are explicit. PR may remain draft. |
| done | Authorized handoff completed and accepted; this does not imply merged or released. |

A docs-only evidence commit must be named separately from the tested executable
commit. Verify the diff contains only docs/evidence before carrying that result
forward. Any executable change, conflict resolution, or base integration requires
fresh relevant tests and independent review. Never mark stale/pending/failed checks
as review-ready, or infer a platform pass from another platform.
