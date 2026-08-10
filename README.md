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
