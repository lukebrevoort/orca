# Orca

## iPhone client

See the [native visual alignment gallery](docs/ixd/ios/visual-alignment/index.html)
for the current iPhone design and before/after screenshots.

The native SwiftUI client lives in `apps/ios/Orca.xcodeproj`. It targets iOS 17+
and uses Orca's existing Gmail inbox, conversation, and revisioned draft APIs.
Mobile authentication uses a system-browser consent flow and a revocable opaque
credential; provider OAuth tokens remain on the API server.

For a local mailbox that never sends real email, run:

```bash
bun apps/api/scripts/mobile-fixture.ts
```

This creates a temporary SQLite mailbox, binds a random loopback port, and prints
the location of synthetic connection details for a Debug simulator build. Stop
the process to remove its mailbox. The fixture transport simulates draft mirroring
and delivery; it does not validate real Gmail or Apple push delivery.

To exercise the production Swift models and API client against that fixture:

```bash
bash apps/ios/Tools/check-api.sh /path/printed/by/the/fixture/connection.json
```

This verifies read, draft create/update, send and idempotent replay, including
exactly one simulated provider delivery. It refuses non-loopback/non-fixture sessions.

For real notifications, configure the optional `APNS_*` server settings in
`.env.example`, enable Push Notifications for your Apple App ID, and install a
properly signed app whose bundle identifier matches `APNS_BUNDLE_ID`. Gmail push
ingestion and Apple notification delivery are separate server stages. Missing
APNs configuration leaves the mail APIs available and reports notifications as
unconfigured.

Run the API as an always-on Bun service using `bun run --cwd apps/api start` with
persistent SQLite storage. The entrypoint starts the push worker after migrations
and stops it on shutdown; importing the Hono app into a serverless handler does
not run that worker. Delivery scans default to every 15 seconds after ingestion.
The notification payload uses generic text and opaque account/thread IDs, keeping
sender names, subjects, and message bodies off the lock screen.

The [implementation verification report](docs/ixd/ios/validation.html) records automated
checks and native UI evidence. The [iPhone acceptance card](docs/ixd/ios/device-acceptance.html) documents physical
device setup and manual checks. Simulator tests do not establish device signing,
production authentication, or real push delivery. Outlook sync and sending remain
unimplemented in the current provider adapter.

Orca is a messaging product focused on human-written communication. This repo is a Gmail-first Bun workspace with a Hono API, a React/Vite web app, and a shared TypeScript package for cross-app types.

## Prerequisites

- Bun 1.3.14 (pinned in `package.json` and CI)
- Node 24 for tooling and fixture checks (matching CI)

Install dependencies:

```bash
bun install
```

Copy the example environment file before running the API:

```bash
cp .env.example .env
```

The API development, database migration, and database verification scripts
explicitly load this workspace-root `.env` file, including when they run from
`apps/api`. The production `start` command expects configuration in the service
environment.

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

The Vercel configuration in `vercel.json` serves `apps/web/dist` and forwards
`/v1/...` requests to the configured Railway API. Other browser routes fall back
to `index.html` so `/login` and `/onboarding` survive a direct refresh. It does
not deploy a local Hono serverless bridge. A successful web deployment alone
does not verify API persistence, OAuth, Gmail delivery, or native acceptance.

`railway.json` starts the API with `bun --cwd apps/api start`. Both API `start`
and `dev` scripts apply pending SQLite migrations before launching the server.
The standalone entrypoint starts Gmail sync and mobile push schedulers; importing
the Hono app alone does not start them.

Default local URLs:

- API: `http://localhost:3000`
- Web: `http://localhost:5173`

## Connected accounts API

Gmail is the implemented mail provider for sync, draft mirroring, and sending.
Outlook OAuth is available, but its adapter does not implement sync or draft/send
transport. Read/unread changes and organization actions affect Orca locally; they
do not provide Gmail mailbox mutation parity.

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

