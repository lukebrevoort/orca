# Saved-cloud P-Stack assessment

Inspected 2026-10-15: current main `2d104ea394cc319c085d8983d2c17a923c2be467`,
draft [#248](https://github.com/lukebrevoort/orca/pull/248) at
`3d4133163c915cda4162af38c81c73ba2daf65b4`, its full body/discussion and prior
evidence. Main contains merged #250 (`23936cb`) and #249 (`2d104ea`). The only
open PRs at inspection were #248 and separately owned #235; search/performance is
excluded. The saved checkout was at `9844aca`; it has been preserved.

Independent assessor `/root/assess` inspected the pinned original P-Stack
[README](https://github.com/cursor/plugins/blob/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/pstack/README.md),
[verification guide](https://github.com/cursor/plugins/blob/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/pstack/docs/guide/06-verify-and-ship.md)
and [overnight guide](https://github.com/cursor/plugins/blob/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/pstack/docs/guide/07-overnight.md).
They call for small verifiable changes, repeatable seeded setup, isolated work,
decision records and review of the final patch. Heavy persistent orchestration is
not required for this bounded session. The local provenance/license remain intact.

| Capability | Existing evidence | Gap or limitation at start |
| --- | --- | --- |
| Shared skills | Five explicit local skills and 54-skill/23-playbook coverage in #248 | Not on main while draft remains unmerged; path-based discovery works. |
| Isolation | `verify.py` archives committed source and owns fixture/browser/process cleanup | Product task worktree/ownership recipe not concrete. |
| Verification | Existing synthetic browser/API trial, 16 scenarios, eight provider invocations, 26 screenshots; original failures retained | Prior committed artifacts target `149a277`; integration with current main and this session's final revisions need new checks. |
| Independent review | Two prior independent reviews and `interrogate` procedure | Must review each new final executable revision; agents do not imply different models. |
| Cloud setup | Node 24, saved Bun cache and system Chromium observed | Bun absent from default PATH; untracked `/workspace/.orca-tools/install.sh` runs a checkout migration. No repository-owned fresh-instance setup entry point. |
| Task to draft PR | Existing playbooks describe the steps | No real product pilot demonstrated; no concrete reusable status/handoff record. |
| Native checks | Existing hosted Fixture Checks/native-reader workflows | Linux does not run native; final PR checks must be followed. |
| Persistent automation / Cursor routing | Explicitly unsupported by Codex adapter | Not a missing feature to copy or silently enable. |

Decision: reuse and update #248 after integrating current main in an isolated
worktree; retain all prior evidence. The previous owner is completed, the PR has
no conflicting review requests, and this is the same integration scope. Add only
explicit cloud setup, discoverable task instructions and a status template. Use a
separate draft based on current main for the small product pilot so it can be
reviewed independently of the workflow. No new orchestrator, scheduler, credentials,
security configuration or migrations are needed.

GitHub CLI API reads returned `Forbidden`; git fetch and the connected GitHub API
worked. Use the connected API for PR/check metadata without altering credentials.
This access fact is an environment limitation, not an application failure.

Pilot selected after independent source inspection: malformed/out-of-range Gmail
`internalDate` values throw `RangeError` in `normalizeInternalDate`, aborting a
message batch before persistence. Expected bounded policy: preserve valid dates,
fall back to the existing missing-date epoch policy for invalid dates, and prove
synthetic batch persistence/account isolation. No UI, sync architecture, search or
performance changes are needed. Scope/reproduction/review/results belong in the
pilot task record and PR; this assessment is not a claim that the fix passed.
