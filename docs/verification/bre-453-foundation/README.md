# Foundation integration gate

This first rework integration combines three bounded deliverables before the new importance and complete client implementation:

1. BRE-444 / PR303: native digest width hints with conservative semantic/content/privacy exclusions.
2. BRE-446 / PR305: five uncalled API helpers and an obsolete npm lock removed, current setup guidance corrected, and a reproducible [source audit](../bre-446/audit-cleanup.mjs).
3. BRE-453: the four Space pages translated into [33 acceptance requirements and 16 surface specifications](../../ixd/bre-453/requirements.json), an independently reviewed design and an [interactive architecture sketch](../../ixd/bre-453/architecture-options.html). Those requirements remain unverified product work.

Main prerequisite: `75df5e597b24c13cde7c047019bfe8a3ba66ea7c`, which already contains verified BRE-448/449/450/451. Component heads `01f6909ee534177a4fbaf486c29b06d7e7ba55e2` and `707e012c7f977730badaa06912d6d8f13f4d0668` are preserved as ancestors. Their older CI results are historical; the integration PR records its exact final revision and current checks.

Fresh independent component correctness/security reviewers `/root/review_cleanup_final` and `/root/review_native_width_final`, both GPT-6.1-sol, found no blocking source findings. The cleanup review's missing runnable demo was addressed; Gmail grant wording was made precise. The full combined revision still receives its own review and relevant lint/typecheck/tests/build and hosted native gates before merging.

Reproduce the cleanup demo with `node docs/verification/bre-446/audit-cleanup.mjs` using Node24 and frozen dependencies. Expected counts: five private functions, 178 retained normalized statements, five unchanged canonical dependency inputs, 61,924 removed lock bytes. This is source proof, not a performance benchmark. [Native before/after captures and measurements](../bre-444/README.md) distinguish historical failing/component runs from current integration verification. The architecture sketch has 48 checks across four theme/width states with zero requests; it has no API persistence or delivery behavior.

Use existing workspace lint/typecheck/test/build commands, serialized locally, plus the automatically triggered Unit Tests, Fixture Checks and Native Reader Checks. Inspect identities, exits, expected test counts, selected screenshots and any failures. CPU/RSS and memory snapshots are retained in `/tmp/orca-ui-heavy-resources.jsonl`; temporary cooperative locking serializes local heavy jobs. No local simulator is needed for these hosted gates.

Rollback by reverting the eventual integration merge, retaining component ancestry and evidence. No historical evidence, user data or advanced feature is deleted. No live mail, physical-device, production migration, manual deployment or TestFlight acceptance is claimed. BRE-452 and BRE-459 retain the known separate Zen/native Feedback overlap work; the complete application rework is pending.
