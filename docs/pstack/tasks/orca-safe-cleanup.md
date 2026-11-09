# BRE-446: Remove verified dead code and stale setup metadata

- Intent / playbook: bounded refactoring. Reduce unused implementation and stale setup guidance without changing live mail behavior.
- Status: **running**. Local verification and independent source review complete; draft publication and hosted checks remain.
- Updated (UTC): 2026-11-09.
- Base: `9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311`.
- Tracking: [BRE-446](https://linear.app/brevoort/issue/BRE-446/remove-verified-dead-code-and-stale-setup-metadata), UUID `687dcfb7-5ecb-46b4-bb1c-4e66f4ea2c77`.
- Executable commit: `289209b271168d5e4314bfa2684213167916fb37`. Subsequent changes are README precision and this handoff only.

## Scope and invariants

Remove five uncalled private functions from `apps/api/src/index.ts`:
`transportError`, `updateCollectionRecord`, `updatePinRecord`,
`validatePinTarget`, and `organizationConflict`. Remove the exclusively orphaned
`CollectionRecord` type, `OrganizationTargetError` class and `pinFilterSchema`
import. Existing collection/pin routes already use Organization operations and
their active validation/error handling.

Remove root `package-lock.json`: `package.json`, CI, Vercel and the verification
tooling select Bun and `bun.lock`. No active tracked npm-lock consumer was found;
the old `MALCOM_HANDOFF.md` mention is historical. Keep canonical manifests and
`bun.lock` unchanged. Correct stale current facts in `AGENTS.md` and `README.md`.

No route, public contract, UI, schema, migration, authentication, security guard,
saved user data or historical evidence is removed. Reader #303 and OAuth #298
files are excluded. No production performance or bundle-size improvement is claimed.

## Verification

- Before deletion: existing collections/pins, smoke and draft-mirror suites passed 24 tests across six files.
- TypeScript AST audit: each removed function has only its private declaration at base. All 178 retained top-level API statements compare unchanged after printing, apart from the orphaned import specifier.
- Bun 1.3.14 / Node 24.22.1: `bun run test` passed 2,194 tests (API 1,140; web 867; shared 187), zero failures.
- Final `bun run typecheck`, `bun run lint`, `bun run build` and `git diff --check` passed. The first parallel typecheck had a web SIGKILL/137; isolated web and final aggregate typechecks passed. The failed attempt is retained, not relabeled.
- Build retains the existing Vite warning for a JavaScript chunk above 500 kB.
- Independent reviewer `review_orca_cleanup_patch` reviewed exact base → executable commit, reran the AST audit and found no blocking source issue. Its README environment-loading precision note was applied. This is not formal GitHub approval.
- No new UI screenshots or local native runs: no UI/native behavior changed. No live mail, OAuth, production migrations or manual deployments were used.
- Raw local logs and the independent AST audit script are retained outside the repository to avoid adding more generated evidence to the checkout. Hosted check links and final publication status belong in the draft PR description.

## Deferred deliberately

Historical evidence archival needs durable replacements before deletion. Legacy
public API retirement, demo/live separation and optional agent/Organization
feature removal need their own caller and data plans. None is silently bundled
into this first cleanup.
