# A bounded Orca task, from scope to draft PR

Use the local `poteto-mode` and `interrogate` skills. One owner and one independent
reviewer are sufficient for a small task; split implementation only where scopes
are independent. This is a finite session procedure, not a background scheduler.

1. Read `AGENTS.md`, relevant context docs, git status, current main, open PRs and
   the selected playbook. Check ownership before choosing a real task. Record
   observable acceptance criteria and exclusions using [task-template.md](task-template.md).
2. Fetch the base, resolve its full SHA and create a new worktree/branch. Preserve
   the original checkout and any existing worktree. For example, from the repo:

   ```sh
   git fetch origin
   git rev-parse origin/main
   git worktree list
   git worktree add ../orca-my-task -b fix/my-task origin/main
   ```

   Substitute a new descriptive slug. If using Linear, include its ticket ID as
   required by `AGENTS.md`. For a stacked task, explicitly substitute the reviewed
   dependency commit and name the intended PR base; do not silently pull unrelated
   draft work into a product fix.
3. Follow [cloud setup](cloud.md) in that worktree. Do not copy `.env`, credentials,
   mail databases or a live browser profile. Reproduce the behavior with synthetic
   data; retain the failing log before editing. Update the record to `running` or
   `blocked` with a concrete next step.
4. Implement the smallest supported change and commit. Give an independent agent
   the intent, immutable base/head, owned files, tests and privacy boundaries.
   Record findings and dispositions. Fix blockers, commit and obtain re-review.
5. Verify the committed final revision on the changed surface. For compose, use
   the existing `verify.py trial` and `evidence --commit <full-sha>` commands. Other
   surfaces need their own focused tests/harness; a compose pass cannot substitute.
   For UI, inspect usable screenshots/demos and relevant states in both themes.
6. When authorized, push and create/update a **draft** PR with intent, exact tested
   commit, reviewer verdict, evidence and limitations. Prefer an early checkpoint
   after a coherent reviewed unit; batch subsequent fixes to avoid redundant CI.
   Use GitHub CLI or connected GitHub tools. If CLI API access is forbidden, a
   successful connected read is a valid alternate interface; do not change tokens,
   credential helpers or sign into a browser to bypass the failure.
7. Follow automatically triggered checks on the final PR head to success or a
   concrete blocker. Reuse existing runs; record merge SHA versus head SHA where
   CI tests a merge ref. Native checks run through existing hosted macOS workflows.
   Do not dispatch duplicate runs. Update the record and PR with final evidence.
8. Stop owned processes and clean only owned disposable fixtures. Retain logs,
   screenshots, draft branches and reviewable worktrees. Set `review-ready` only
   when its template gates hold. Hand off the draft for human decision; no merge,
   release, deployment or persistent security/configuration change is implied.

The record is the resumable status surface. On a new instance, reread it and
recheck remote head/checks before resuming. A previous agent's `running` label is
not proof that a process or owner is still active.
