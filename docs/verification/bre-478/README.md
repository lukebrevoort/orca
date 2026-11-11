# BRE-478: View commit recovery proof

Status: running; early coherent draft PR #316 published at `d67de0bf148feb8764d14a53abfaa9cefb65af6b`; independent correctness/security review and merge gate remain with root.

This API/shared-only change adds authenticated `POST /v1/organization/views/commit-status`. Its request is the existing strict `organizationViewCommitRequestSchema`. The legacy commit success and error envelopes are unchanged. No schema migration, cancellation, provider call, evaluation, or client implementation is introduced.

The strict `organizationViewCommitStatusResponseSchema` is exported through the existing shared wildcard export. Every response carries `operation: "view_commit"`, authenticated `workspaceId`, `retryKey`, and the original `expectedRevisions: {workspace, view}`. Clients must strictly parse and bind these fields to their immutable pending command and owner before accepting proof.

- `applied`: `viewId`, `committedWorkspaceRevision`, `committedViewRevision` come from the validated original receipt. Current View deletion or later changes do not erase that proof.
- `not_applied`: `reason` is `workspace_advanced` or `unchanged_view`; `observedWorkspaceRevision` and nullable `observedViewRevision` explain the fence.
- `unknown`: `reason` is `eligible_or_unresolved`, `future_revision`, `command_mismatch`, `incompatible_reservation`, `invalid_receipt`, or `workspace_unavailable`. This never permits unlocking a pending command.

The canonical binding is the exact existing lower-level `{kind:"create",request}` or `{kind:"update",viewId,request}` mutation. Shared extraction preserves reviewed-draft digest, summary, eligibility, scope and revision checks. Review-only source/summary/zero-confirmation fields are not stored in the receipt; this endpoint does not claim full-envelope receipt binding.

One deferred SQLite read transaction establishes its snapshot with live Workspace-owner existence. It rechecks human actor identity, Account ownership, query authority and (for agents) live apply authority; validates metadata references; inspects workspace-wide key reservations across all resource families; validates matching receipt and original authority; then reads Workspace revision and target View. It never uses lazy write-side Workspace initialization. Existing global authentication middleware may renew an expiring browser session before the classifier; zero-DML end-to-end evidence is scoped to fresh sessions. A separate expiring-session case verifies that renewal changes authentication only, with all domain tables unchanged. A reservation always wins over an absence proof. An absent/foreign update target without a matching original receipt yields 404 and no typed proof even if the Workspace advanced. Corrupt receipts cannot fall through to absence.

For an absent receipt, Workspace revision W > expected E is a durable fence: the eventual commit write transaction requires equality. W < E is unresolved because future equality remains possible. At W = E, an update is certifiably unchanged only when the expected View revision still equals the persisted revision and name, description, color, position, skipInbox and the full definition match the exact shared commit no-op predicate. Any intervening legitimate mutation advances revisions. This certificate applies only to `/views/commit`; equivalent lower-level PATCH updates still write and increment revisions. A read snapshot does not cancel a request.

The proof assumes one preserved Workspace/database lifetime. Legitimate deletion keeps receipts and advances Workspace revision. Database restore, same-ID Workspace recreation, receipt pruning or revision reset require an epoch or explicit client journal invalidation; this patch does not establish proof across those operations.

## Provenance and reproduction

Starting published base: `03c6045e6a1ea87583c012f2c7d4c037f078ebe6`, PR #315 / branch `fix/BRE-469-preferences-owner`, dependent on #311/#309.

Test-only baseline: `1e23dd66a47ef0b660d5d6eb6abd5dd989872aa8` (preceded by test-only `a29564aa`). Node 24.22.1 / Bun 1.3.14, frozen install. Real authenticated API and migrated SQLite: **0 pass, 3 fail**, all at status endpoint **404** after no-op **400**, stale create **409**, and commit **200** preconditions passed. Evidence: `/tmp/bre478-api-red-1e23dd66`.

Candidate checks must run at a clean committed exact head with fresh output directories. Use the goal's `/tmp/orca-ui-heavy-slot.py` wrapper once around each allocated sequential job, never nested. Runtime PATH starts with `/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` and uses `/opt/homebrew/bin/bun` 1.3.14. Focused command: `bun test apps/api/src/organization/views/commit-status.test.ts packages/shared/src/organization-views.test.ts`; relevant API/shared `typecheck` follow sequentially. Full final lint, typecheck, tests and build remain required. Do not infer native, device, OS, live mail, or provider behavior from these synthetic API fixtures.

Tests cover late immutable originals after proof, re-open/lost ACK equivalents, current update/delete after receipt, exact advanced definitions, eligible/future commands, body/key mismatch and other-family reservations, corrupt receipts, malformed/foreign/unauthenticated scope, Account revocation while route `req.json` is held, live agent revocation, a separate WAL writer committing the original after the status snapshot begins, repeated status, complete advanced Account/Lane/Facet/Context/Workflow/Human Signal/sender/date/Thread definitions, and zero DML/body reads. `PRAGMA query_only`, independent all-table snapshots, observed SQL and per-connection `total_changes()` establish read-only behavior; an attempted real UPDATE is a positive control. Missing Workspace state must remain absent. No browser or native execution is claimed.

Rollback: revert only the BRE-478 commits above the parent #315; no DB migration or durable status state needs rollback. Native must not adopt typed proof until the matching published contract passes review and integration verification.

Early candidate exact `d67de0bf148feb8764d14a53abfaa9cefb65af6b`: focused **30 pass / 0 fail** (14 recovery API cases and 16 shared cases); real API/shared `tsc -p tsconfig.json` pass. Logs: `/tmp/bre478-api-focused-d67de0bf` and `/tmp/bre478-api-types-d67de0bf`. Initial misordered Bun typecheck command printed usage with exit 0; that attempt is retained and explicitly not counted as verification. Later source additions require new exact-head gates.
