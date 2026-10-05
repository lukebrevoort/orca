# Compose account readiness regression

Compose opens a closable loading shell while the initial inbox selects its account and the account-scoped draft recovers. Editing and Send are unavailable during that interval; Zen uses the same gate. No preview content migrates into an authenticated account.

The browser regression holds account and sync prerequisites, then inbox selection and draft hydration. It covers differing preliminary/final owners, an existing saved draft without revision mutation, close/reopen, explicit discard, restored Zen routes, and session rejection. Account-scope unit tests cover obsolete hydration and remounting under another account. Existing reload, attachment, second-account reply, invalid recipient, conflict, and idempotent delivery journeys remain active.

## Local synthetic verification

Use Bun 1.3.14 and Node 20+, an isolated checkout without local .env files, and no real provider credentials:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run lint
bun run typecheck
bun run test
bun run build
bun --no-env-file apps/api/scripts/compose-fixture.ts
```

Keep the fixture in its own terminal. It creates a temporary synthetic database, binds an OS-assigned loopback port, and prints a private connection-file path. In another terminal, run:

```sh
node apps/web/scripts/compose-fixture-e2e.mjs <printed-connection-file> <new-evidence-directory>
```

The harness blocks external browser origins and records 14 scenario results, request/response evidence, eight expected synthetic provider invocations, screenshots and browser errors. Stop only the owned fixture when done; it removes its private temporary database and session. Do not publish connection files or tokens. No real Gmail/Outlook delivery or native behavior is claimed. The scope excludes exhaustive asynchronous account/save interleavings and draft-list failure recovery redesign.
