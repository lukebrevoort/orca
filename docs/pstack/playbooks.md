# Local playbook procedures

These replace Cursor-specific orchestration and upstream shipping permissions. Each invocation states which procedure is selected and records skips with reasons. All use the permission boundary in the local poteto-mode skill.

## investigation

Read the affected source and history. Distinguish how from why; cite files/commits and separate observed facts from inference. Deliver the answer read-only, without a PR.

## feature

State observable acceptance criteria; map callers and data shape, compare designs at boundaries, implement a small unit, verify the changed user surface and side effects, then request independent review and open/update a draft PR.

## bug-fix

Reproduce on the matching synthetic surface and retain failure evidence. Eliminate competing causes using runtime observations, implement the smallest supported fix, rerun the same repro plus relevant regression checks, and retain before/after evidence.

## perf-issue

Use the existing relevant harness to collect a tuned baseline, errors and trace. Name the limiter; change one hypothesis, alternate matched before/after runs, report sample count, median/range and end-to-end relevance. Inconclusive is not a speedup. Do not duplicate active search benchmarks.

## hillclimb

Apply the performance procedure to an explicit metric and stop condition. Keep one accepted change per measured win; discard unsupported attempts and record the decision trail. No unbounded background loop.

## runtime-forensics

Reproduce the symptom in a disposable fixture, add scoped instrumentation, collect repeated observations, narrow the causal mechanism and remove unneeded instrumentation. Live production observation is outside the trial scope.

## trace-forensics

Record the trace source/version/workload, inspect its timeline and hot paths, form a mechanism and validate it with a matching reproduction. A trace alone is not proof of a fix.

## refactoring

Name the invariant and affected callers. Capture behavior first, move one verifiable unit, migrate all callers, remove the obsolete API, and rerun matching checks.

## prototype

Create a disposable branch/scratch prototype around a specific design question. Run it, compare alternatives and report the decision; do not present throwaway code as production-ready.

## visual-parity

Freeze same-size, same-theme baseline and candidate screenshots; compare pixels and inspect differences against expected states. The ordinary trial screenshots are not automatically a parity verdict.

## authoring-a-skill

Use local create-verification-skill when appropriate. Keep frontmatter, concrete paths and commands; run the workflow before claiming the skill works. No Cursor create-skill dependency.

## eval

Define a measurable rubric and fixed tasks, blind candidate labels where possible, run matched samples, record failures and uncertainty. No bundled model/eval service is installed.

## babysit

Read PR head, review comments and existing CI runs. Classify blockers with evidence, batch scoped fixes, rerun affected checks and refresh draft evidence. Stop at review-ready; do not auto-merge or start a background watcher.

## shipping

Produce a review-ready handoff only: independent verdict per exact PR head, matching-surface evidence, relevant CI and remaining gaps. Verify each stack dependency. Stop before merge/auto-merge/release/deploy; the upstream landing commands are unsupported.

## autonomous-run

Within the current authorized session, iterate toward a checkable finish condition, writing timestamp/decision/reason/evidence/result notes. Report a concrete blocker when continuation is impossible. No scheduler, heartbeat or persistence across sessions is provided.

## orchestrate

Break authorized work into independently owned scopes and checkpoint draft PRs. Use available agents only when delegation is authorized; record dependencies and exact evidence. No Cursor persistent coordinator/fleet is installed.

## autopilot-full

Unsupported as named: its merge-to-completion contract exceeds this integration. Use autonomous-run plus babysit to deliver reviewed draft PRs instead.

## autopilot-stack

Prepare independently verified draft PRs in explicit dependency order, with a reviewed commit and evidence for each. Refresh verification after rebasing. Landing remains a human decision.

## session-pickup

Read the handoff, current status/open PRs and diffs. Verify branch/head and artifact provenance, reconcile concurrent work, then resume only the unfinished authorized scope.

## pause-safely

Stop at a coherent checkpoint, clean owned processes, preserve evidence and record branch/SHA, remaining work, commands and blockers. Do not delete another task’s work.

## multi-phase-plan

Name acceptance criteria per phase and dependency order; finish verification and a reviewable checkpoint before the next phase. Keep status and blockers tied to evidence.

## worktree-cleanup

Inventory ownership/status first. The trial cleans only scratch it created. General worktree/simulator pruning is unsupported; never remove dirty/shared worktrees or another task’s simulator.

## opening-a-pr

When authorized, open an early draft with intent, concrete behavior, current head, exact tested SHA, evidence links and explicit pending checks. Update after verification and independent review. Keep the PR draft and do not merge.
