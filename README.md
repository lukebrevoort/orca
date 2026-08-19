# Orca

Orca is a messaging product focused on human-written communication. This repo starts as a Bun workspace with a Hono API, a React/Vite web app, and a shared TypeScript package for cross-app types.

## Prerequisites

- Bun 1.2 or newer
- Node 22 or newer for editor tooling compatibility

Install dependencies:

```bash
bun install
```

Copy the example environment file before running the API:

```bash
cp .env.example .env
```

The API scripts load this workspace-root `.env` file automatically, including
when they run from `apps/api`.

## Development

Run both apps:

```bash
bun run dev
```

Run one app:

```bash
bun run dev:api
bun run dev:web
```

### Preview the UI without Gmail

During local development, open `http://localhost:5173/dev/inbox` to review the full
inbox with fake email data. This route bypasses OAuth only in Vite development mode;
production builds keep the inbox protected by the normal session check.

The Vercel project described by `vercel.json` builds both the static web bundle
and the Hono API bridge. `/v1/...` requests are rewritten to the generated
`api/index.js` function, while browser routes fall back to `apps/web/dist` so
`/login` and `/onboarding` survive a direct refresh. A `READY` deployment now
includes both the web bundle and the API function, but it is not proof that the
OAuth flow has been exercised.

The API applies any pending local SQLite migrations before it starts. This
makes a fresh or reset development database ready for auth and OAuth flows.

Default local URLs:

- API: `http://localhost:3000`
- Web: `http://localhost:5173`

## Connected accounts API

`GET /v1/accounts` returns every Gmail and Outlook account connected to the
authenticated Orca user as a provider-neutral account page. `DELETE
/v1/accounts/:id` disconnects only an account owned by that user and returns
`204 No Content` (or `404` when the account is absent or belongs to another
user).

Disconnecting deletes the local OAuth account, encrypted provider tokens, and
all locally stored account-scoped data through SQLite foreign-key cascades,
including cached threads, messages, labels, contacts, drafts, collections,
pins, reminders, and attention settings. It does not delete or modify mail or
settings at Gmail or Outlook. Reconnecting starts with a fresh local cache.

Gmail sync and label migration keep the existing routes and accept an optional
`accountId` query parameter when a user has more than one Gmail connection:
`POST /v1/sync/gmail?accountId=:id`, `GET /v1/gmail-label-migration?accountId=:id`,
and the matching label import/skip routes. Without it, these endpoints retain
their original first-connected-Gmail-account behavior for backwards compatibility.

If a local inbox appears stuck on an old date, the Gmail settings page's
**Rebuild local inbox** action calls `POST /v1/sync/gmail/reset?accountId=:id`.
This clears only Orca's provider checkpoints, re-establishes the Gmail push watch
when configured, and backfills mail again. It does not delete or modify anything
in Gmail or remove Orca's locally stored organization data.

## Checks

```bash
bun run typecheck
bun run build
bun run test
```

Run the focused API smoke test (session auth, Gmail sync trigger, and a seeded
inbox response):

```bash
bun run test:smoke
```

## Database Foundation

The API workspace now includes a Drizzle + SQLite persistence foundation for
future auth and sync work. By default it writes to
`apps/api/data/orca.sqlite`. Relative `DATABASE_PATH` values are anchored to the
API workspace, so API requests and startup migrations use the same file even
when the process is launched from the repository root. Override that with
`DATABASE_PATH` if needed. Production deployments must point it at durable
storage shared by every API instance; the Vercel bridge falls back to
`/tmp/orca.sqlite` only to keep previews bootable, and an ephemeral/serverless
filesystem will lose sessions and connected accounts between instances or
restarts.

Useful commands:

```bash
cd apps/api
bun run db:generate
bun run db:migrate
bun run db:verify
```

## Environment Setup

The canonical local env contract lives in `.env.example`.

Variables used by the current local boot flow:

- `PORT`: API port. Defaults to `3000`.
- `WEB_ORIGIN`: browser origin allowed by API CORS. Defaults to `http://localhost:5173`.
- `DATABASE_PATH`: SQLite file path used by the API workspace. Relative paths resolve from `apps/api`; the default local value is `./data/orca.sqlite`. Production must use durable shared storage.

