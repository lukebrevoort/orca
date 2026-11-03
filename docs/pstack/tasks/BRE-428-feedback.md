# BRE-428 — corner feedback to Linear

- Status: **running**, 2026-11-03 UTC. [Draft PR #286](https://github.com/lukebrevoort/orca/pull/286).
- User clarification: persistent corner button, minimal feedback input, creates a ticket in Luke's Linear. **Linear is the work queue.** No separate in-app queue or dashboard.
- Base: `2a56e488aa4a47c24846448c648a4d9cbe088590`; branch `feat/BRE-428-durable-feedback`; isolated worktree `/workspace/orca-feedback`.
- Existing development integration targets a personal Linear destination without per-user mapping. New API requires explicit `LINEAR_FEEDBACK_OWNER_USER_ID` and existing server-only destination settings, failing closed without it. The latest November 3 read-only production variable-name inspection found the key present and owner setting absent; no values retrieved or configuration changed.
- Scope: owner-only direct-ticket API; web corner composer; native corner button on three main tabs; one text field; confirmed ticket link; immutable retry payload on uncertain delivery. No automatic mail, screenshot or account-data capture.
- Linear owns the durable ticket. SHA256-derived UUIDv4 identity makes exact retries stable across server restarts. No local queue, new table, migration, scheduler or autonomous agent. Drafts stay in memory across composer closure, but not app termination.
- Owners: root web/integration; feedback_api API/shared; feedback_ios native; feedback_verification fixtures/browser evidence; feedback_review independent review. Repository workflow supports scoped parallel work.
- Heads through `7156094` built the superseded queue design. The unshipped migration and queue UI are removed. Prior native test exposed keyboard-covered Submit; compact composer retains explicit keyboard dismissal coverage.
- Product source `0085ffb` passed hosted 2,096 tests, browser/API checks and native feedback model/UI tests. CI recovery is in progress: compose hit its 45-minute job boundary after all steps passed; image setup exposed cold transport and simulator discovery failures. Final revised verification pending. [Evidence](../../feedback/BRE-428/README.md) and PR track exact revisions and limitations. No live Linear test tickets.
- Permission boundary: fixes, tests, pushes and draft PR updates authorized. No merge, main push, deploy, production migration, TestFlight, new credentials or third-party messages.
- Activation requires confirming Luke's Orca user ID and existing Linear destination, final tests/visual review, and merge/rollout approval. Missing owner config hides the affordance and rejects delivery. No schema rollout required.

## CI recovery

- Compose job `125486290506` ran 19:03:03–19:48:04 UTC (45m01s), with successful tests, artifact upload and post steps. No newer branch run exists. Deadline collision is strongly indicated; cancellation actor/reason is unavailable through the connected API. Increase the job budget to 60 minutes without changing test assertions.
- Image setup takes a single bounded authenticated readiness request before measuring the image counter, using the same URLSession. The existing five-second counter checks and consent/cancellation assertions remain unchanged.
- Record simulator/runtime/SDK inventory and Xcode destinations before building; fail explicitly if the owned simulator is absent. This is diagnostic coverage, not a proven repair for hosted discovery failures.
- Native screenshot download remains blocked by proxy HTTP 403. Do not bypass it.

## Optional media extension

- User requested screenshots and screen recordings as context, keeping the corner composer. Start from PR head `e5f6252ed41a00c96ab3675337411e7c0cd6f3a6`.
- Accept reviewed images/videos: maximum three files, 10 MiB each and 20 MiB total. Web offers explicit browser-selected screenshot and audio-free recording (60-second cap), with visible stop/cancel and cleanup on close/hidden page. Native uses scoped Photos/Files selection of existing system captures; no ReplayKit recorder or broad library permission.
- Media stays local until Send, travels through the owner-authenticated API to Linear private storage, and is linked in the issue. Existing API key/destination suffice as storage architecture; no new public host or database migration. Verify required key permission for uploads before activation; docs do not identify its exact minimum.
- Failures preserve exact payload/issue identity. Bounded metadata-only upload receipt cache reuses successful private uploads. No supported safe remote deletion API was found; failed/restarted submissions can leave private unreferenced Linear assets. Local preview/media bytes must be cleaned on discard/success/account change.
- Tests use synthetic media and mocked Linear only. API/shared, native, and web scopes split among existing agents, followed by independent immutable-head review and fresh browser/native evidence.

- Media product source `89c5e1d4d931bf9c531820d55f2ab5f0f6c131dc`: full local suite **2,107 passed, zero failures** (1,089 API / 187 shared / 831 web), production build and lint passed. Independent review by `feedback_review` found no remaining source blocker; overlapping availability response race was fixed and regression-tested in both orders.
- Browser media verification passed 12 scenarios with synthetic files/canvas capture only. Fresh native compilation and Photos picker UI verification remain hosted CI gates. No live Linear upload or actual system-screen capture was performed.

- Hosted native app/test compilation on `4131068` succeeded. Reading job `125680139379` found an over-strict new metadata assertion: ImageIO generated structural EXIF ColorSpace although source GPS/private metadata was removed. Preserve encoder behavior; tighten the test around removal of private source metadata while allowing generated rendering fields. The metadata assertion correction is prepared; hosted rerun remains required.

- Reconciliation now uses the official schema's `issues(filter: { id: { eq: $id } }, first: 1, includeArchived: true)` connection. Only a validated empty nodes array means absence; GraphQL errors/malformed data stop before uploads. This removes the unverified `ENTITY_NOT_FOUND` assumption. Focused API/Linear suite now 28 passed; typecheck passed.

- Compose job `125680139177` compiled and passed 16 other UI tests, but test38 failed before selection because its assumed Photos collection cell was absent. The underlying accessibility/presentation cause is not yet established. Add loopback-only bounded, sanitized picker diagnostics after the existing wait, plus a focused light feedback preflight ahead of the unchanged broader suite. Seed synthetic PNG and MP4 and require both reviews and stable digests across retry; retain dark coverage. No assertion or wait is relaxed.
