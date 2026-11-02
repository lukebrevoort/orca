# BRE-428 — durable feedback

- Intent / playbook: feature. Make feedback easy to submit from production web and iOS, save it durably, and expose its handoff to the existing Linear work queue.
- Acceptance: authenticated own-user capture and latest 100 reports; SQLite persistence across restart; stable retry identity; no duplicated Linear issues after uncertain delivery; visible queued/delivered/error/retry; text-only explicit capture; both-theme responsive UI; native Settings entry.
- Status: **running**. Updated 2026-11-02 UTC.
- Base: `2a56e488aa4a47c24846448c648a4d9cbe088590`; branch `feat/BRE-428-durable-feedback`; worktree `/workspace/orca-feedback`.
- Tracking: [BRE-428](https://linear.app/brevoort/issue/BRE-428/add-production-feedback-capture-and-durable-work-queue-to-orca-web-and).
- Inspection: main has a development-only widget and POST route; receipts are a process-local Map. Existing Linear destination/submitter is reused. No overlapping open PR; #235 search remains excluded. Existing feedback tickets in Orca are completed/canceled; no active production queue implementation found.
- Owners: root web/integration; feedback_api API/shared contracts/persistence; feedback_ios native; feedback_verification synthetic browser harness. Independent review pending. Agents share this worktree, distinct owned paths.
- Dependencies: persistence/shared contracts precede integrated UI checks; one API owner for migration/index/integration. No new scheduler or autonomous coding agent. Linear delivery is attempted on submission and explicitly retried; without configured integration, reports remain durable and queued.
- Data boundary: user text only; no email bodies, screenshots, selected DOM, account addresses or query strings are captured. Live data, credentials and production access untouched.
- Before-fix evidence: `apps/web/src/main.tsx` excludes widget in production; `apps/api/src/index.ts` disables legacy feedback in production; `feedback.ts` stores receipts only in memory.
- Setup: first setup failed because default temp directory was read-only. Explicit TMPDIR=/tmp, BUN_INSTALL_CACHE_DIR=/tmp/orca-feedback-bun-cache and ORCA_CHROMIUM_EXECUTABLE=/usr/bin/chromium setup succeeded with frozen dependencies and browser doctor. Logs in /tmp/orca-feedback-setup*.log. System Chromium used rather than pinned download. Linear get_agent_context tool returned unsupported; repository is source of truth.
- Verification / review / screenshots / hosted checks: pending final executable revision.
- Permission boundary: draft PR/push authorized. No merge, deploy, production migration, TestFlight, new credentials, external communications, or automated execution of feedback.
- Rollout: additive migration is proposed only. Existing API startup runs migrations; main is deployment-linked. Human approval and controlled API-before-client rollout required after checks/review. No production action performed by this task.

## Verified checkpoint

- Draft PR: https://github.com/lukebrevoort/orca/pull/286
- Executable revision: `96849fdaf63c271f34d078d03069584d3037c3a2`; evidence-only commit follows.
- Final production build and browser matrix passed, zero page errors. [Evidence and limits](../../feedback/BRE-428/README.md).
- Independent review found no source blocker through that executable revision. Latest100 and in-memory pending-draft limitations are explicit.
- Hosted checks / native simulator validation still in progress at this evidence checkpoint. Final check links and status are maintained on the draft PR to avoid repeatedly restarting CI for documentation-only status commits.
- All owned feedback fixtures stopped; disposable databases cleaned; logs and failed attempts retained under `/tmp/orca-feedback-*` and selected evidence committed.
