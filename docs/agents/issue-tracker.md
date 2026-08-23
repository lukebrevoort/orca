# Issue tracker: Linear

Issues and specs for this repo live in the user's Linear workspace (the BRE team).

## Conventions

- **All operations go through the Linear MCP tools** (`tools["linear"].*`).
- **Reference issues by identifier and name**: `BRE-123 (Short name)`. A bare id or URL is illegible in narration; wrap links inside the name.
- **Create an issue**: use the Linear MCP create-issue tool; set title, description, and labels explicitly.
- **Read an issue**: fetch by identifier (`BRE-123`) including comments.
- **Apply / remove labels**: edit the issue's label list using the vocabulary in `docs/agents/triage-labels.md`.
- **Comment on an issue**: append a comment; any comment generated during triage must start with the AI-generated disclaimer required by the triage skill.
- **Branch/PR linking**: per `AGENTS.md`, every branch name or PR title must carry the Linear ticket identifier so work stays linked.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a Linear issue on team BRE.

## When a skill says "fetch the relevant ticket"

Fetch the Linear issue by identifier (`BRE-123`) with its comments.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single Linear issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. **Decision tickets** are child issues of the map (Linear parent-child relations), one per decision, each carrying its status in labels/state.
