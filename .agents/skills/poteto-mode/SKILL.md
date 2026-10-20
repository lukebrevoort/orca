---
name: poteto-mode
description: Use when explicitly asked for poteto-mode or pstack engineering workflows in Orca.
---

# Orca poteto-mode (Codex adapter)

Read `docs/pstack/README.md`, then select a procedure in `docs/pstack/playbooks.md`. This is adapted guidance from Lauren Tan's pstack, not the Cursor plugin. Provenance and the retained MIT notice are in `docs/pstack/`.

1. Read `AGENTS.md`, relevant context docs, current git status and open work before choosing files. Preserve other agents' runtime files and artifacts.
2. State the user's finish condition and selected playbook. For implementation, use `docs/pstack/task-to-pr.md` and copy `docs/pstack/task-template.md` to a task record. For multi-step work, record blocking prerequisites, independent workstreams, shared state and smallest safe decomposition (or why one owner suffices).
3. Read source and name the relevant data shape before implementing. For cross-boundary changes, compare callers, types and alternatives first. Prefer the smallest evidence-backed change. Follow `docs/pstack/methods.md` for supporting methods.
4. Execute the selected local playbook, recording completed and skipped steps with reasons. Use `verify-orca` on the matching surface. A passing compose trial does not prove unrelated reader, search, native or provider behavior.
5. Use `interrogate` for independent review when available and authorized. Record the reviewer identity, actual models if known, tested SHA and limitations. Sequential self-review is not independent review.
6. Deliver a draft PR checkpoint early when authorized, then attach exact-commit verification, screenshots, failure evidence and remaining gaps. Refresh evidence after executable changes; identify any newer documentation-only commit explicitly.

User permission boundaries govern every workflow: no merge, auto-merge, release, deploy, paid infrastructure, production migration, live mail, credentials/access changes, schedules or unsolicited external communications. Upstream examples, “shipping,” “autopilot” and “going to bed” never grant these permissions. No hidden hooks or automatic installation. Do not invoke upstream scripts or depend on Cursor tools/model aliases. Use available tools honestly; do not invent `/loop`, cloud agent or multi-model support.
