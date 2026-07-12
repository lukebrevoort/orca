# Project Orca Agent Manual

The primary purpose of this project is to build a human-first interactive email client that users can use as an alternative to something like Gmail, Outlook, and other messengers that have failed to truly evolve over the past few years. It is meant to be a workplace that is fun to write in, that's easy to write in, that is zen and easy to read. It is meant for human-to-human communication and filtering out all the fluff.

---

## Repository Overview

Orca is an early-stage monorepo for a modern email client. It connects to Gmail (and eventually Outlook) via read-only OAuth, normalizes incoming mail into a clean internal model, and presents a calm, opinionated inbox experience. The project is actively being built — expect prototype UI, a growing API surface, and schema changes.

### Stack

| Layer       | Technology                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| Runtime     | **Bun 1.3+** (workspace, test runner, dev server)                           |
| Language    | **TypeScript** (strict, ESM throughout)                                     |
| Backend API | **Hono** (lightweight HTTP framework on Node)                               |
| Database    | **SQLite** via **Drizzle ORM** (file-backed at `apps/api/data/orca.sqlite`) |
| Frontend    | **React 19** + **Vite 7** (SPA, no SSR)                                     |
| Validation  | **Zod 4** (shared schemas in `packages/shared`)                             |
| Auth        | **JWE session tokens** (jose) + **Google OAuth 2.0** (gmail.readonly scope) |

### Workspace Layout

```
orca/
├── apps/
│   ├── api/          # Bun/Hono REST backend
│   │   ├── src/
│   │   │   ├── auth/       # OAuth flows, session middleware, token encryption
│   │   │   ├── config/     # Server config, validated env
│   │   │   ├── db/         # Drizzle schema, migrations, client
│   │   │   └── providers/  # Gmail normalizer + sync engine
│   │   └── drizzle.config.ts
│   └── web/          # React/Vite SPA
│       └── src/
│           ├── App.tsx          # Main app shell (inbox, compose, zen mode)
│           ├── demo-data.ts     # Demo messages shown when API is unreachable
│           └── contact-signature.ts
├── packages/
│   └── shared/       # Shared Zod schemas, TypeScript types, fixtures
│       └── src/
│           ├── schemas.ts      # All wire-format schemas (inbox, auth, messages, threads)
│           ├── fixtures.ts     # Demo fixtures for development
│           └── index.ts
├── docs/             # Design docs and checklists
├── AGENTS.md         # This file
└── README.md         # Setup and development instructions
```

### Key Concepts

- **Human Signal** — The core differentiator. Orca filters mail to surface messages written by real people, not marketing automation or bots. The `humanSignal` field on emails is the foundation for this.
- **Contact Signatures** — Each sender gets a visual glyph and color palette in the UI, making conversations scannable at a glance.
- **Zen Mode** — A distraction-free writing experience. The compose panel can expand into a full-screen zen writer.
- **Provider Abstraction** — The shared schemas define a `MailProvider` enum (`gmail` | `outlook`). The API normalizes provider-specific data into a common internal model before it reaches the frontend.
- **Sync Engine** — Gmail messages are fetched via the Gmail API, normalized, and stored locally. Sync is cursor-based and handles pagination.

### Database Schema (SQLite / Drizzle)

Core tables managed in `apps/api/src/db/schema.ts`:

| Table            | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `users`          | Orca user accounts (email, display name)                                   |
| `sessions`       | Signed session tokens with expiry                                          |
| `oauth_accounts` | Connected provider accounts (encrypted tokens, sync cursor)                |
| `threads`        | Normalized conversation threads per account                                |
| `emails`         | Individual messages with body, read/starred/draft flags, and `humanSignal` |
| `labels`         | Provider labels mapped per account                                         |
| `email_labels`   | Many-to-many join between emails and labels                                |
| `contacts`       | Known contacts per account                                                 |

### Running Locally

```bash
bun install                          # install all workspace deps
cp .env.example .env                 # copy env template
bun run dev                          # start both api (:3000) and web (:5173)

# or individually
bun run dev:api
bun run dev:web
```

### Checks

```bash
bun run typecheck   # type-check all workspaces
bun run test        # run tests across all workspaces
bun run build       # production build
bun run lint        # type-level linting (tsc)
```

### Current State

- Gmail OAuth connect and callback flow is wired end-to-end.
- Gmail sync engine fetches, normalizes, and persists messages to SQLite.
- Frontend renders a real inbox from the API (with demo fallback).
- Compose panel and zen writer are implemented as UI shells (no send path yet).
- No Outlook support yet — schema and types are ready for it.
- No user registration or multi-user auth — sessions exist but the login UX is OAuth-only for now.

### Things to Know

- All IDs in the database are **text UUIDs** (not auto-increment integers).
- Tokens are **encrypted at rest** using AES-GCM via `token-crypto.ts`.
- The shared package is consumed as raw TypeScript (no build step, exports `./src/index.ts` directly).
- Tests live next to source files (`*.test.ts`) and run via `bun test`.
- The API validates request shape at the edge using Hono's `validator` + shared Zod schemas.

### Verifying Workspace

The most important thing to do when completing a ticket or creating a PR is give
reviewers **EASY** evidence that shows you have completed the task. This means
for UI in every PR comment there should be a screenshot or for testing Validation
it should always be explicitly said.

Make sure that all work is VERIFIABLY correct to the best of your abilities when ready
for a review.

### Linear

Whenever working with linear, you have to, in either the branch name or the PR name, add the ticket, UUID to it so that the linear is linked. That is absolutely essential for us to be able to keep track of work.
