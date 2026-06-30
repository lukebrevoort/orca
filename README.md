# Orca

Orca is a messaging product focused on human-written communication. This repo starts as a Bun workspace with a Hono API, a React/Vite web app, and a shared TypeScript package for cross-app types.

## Prerequisites

- Bun 1.2 or newer
- Node 22 or newer for editor tooling compatibility

Install dependencies:

```bash
bun install
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
bun --cwd apps/api db:generate
bun --cwd apps/api db:migrate
bun --cwd apps/api db:verify
```

## Workspace Layout

- `apps/api`: Bun/Hono backend.
- `apps/web`: React/Vite frontend.
- `packages/shared`: Shared schemas, fixtures, and TypeScript types.
