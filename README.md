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

Default local URLs:

- API: `http://localhost:3000`
- Web: `http://localhost:5173`

## Checks

```bash
bun run typecheck
bun run build
bun run test
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

The web app includes a Gmail connection page at `/login` and `/settings/integrations/gmail`.
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
7. Copy the client ID and secret into `.env`, then restart the API.

The same setup guide is available as a local HTML page at
`http://localhost:5173/docs/gmail-oauth-setup.html` when the web dev server is running.

## Workspace Layout

- `apps/api`: Bun/Hono backend.
- `apps/web`: React/Vite frontend.
- `packages/shared`: Shared schemas, fixtures, and TypeScript types.
