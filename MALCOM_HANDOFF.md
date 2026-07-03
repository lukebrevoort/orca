## BRE-104 handoff

### Completed work
- Replaced the static inbox shell in `apps/web` with API-backed loading for account and inbox list state.
- Added shared Zod-backed mail/auth/inbox contracts in `packages/shared` and reused them from both the API and the web app instead of introducing new parallel response types.
- Updated `apps/api` to serve the stacked read-only endpoints with shared-schema validation for `/v1/auth/session`, `/v1/me`, and `/v1/inbox`.
- Added focused shared-contract and API tests so the new stack can be verified in this workspace without Bun.

### Files changed
- `MALCOM_HANDOFF.md`
- `apps/api/package.json`
- `apps/api/src/index.test.ts`
- `apps/api/src/index.ts`
- `apps/api/src/providers/gmail/normalizer.test.ts`
- `apps/api/src/providers/gmail/normalizer.ts`
- `apps/api/tsconfig.json`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- `apps/web/tsconfig.json`
- `package-lock.json`
- `packages/shared/package.json`
- `packages/shared/src/fixtures.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/schemas.test.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/tsconfig.json`

### Verification run
- `./node_modules/.bin/tsc -p packages/shared/tsconfig.json --pretty false`
- `./node_modules/.bin/tsc -p apps/api/tsconfig.json --pretty false`
- `./node_modules/.bin/tsc -p apps/web/tsconfig.json --pretty false`
- `npm run test --workspace=packages/shared`
- `npm run test --workspace=apps/api`
- `npm run build --workspace=apps/web`

All commands above passed.

### Notes
- `MALCOM_TASK.md` was not present in the repository, so implementation followed the task statement provided to the background agent.
- The workspace did not have `bun` installed even though existing scripts referenced it. To keep verification runnable here, the new shared/API tests use Node's built-in test runner with `--experimental-strip-types`.
- I ran `npm install` in the workspace so the API/web dependencies were available for typechecking and test execution.

### Blockers
- None.