The API uses Drizzle + SQLite for accounts, sessions, cached mail, revisioned
drafts, and local organization state. By default it writes to
`apps/api/data/orca.sqlite`. Relative `DATABASE_PATH` values are anchored to the
API workspace, so API requests and startup migrations use the same file even
when the process is launched from the repository root. Set `DATABASE_PATH` to
a path on durable storage for a deployed API. The checked-in Railway config does
not provision that storage. Ephemeral filesystems lose persisted state on
replacement or restart; do not assume separate API instances share a SQLite file.

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
- `DATABASE_PATH`: SQLite file path used by the API workspace. Relative paths resolve from `apps/api`; the default local value is `./data/orca.sqlite`. Deployed APIs must use durable storage.

Variables required by the auth/session foundation when that code path is exercised:

- `SESSION_SECRET`: signing secret for the Orca session cookie. Must be at least 32 characters.
- `TOKEN_ENCRYPTION_KEY`: base64-encoded 32-byte key used for AES-GCM encryption of provider tokens at rest.

Variables for the default-off M6 ChatGPT/Codex MCP OAuth boundary:

- `ORCA_M6_MCP_ENABLED`: set to `true` only after the read-only MCP resource is deployed. Disabled environments return `404` from discovery, registration, token, and connection APIs.
- `ORCA_M6_MCP_ISSUER`: exact public authorization-server identifier. Use HTTPS in production and keep it identical across discovery, consent responses, and access-token `iss` validation.
- `ORCA_M6_MCP_RESOURCE`: exact public MCP resource identifier, normally `https://<host>/mcp`. It is round-tripped through authorization/token requests and becomes both the access-token `aud` and `resource` claim.
- `ORCA_M6_MCP_SIGNING_KEY`: base64-encoded 32-byte MCP root key, separate from `SESSION_SECRET`. Distinct HKDF-derived subkeys sign consent and access tokens.
- `ORCA_M6_MCP_SIGNING_KEY_ID`: versioned `kid` published in MCP JWT headers; rotate this with the MCP signing key.
- `ORCA_M6_MCP_REDIRECT_URIS`: exact comma- or whitespace-separated OpenAI callback allowlist. Arbitrary HTTPS origins are rejected.
- `ORCA_M6_MCP_DCR_PER_MINUTE`: database-backed dynamic-registration limit, capped at 60 and defaulting to 30.
- `ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS`: optional access-token lifetime, capped at 600 seconds.
- `ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS`: optional rotating refresh-token lifetime, capped at 30 days.
- `ORCA_M6_MCP_AUTHORIZATION_CODE_TTL_SECONDS`: optional single-use authorization-code lifetime; defaults to 300 seconds.

Variables for the implemented Gmail connect flow:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REDIRECT_URI`
- `GMAIL_OAUTH_SCOPES`: optional space- or comma-delimited scopes. Defaults to `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/userinfo.profile`.

Variables for the separate Google Calendar availability connection:

- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`: dedicated Calendar OAuth client credentials (the generic Google credentials are accepted as a local fallback, but Calendar still has a separate grant and token row).
- `GOOGLE_CALENDAR_REDIRECT_URI`: defaults to `http://localhost:3000/v1/auth/calendar/google/callback`.
- `GOOGLE_CALENDAR_OAUTH_STATE_SECRET`: optional dedicated state-signing secret; defaults to `SESSION_SECRET`.

Calendar scopes are a fixed code allowlist: `calendar.freebusy`, `calendar.calendarlist.readonly`, and `userinfo.email`. Gmail scopes cannot silently enable Calendar. Orca stores encrypted Calendar tokens separately, queries only Google Calendar's `freeBusy` endpoint, keeps only allowlisted calendar-list metadata, and exposes no event-create/update/delete endpoint.

