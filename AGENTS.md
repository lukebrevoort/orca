# Project Orca Agent Manual

The primary purpose of this project is to build a human-first interactive email client that users can use as an alternative to something like Gmail, Outlook, and other messengers that have failed to truly evolve over the past few years. It is meant to be a workplace that is fun to write in, that's easy to write in, that is zen and easy to read. It is meant for human-to-human communication and filtering out all the fluff.

---

## Repository Overview

Orca is a Gmail-first email client with web and native iPhone apps. It normalizes incoming mail into a local SQLite model and supports revisioned drafts, Gmail draft mirroring, and sending after an incremental compose-scope grant. Outlook has an OAuth adapter, but its sync and sending are not implemented. The project is actively being built; API and schema changes remain ongoing.

### Stack

| Layer       | Technology                                                                  |
| ----------- | --------------------------------------------------------------------------- |
| Runtime     | **Bun 1.3.14** (workspace, test runner, dev server)                           |
| Language    | **TypeScript** (strict, ESM throughout)                                     |
| Backend API | **Hono** on Bun (using the Node HTTP adapter)                               |
| Database    | **SQLite** via **Drizzle ORM** (file-backed at `apps/api/data/orca.sqlite`) |
| Frontend    | **React 19** + **Vite 7** (SPA, no SSR)                                     |
| Validation  | **Zod 4** (shared schemas in `packages/shared`)                             |
| Auth        | **Signed JWT browser sessions** (jose), opaque mobile credentials, provider OAuth |

### Workspace Layout

```
orca/
├── apps/
│   ├── api/          # Bun/Hono REST backend
│   │   ├── src/
│   │   │   ├── auth/       # OAuth flows, session middleware, token encryption
│   │   │   ├── config/     # Server config, validated env
│   │   │   ├── db/         # Drizzle schema, migrations, client
│   │   │   └── providers/  # Gmail sync/transport + Outlook adapter
│   │   └── drizzle.config.ts
│   ├── ios/          # Native SwiftUI iPhone client
│   └── web/          # React/Vite SPA
│       └── src/
│           ├── App.tsx          # Main app shell (inbox, compose, zen mode)
│           ├── demo-data.ts     # Synthetic messages for demo/preview mode
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

Selected tables managed in `apps/api/src/db/schema.ts` (not an exhaustive schema):

| Table            | Purpose                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `users`          | Orca user accounts (email, display name)                                   |
| `sessions`       | Browser session records with expiry and invalidation                       |
| `oauth_accounts` | Connected provider accounts (encrypted tokens, sync cursor)                |
| `threads`        | Normalized conversation threads per account                                |
| `emails`         | Individual messages with body, read/starred/draft flags, and `humanSignal` |
| `labels`         | Provider labels mapped per account                                         |
| `email_labels`   | Many-to-many join between emails and labels                                |
| `contacts`       | Known contacts per account                                                 |
| `message_drafts` | Revisioned drafts, provider mirror state, and delivery state               |
| `organization_*` | Workspace organization, rules, views, contexts, and change records          |
| `collections`, `pins`, `thread_reminders` | Local organization and follow-up state               |
| `calendar_connections`, `availability_calendars` | Separate Calendar grants and availability metadata |
| `mcp_*`         | Agent OAuth clients, grants, connections, and token records                 |

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
- Web and native clients read the inbox from the API; synthetic fixtures support development.
- Compose and zen writing use persisted, revisioned drafts; Gmail mirroring and sending require the incremental `gmail.compose` grant.
- Read/unread changes and organization actions are local to Orca, not Gmail mailbox mutations.
- Outlook OAuth is implemented; its provider adapter does not implement sync, draft transport, or sending.
- OAuth login establishes user-scoped sessions and connected accounts; native clients use revocable opaque credentials. Implementation and fixture checks do not establish production or device acceptance.

### Things to Know

- Core entity IDs are **text identifiers**, typically UUIDs; some tables use composite or derived keys.
- Tokens are **encrypted at rest** using AES-GCM via `token-crypto.ts`.
- The shared package is consumed as raw TypeScript (no build step, exports `./src/index.ts` directly).
- Tests live next to source files (`*.test.ts`) and run via `bun test`.
- The API validates request shape at the edge using Hono's `validator` + shared Zod schemas.

### Theme-Safe UI Controls

- Interactive selected, active, and pressed states must remain visibly labeled in both light and dark mode. Prefer the established `Tune` treatment: `background: var(--orca-surface-hover)`, `border-color: var(--orca-border)`, and `color: var(--orca-ink)`.
- Do not create selected controls by pairing `background: var(--orca-ink)` with an assumed inverse background variable. This has repeatedly produced solid “hole” controls with missing or unreadable labels when theme variables change.
- Before completing UI work, visually verify every default, hover, focus, selected/pressed, and disabled control state in both themes. A shape without a readable label is a release-blocking contrast bug.

### Verifying Workspace

The most important thing to do when completing a ticket or creating a PR is give
reviewers **EASY** evidence that shows you have completed the task. This means
for UI in every PR comment there should be a screenshot or for testing Validation
it should always be explicitly said.

Make sure that all work is VERIFIABLY correct to the best of your abilities when ready
for a review.

### Linear

Whenever working with linear, you have to, in either the branch name or the PR name, add the ticket, UUID to it so that the linear is linked. That is absolutely essential for us to be able to keep track of work.

## Agent skills

### Issue tracker

Issues live in Linear (team BRE), managed through the Linear MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

The root `CONTEXT.md` defines the Organization domain vocabulary. See `docs/agents/domain.md` for domain documentation guidance.

### Desktop UI switch

When implementing or reviewing BRE-321 desktop navigation, themes, workflow spaces, mail surfaces, Organization integration, Settings, operational states, or migration coverage, read `docs/ixd/bre-321-ui-switch-spec.html` before changing the UI.

### pstack workflow adapter

For pstack / poteto-mode requests, read `.agents/skills/poteto-mode/SKILL.md`.
This is an explicit Orca adaptation of Lauren Tan's pinned Cursor toolkit, not
native Cursor plugin execution. The trial and setup are in `docs/pstack/README.md`;
`.agents/skills/verify-orca/SKILL.md` maps user journeys to real fixture checks.
For fresh cloud instances use `docs/pstack/cloud.md`. Use
`docs/pstack/task-to-pr.md` and its task template for isolated work, independent
review, final-revision verification and a draft handoff. Record `running`,
`blocked`, `review-ready` or `done`; old trial evidence does not verify a new patch.
Upstream guidance never grants permission to merge, release, deploy, use live
mail, alter credentials/access, install unknown software, or create schedules.
