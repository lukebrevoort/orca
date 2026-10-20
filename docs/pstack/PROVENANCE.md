# Provenance and updates

- Author/project: Lauren Tan, pstack in `cursor/plugins`.
- Immutable reviewed revision: `1e5c90a4b6f249917bd21fe361b3a2a7deb741b8`.
- Official source: https://github.com/cursor/plugins/tree/1e5c90a4b6f249917bd21fe361b3a2a7deb741b8/pstack
- License: MIT, copyright (c) 2026 Lauren Tan; full notice retained in [LICENSE](LICENSE).
- Source inspected before adaptation: upstream LICENSE, README, plugin metadata, setup/verification/overnight guide, poteto-mode routing and principles, investigation/feature/bug/performance/shipping playbooks, create-verification-skill, maintain-verification-skill, interrogate and encode-lessons-in-structure.
- Local adaptations: `.agents/skills/{poteto-mode,verify-orca,create-verification-skill,interrogate,encode-lessons-in-structure}` and `docs/pstack/`. These are rewritten, scoped procedures, not a verbatim vendor tree. `scripts/pstack/` is Orca-owned tooling using existing Orca fixtures; no upstream executable is bundled or executed.

Upstream is a Cursor plugin. Its `.cursor` skill paths, custom mode persistence, Task tool/model slugs, `/loop`, cloud orchestration, external `cursor-team-kit` controls and built-in create-skill are not native Codex APIs. The adapter substitutes explicit local skill reads, available authorized reviewer tools, the Orca fixture CLI and finite work-to-draft procedures. Cursor users may read the same guidance by path, but this repository does not register or install a native Cursor plugin. Upstream authorization to post chat, automate or merge is intentionally removed.

To update: resolve upstream main to an immutable SHA using a read-only GitHub view or fetch, inspect the license and changed README/plugin/skills/playbooks/agents/automation files before copying or running anything, and compare the skill/playbook inventory against `coverage.md`. Review compatibility and permission changes explicitly. Adapt relevant changes in a separate PR, retain the MIT notice, update the pinned SHA and inventory, rerun doctor/trial/failure/cleanup/integrity checks at the new committed source, and obtain independent review. Never execute upstream bootstrap/watch/orchestration scripts as an update step. Dependency installation from an unrecognized source needs separate approval; fetching source to inspect it does not authorize execution. No automatic update hook is installed.
