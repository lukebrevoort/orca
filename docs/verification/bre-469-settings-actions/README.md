# Settings action original-owner boundary (BRE-469 / CORE-03)

A Settings editor opened as U can outlive a browser session switch to V. An
awaited session check alone leaves a gap before the next request. Bulk agent
revocation selects the current authenticated user without a resource ID; Outlook
connection start creates a new OAuth transaction for that user. Bind the editor's
original owner at each request through the existing optional
`x-orca-expected-user-id` header and `requireSessionOwner` middleware.

The guard follows authentication and precedes domain database access. It applies
to GET MCP connections, DELETE one connection, POST revoke-all, and GET Outlook
connect. Missing authentication remains 401, malformed owner 400, mismatch 409
`session_owner_changed` with private/no-store. Header absence preserves legacy
current-session behavior and JSON. Specific foreign connection IDs remain 404
for legacy clients. No schema, provider consent/callback, login or pending-login
contract changes. The header is never authentication or an owner selector.

## Immutable failures and controls

| Exact baseline | Actual result | Scope |
| --- | --- | --- |
| `d36b39572307f30b979a0271f505eefe38a6ee88` | 3 pass / 6 fail, 9 tests | Captured-U header ignored with V session on three management routes; malformed header ignored. Independent connection/access/refresh snapshots reveal mutation. Same-owner, legacy and foreign-ID controls passed. |
| `1b7b3bf4d2e0f3f56c8dd34207199fc71f7512c0` | 2 pass / 2 fail, 4 tests | Outlook start created V's transaction despite original U, or created U's after malformed owner. Same-owner/legacy and unauthenticated controls passed. Zero external provider calls. |

[Retained MCP receipt](mcp-baseline.json) and [raw comparison](mcp-baseline.log),
[Outlook receipt](outlook-baseline.json) and [raw comparison](outlook-baseline.log).
Both were committed test-only checkpoints with clean start/end state, actual
Hono authentication and migrated disposable SQLite databases. Tests never
serialize tokens, session IDs, verifiers or OAuth state.

Separately, web `0b6190b1` reproduced the **old no-header UI** sequence in both
themes: held U auth response, real paired V login, release, bulk POST200 revokes V's
connection/access/refresh rows while U's editor falsely shows Revoked. Six cases,
12 assertions, four failures; captured-U-ID DELETE under V404 and same-owner bulk
controls passed. That browser evidence is owned by PR317 and is not an API-head
browser proof. The Outlook API failure proves start intent, not callback IDOR,
completed consent, credential disclosure or a live provider request.

## Demo and verification

```sh
bun test apps/api/src/auth/mcp/owner-boundary.test.ts apps/api/src/auth/outlook/owner-boundary.test.ts
bun apps/api/scripts/settings-owner-boundary-proof.ts /tmp/new-settings-owner-proof.json
```

The proof exercises five real in-process HTTP requests against migrated SQLite:
two mismatch409 commands leave domain state unchanged; two own200 commands revoke
only U and create only U's Outlook transaction; legacy GET200 remains compatible.
No external provider or browser/OS acceptance is claimed. The output path must
be new. Full final lint/typecheck/tests/build and proof receipts identify their
own exact final revision; do not relabel the baseline/intermediate results.

Intermediate `ac584152` MCP implementation passed 26 focused tests (12 new plus
14 existing OAuth cases), 37 Bun expect calls and actual API tsc. Final combined
Outlook/MCP gates remain pending at this documentation checkpoint. A fresh
independent source correctness/security reviewer approved the production change
at `2f0cc754`; that read-only review did not execute final tests or browser flows.

Client integration is required: legacy no-header requests intentionally retain
old behavior, so this API layer alone cannot close the reported UI race. Web
must carry the immutable original Settings owner through its await boundaries
and avoid publishing success into a replacement editor. Native callsites require
a separate audit; no native race or integration is claimed here. Other Settings
controls and Google full-page navigation are outside this narrow API patch.

Rollback: revert these optional middleware placements. No migration, data rewrite,
credential change or provider operation is needed. This restores prior behavior
for opted-in requests; existing clients remain wire-compatible throughout.
