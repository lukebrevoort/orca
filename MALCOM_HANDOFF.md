## Completed work

- Stacked the assigned `bre-103-readonly-api-r2` branch on the BRE-96 shared schema foundation by bringing in the shared Zod schema/types commits.
- Expanded `packages/shared` with canonical auth session and inbox query schemas plus an `authSessionFixture`, so API routes can reuse shared contracts instead of duplicating shapes.
- Updated `apps/api` to expose typed, fixture-backed read-only endpoints for:
  - `GET /v1/auth/session`
  - `GET /v1/me`
  - `GET /v1/inbox`
- Added explicit query validation for `/v1/inbox`, returning a structured `validation_error` payload for invalid query params.
- Added API coverage for the new endpoints and validation behavior.

## Files changed

- `apps/api/src/index.ts`
- `apps/api/src/index.test.ts`
- `packages/shared/src/fixtures.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `apps/api/tsconfig.json`
- `apps/web/tsconfig.json`
- `package-lock.json`

## Verification run

- `npm install`
- `./node_modules/.bin/tsc -p packages/shared/tsconfig.json`
- `./node_modules/.bin/tsc -p apps/api/tsconfig.json`
- `node --experimental-strip-types --test packages/shared/src/schemas.test.ts`
- `node --experimental-strip-types --input-type=module -e "..."` smoke test covering:
  - `GET /v1/auth/session`
  - `GET /v1/me`
  - `GET /v1/inbox`
  - `GET /v1/inbox?cursor=` validation failure

## Notes

- `bun` was not installed in this runner, so `bun test` was not available. I used TypeScript compilation plus Node-based in-process route verification instead.
- `MALCOM_TASK.md` was not present in this checkout, so implementation followed the task prompt and the assigned branch context directly.