Calendar consent reuses the existing Google OAuth client from `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` unless the optional `GOOGLE_CALENDAR_*` overrides are set. Add the matching `/v1/auth/calendar/google/callback` URL (derived from `GMAIL_REDIRECT_URI`) to that OAuth client's authorized redirect URIs; the Calendar grant and encrypted tokens remain separate from Gmail.

Local validation notes:

- The API now validates `PORT` and `WEB_ORIGIN` at startup.
- The auth/session layer validates `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` when auth/token code is invoked.
- The API does not require an explicit `DATABASE_PATH`; it falls back to `./data/orca.sqlite` for local development.

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
The BRE-278 read-only Calendar availability fixture and manual verification guide is available at
`http://localhost:5173/docs/bre-278-calendar-availability-validation.html`.

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

The public OAuth taxonomy is `mail:read` and `agent_events:read`. At the `/mcp`
boundary, the API-owned verifier maps `mail:read` to the mail metadata, mail content,
and connection-status read capabilities, and maps `agent_events:read` only to the
agent-event capability. The resource never accepts a JWT by signature alone.

Operational requirements:

1. Apply `apps/api/drizzle/0020_mcp_oauth.sql` before enabling the feature.
2. Use durable SQLite storage shared by every API instance. All instances must use
   the same versioned `ORCA_M6_MCP_SIGNING_KEY`; it is intentionally independent of
   browser `SESSION_SECRET` rotation. Changing the MCP key or `kid` invalidates
   outstanding MCP access tokens and consent requests but leaves refresh grants usable.
3. Deploy the authorization and MCP resource identifiers over HTTPS and set the
   exact values above. Do not change trailing paths after clients are linked.
4. Keep `ORCA_M6_MCP_ENABLED=false` until the BRE-261 boundary and BRE-265 `/mcp`
   resource are present. The MCP resource should call `verifyMcpAccessToken` with a
   per-tool required scope and use `buildMcpWwwAuthenticate` for `401` challenges.
5. Do not log authorization codes, access/refresh tokens, provider tokens, request
   authorization headers, client secrets, OpenAI keys, or email bodies.
6. Credential GC runs opportunistically on registration and token requests. Expired
   codes/access tokens are retained for 24 hours, consumed/revoked refresh tokens for
   a 24-hour replay-detection window, revoked connections for 30 days, and unused
   clients for 24 hours before cascade deletion.

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

### Feedback to Linear

The web and native corner buttons open a compact, text-only composer. Sending
creates a ticket in the existing configured Linear destination and shows its link
only after delivery is confirmed. Failed delivery preserves the note for retry.
Linear is the work queue; no feedback table or migration is required.

The existing Linear configuration targets a personal workspace. Activation requires
server-side `LINEAR_API_KEY` and explicit `LINEAR_FEEDBACK_OWNER_USER_ID` matching
the intended owner's **Orca user ID**. Do not substitute a Linear user ID, guess an
email, or authorize the first database user. Without this configuration the
affordance is hidden and delivery is rejected. Confirm the existing team, project,
label, state and assignee settings before rollout; their existing defaults remain.

Authenticated `GET /v1/feedback/ticket` reports availability; `POST` accepts
`{ id, message, platform }`. Exact retries reuse a deterministic UUID and reconcile
the Linear receipt, including after API restart. Drafts remain in memory across
composer dismissal, but not app termination. No mail, screenshots or account
details are automatically attached. The older development-only `POST /v1/feedback`
endpoint is not used by the corner composer. To use it locally, set
`LEGACY_FEEDBACK_ENABLED=true` in a non-production API environment and sign in
as the configured `LINEAR_FEEDBACK_OWNER_USER_ID`. Requests must come from the
configured web origin. The endpoint limits concurrent requests, delivery rate,
report structure and image attachments; limits are per API process and reset
on restart. The legacy route is disabled by default and in production.

## Workspace Layout

- `apps/api`: Bun/Hono backend.
- `apps/web`: React/Vite frontend.
- `packages/shared`: Shared schemas, fixtures, and TypeScript types.