Variables required by the auth/session foundation when that code path is exercised:

- `SESSION_SECRET`: signing secret for the Orca session cookie. Must be at least 32 characters.
- `TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key used for AES-GCM encryption of provider tokens at rest.

Variables for the default-off M6 ChatGPT/Codex MCP OAuth boundary:

- `ORCA_M6_MCP_ENABLED`: set to `true` only after the read-only MCP resource is deployed. Disabled environments return `404` from discovery, registration, token, and connection APIs.
- `ORCA_M6_MCP_ISSUER`: exact public authorization-server identifier. Use HTTPS in production and keep it identical across discovery, consent responses, and access-token `iss` validation.
- `ORCA_M6_MCP_RESOURCE`: exact public MCP resource identifier, normally `https://<host>/mcp`. It is round-tripped through authorization/token requests and becomes both the access-token `aud` and `resource` claim.
- `ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS`: optional access-token lifetime, capped at 600 seconds.
- `ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS`: optional rotating refresh-token lifetime, capped at 30 days.
- `ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS`: optional single-use authorization-code lifetime; defaults to 300 seconds.

Variables reserved for the upcoming Gmail connect flow:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`
- `GMAIL_OAUTH_SCOPES`: optional space- or comma-delimited scopes. Defaults to `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/userinfo.email`.

Local validation notes:

- The API now validates `PORT` and `WEB_ORIGIN` at startup.
- The auth/session layer validates `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` when auth/token code is invoked.
- The current persistence branch does not force `DATABASE_PATH`; it falls back to `./data/orca.sqlite` for local development.

## Gmail OAuth Login

The web app includes a complete Google sign-in and Gmail connection flow at `/login`. It creates a pending, short-lived Orca session only to safely complete the OAuth return; the user account is promoted only after Google returns the verified account identity and Gmail grant. The callback then lands at `/onboarding`, where the user can enter Orca. Existing signed-in users can connect or reconnect an account at `/settings/integrations/gmail`.
Selecting **Continue with Google** calls `/v1/auth/gmail/connect`, receives the Google
authorization URL from the API, and redirects the browser into Google's OAuth consent flow.
The callback returns to `/settings/integrations/gmail` with `status=success` or
`status=error` query parameters that the page renders for the user.

Google Cloud setup:

1. Create or select a Google Cloud project.
2. Configure the OAuth consent screen and add local test users while the app is unpublished.
3. Create an OAuth client ID using application type **Web application**.
4. Add `http://localhost:5173` as an Authorized JavaScript origin.
5. Add `http://localhost:3000/v1/auth/gmail/callback` as an Authorized redirect URI.
6. Enable the Gmail API.
7. Under **Google Auth Platform → Data Access**, add `https://www.googleapis.com/auth/gmail.compose` alongside the existing read-only scopes. Do not add `gmail.modify` or `mail.google.com`.
8. Keep the app in Testing and add local test users, or complete Google's restricted-scope verification before broader use. Google classifies both `gmail.readonly` and `gmail.compose` as restricted scopes.
9. Copy the client ID and secret into `.env`, then restart the API.

Orca requests `gmail.compose` only through the incremental upgrade action. It is intentionally absent from `GMAIL_OAUTH_SCOPES`, so login and reconnect remain read-first. The scope is the narrowest single Gmail grant that covers creating/updating drafts plus sending new mail, replies, and forwards.

The same setup guide is available as a local HTML page at
`http://localhost:5173/docs/gmail-oauth-setup.html` when the web dev server is running.
The BRE-151 manual verification card is available at
`http://localhost:5173/docs/bre-151-validation.html`.
The BRE-159 M3 writing and delivery verification guide is available at
`http://localhost:5173/docs/bre-159-validation.html`.
The BRE-252 M5 fixture, Human Inbox, and milestone closeout guide is available at
`http://localhost:5173/docs/bre-252-validation.html`.

## ChatGPT/Codex MCP OAuth 2.1

BRE-267 adds Orca's authorization layer for the read-only MCP resource planned in
BRE-265. ChatGPT or Codex is the OAuth client; Orca does not sign into ChatGPT,
invoke an OpenAI model, or store an OpenAI API key or ChatGPT credential.

