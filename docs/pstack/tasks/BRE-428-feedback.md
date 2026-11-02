# BRE-428 — corner feedback to Linear

- Status: **running**, 2026-11-02 UTC. [Draft PR #286](https://github.com/lukebrevoort/orca/pull/286).
- User clarification: persistent corner button, minimal feedback input, creates a ticket in Luke's Linear. **Linear is the work queue.** No separate in-app queue or dashboard.
- Base: `2a56e488aa4a47c24846448c648a4d9cbe088590`; branch `feat/BRE-428-durable-feedback`; isolated worktree `/workspace/orca-feedback`.
- Existing development integration targets a personal Linear destination without per-user mapping. New API requires explicit `LINEAR_FEEDBACK_OWNER_USER_ID` and existing server-only destination settings, failing closed without it. No production configuration read or changed.
- Scope: owner-only direct-ticket API; web corner composer; native corner button on three main tabs; one text field; confirmed ticket link; immutable retry payload on uncertain delivery. No automatic mail, screenshot or account-data capture.
- Linear owns the durable ticket. SHA256-derived UUIDv4 identity makes exact retries stable across server restarts. No local queue, new table, migration, scheduler or autonomous agent. Drafts stay in memory across composer closure, but not app termination.
- Owners: root web/integration; feedback_api API/shared; feedback_ios native; feedback_verification fixtures/browser evidence; feedback_review independent review. Repository workflow supports scoped parallel work.
- Heads through `7156094` built the superseded queue design. The unshipped migration and queue UI are removed. Prior native test exposed keyboard-covered Submit; compact composer retains explicit keyboard dismissal coverage.
- Final revised verification pending. [Evidence](../../feedback/BRE-428/README.md) and PR track exact revisions and limitations. No live Linear test tickets.
- Permission boundary: fixes, tests, pushes and draft PR updates authorized. No merge, main push, deploy, production migration, TestFlight, new credentials or third-party messages.
- Activation requires confirming Luke's Orca user ID and existing Linear destination, final tests/visual review, and merge/rollout approval. Missing owner config hides the affordance and rejects delivery. No schema rollout required.
