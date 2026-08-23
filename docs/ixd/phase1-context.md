# Orca Organization System — Product Context

## Product Design Summary

Orca is a human-first web email workspace for people who need a calm, trustworthy view of inbound information. The MVP pivots from Human-versus-Automated navigation to a programmable attention system: email remains the source, while users and authorized agents organize threads into customizable lanes, live Views, curated Collections, typed facets, and lightweight contexts.

The first audience is technically comfortable founders, developers, and operators. The same underlying organization controls will later receive a polished no-code interface for less-technical users.

## User Roles

1. **Technical operator**: Connects an MCP agent, expresses organizational intent, reviews simulations, and grants scoped authority.
2. **Semi-technical organizer**: Uses natural language through an agent but inspects and adjusts the result in Orca.
3. **Manual organizer**: Creates and edits lanes, Views, Collections, and rules through Orca's interface without an agent.

## Core Features and Priority

| Priority | Feature | Purpose |
|---|---|---|
| P0 | Organization module | Provider-neutral thread organization behind one small interface |
| P0 | Custom lanes and policies | One primary lane per thread; user-defined identity and default behavior |
| P0 | Orca language | Safe event-condition-action rules with historical simulation |
| P0 | Agent change sets | Describe, query, simulate, apply, and revert organizational changes; query includes explanation projections |
| P0 | Explainability and audit | Show the winning rule, precedence, actor, reason, and reversible change |
| P1 | Typed facets and contexts | Agent-defined metadata and thin relationships across email threads |
| P1 | No-code organization studio | Manual creation and editing over the same underlying representation |

## Constraints

- Gmail remains read-only for organization work; agents cannot send or delete in the initial authority scope.
- Organization is workspace-wide across connected accounts; account is a filterable facet.
- Every thread has exactly one primary lane and can appear in unlimited Views and Collections.
- Security is designed into the initial seam. Blocking audits occur before rule activation, MCP writes, and persistent agent authority.
- Existing single-user data can be reset during the transition if that reduces migration cost.
- Target MVP date: 2026-09-22.
- Existing stack: React 19, Vite 7, Hono, Bun, SQLite, Drizzle, Zod.

## Design Challenges

1. **Opinionated but recoverable**: The primary experience must hide noise without losing trust or access to All Mail.
2. **Unlimited organization with deterministic behavior**: Users can replace every visible lane, while the system must resolve notification and retention behavior consistently.
3. **Human and agent parity**: The UI and MCP adapter must operate through the same Organization interface.
4. **Power without unsafe execution**: The Orca language must feel code-like while remaining typed, bounded, explainable, and reversible.
5. **Progressive complexity**: Technical users need full control first; manual users later need a calm interface over the same model.

## Design Principles

1. **Attention, not authorship**: Human Signal remains evidence, not the primary information hierarchy.
2. **One truth, many views**: Threads have one primary lane and can appear in unlimited live Views.
3. **Show your work**: Every organizational result names the winning rule, precedence, actor, and reason.
4. **Preview before power**: Broad changes run against historical mail before activation.
5. **Reversible by default**: Organization is non-destructive; destructive behavior requires separate authority and explicit risk acknowledgement.
6. **One interface, two adapters**: Humans and agents receive the same capabilities through UI and MCP adapters.

## Design References

| Product | Reference dimension | Reason |
|---|---|---|
| Linear | Structured, fast workspace interaction | Clear command surfaces, keyboard fluency, and visible system state |
| Notion | User-defined information structures | Flexible properties and Views without forcing one workflow |
| Gmail | Recovery and provider expectations | All Mail and familiar thread semantics provide a safety net |

## Visual Direction

- Preserve Orca's calm, warm, reading-first presentation.
- Put the primary thread stream first; configuration stays one level away.
- Use color only for behavior and risk, not decorative categorization.
- Keep agent activity inspectable without turning the inbox into a developer console.

## Phase 1 Verification

- Product position, users, features, constraints, principles, and references are present.
- Six product-specific principles guide later architecture decisions.
- Status: PASS.