The authorization server publishes protected-resource and authorization-server
metadata, supports dynamic client registration for public clients, and requires
authorization code + S256 PKCE. A signed, 10-minute access token carries exact
issuer, audience/resource, subject, client, scope, account, expiry, and token-ID
claims. Every use is also checked against the hashed token record, live connection,
current scope grant, and currently connected user-owned accounts. Rotating refresh
tokens are random opaque values stored only as SHA-256 hashes; replay revokes the
entire connection. Authorization codes and access tokens are also stored only by
hash. Revocation therefore takes effect on the next MCP request rather than waiting
for access-token expiry.

Operational requirements:

1. Apply `apps/api/drizzle/0020_mcp_oauth.sql` before enabling the feature.
2. Use durable SQLite storage shared by every API instance. All instances must use
   the same `SESSION_SECRET`, which signs Orca sessions, consent requests, and MCP
   access tokens. Rotating it invalidates outstanding access/consent material.
3. Deploy the authorization and MCP resource identifiers over HTTPS and set the
   exact values above. Do not change trailing paths after clients are linked.
4. Keep `ORCA_M6_MCP_ENABLED=false` until the BRE-261 boundary and BRE-265 `/mcp`
   resource are present. The MCP resource should call `verifyMcpAccessToken` with a
   per-tool required scope and use `buildMcpWwwAuthenticate` for `401` challenges.
5. Do not log authorization codes, access/refresh tokens, provider tokens, request
   authorization headers, client secrets, OpenAI keys, or email bodies.

The user can inspect active and revoked links, their exact scopes/accounts, and last
use in Settings → Agent connections. Revoking one link or all links immediately
invalidates access and refresh material. Removing a mail account also removes it
from every live agent authorization; deleting the Orca user cascades all grants.

The manual setup, endpoint contract, migration notes, and review checklist are at
`http://localhost:5173/docs/bre-267-validation.html`.

### Gmail push sync

When Pub/Sub is configured, the API establishes a Gmail `watch` cursor and
processes Gmail history IDs from the verified webhook at
`POST /v1/webhooks/gmail` (the shorter `/v1/gmail/push` alias is also accepted).
The first watch setup backfills existing inbox messages before relying on
history deltas. A background scheduler renews the watch and polls through the
regular Gmail sync path every 15 minutes by default, so mail continues to
arrive when Pub/Sub delivery is delayed or unavailable.

To configure it:

1. Enable Gmail and Pub/Sub APIs in the Google Cloud project, and create a
   topic such as `projects/my-project/topics/orca-gmail`.
2. Create a push subscription targeting the deployed
   `/v1/webhooks/gmail?token=<long-random-secret>` URL. Keep the token in the
   subscription configuration and `.env`, never in source control.
3. Set `GMAIL_PUBSUB_TOPIC` and `GMAIL_PUBSUB_VERIFICATION_TOKEN`, then restart
   the API. Set `GMAIL_SYNC_INTERVAL_MS` or `GMAIL_WATCH_RENEWAL_WINDOW_MS` only
   when the defaults need to change.
4. Call `POST /v1/gmail/watch` with an authenticated Orca session after Gmail
   is connected, or let the periodic scheduler establish the watch.

The webhook acknowledges removed/unknown accounts without exposing account
existence. Invalid history cursors trigger a complete existing-message
backfill, and provider failures return a non-2xx response so Pub/Sub retries.

### Local feedback

In Vite development mode, every React route includes the Feedback button from
the vendored `@feedback-kit/react` package. It can include an explicitly
selected screen, selected elements, and a small redacted Orca state snapshot.
Reports are validated by the local API at `POST /v1/feedback` and require no
browser-side secrets. Without `LINEAR_API_KEY`, they remain available as
in-memory receipts only. If `LINEAR_API_KEY` is present in the root `.env`, the
same dev-only route uploads image/file attachments to Linear’s private storage,
creates a Linear issue in the configured Brev team and Orca project, applies the
Feedback label, and returns the created issue link to the widget. The API key
must remain server-side. The receipt endpoint is disabled when
`NODE_ENV=production`.

## Workspace Layout

- `apps/api`: Bun/Hono backend.
- `apps/web`: React/Vite frontend.
- `packages/shared`: Shared schemas, fixtures, and TypeScript types.
