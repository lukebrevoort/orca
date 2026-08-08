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

The Vercel project described by `vercel.json` installs the workspace, builds
`apps/web`, publishes `apps/web/dist`, and bundles the Hono API as a Bun
function. Rewrites send the SPA's `/v1/...` requests to that function, so the
preview can exercise the Google OAuth return path on the same origin. Preview
SQLite state is stored under `/tmp/orca.sqlite` and is intentionally
non-durable; production persistence still belongs on a managed database.

The API applies any pending local SQLite migrations before it starts. This
makes a fresh or reset development database ready for auth and OAuth flows.

Default local URLs:

- API: `http://localhost:3000`
- Web: `http://localhost:5173`

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
`apps/api/data/orca.sqlite`. Override that with `DATABASE_PATH` if needed.

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
- `DATABASE_PATH`: SQLite file path used by the API workspace. Because the API scripts run from `apps/api`, the default local value is `./data/orca.sqlite`.

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
5. Add `http://localhost:3000/v1/auth/gmail/callback` as an Authorized redirect URI for local development. For a Vercel preview, also add the deployed project's stable origin followed by `/v1/auth/gmail/callback`.
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
