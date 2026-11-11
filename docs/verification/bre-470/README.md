# BRE-470 — APNs authority at the actual request boundary

Status: the actual signing-gap regression is reproduced and the guarded source checkpoint passes. Final exact-head full gates, independent re-review, hosted checks and client/device acceptance remain separate requirements.

## Root cause and observed failure

The scheduler rechecked policy, account/session/device generation, read/importance state, configuration and its lease after token decryption. Production APNs transport then awaited PKCS8 import/JWT signing before opening HTTP/2. A correction during this asynchronous signing gap could still start a request.

At clean test-only `a565a7ce7b0889656c29af1a474c06f092e7622a`, the new regression ran the actual scheduler and SQLite fixture, adopted Important-only, queued an eligible incoming message, and entered real WebCrypto ECDSA signing. While signing was held, the real importance writer changed the conversation to Not important. Releasing signing opened **one synthetic HTTP/2 request, expected zero**: zero tests passed, one failed. [Raw red log](baseline-a565a7ce.log).

The subprocess replaces only the external HTTP/2 connection/stream boundary; real WebCrypto signing is held and resumed. There are zero provider network calls, and neither the synthetic stream response nor any delivery counter proves APNs/OS delivery. The regression directly counts connection creation and request opening even if a later database guard prevents a false sent receipt.

## Fix

A synchronous authority callback is now shared by the scheduler's post-decryption gate and the production transport's post-signing gate, immediately before connection/request creation. No await intervenes after that transport check. It covers current lease owner/expiry, configuration, account/session/device generation, adopted or legacy eligibility, importance and read state.

Suppression is a local outcome, not an APNs status or attempt. It does not increment attempt_count. Expired/replaced workers cannot overwrite the row owned by another worker or prevent a future valid claim. The public notification wire, stable APNs IDs, cooldown, adoption and existing transport retry semantics are unchanged. No SQL migration is added.

## Measured checkpoint

At clean integrated source `013f24f74aabb6586d2deed14ec88e1bca5b0d52` (fix `2f96314b`, normal merge of published parent579), focused tests passed **52 tests /124 expect calls**, and API typecheck passed. [Manifest](checkpoint-013f24f7.json), [test log](focused-013f24f7.log), [typecheck](typecheck-013f24f7.log). These are checkpoint results, not relabeled as a later evidence commit.

The production-signing scenarios cover correction, read, session invalidation, account removal, permission denial, token replacement, configuration loss, lease expiry and lease replacement. All nine observed zero request/connection boundaries and zero provider attempts; unchanged authority opened exactly one synthetic request and marked one sent attempt. Expired/replaced leases retain their delivery row for the legitimate owner/reclaim path.

## Reproduce / demo

From a committed, frozen-dependency checkout with Bun1.3.14, use the cooperative serial wrapper:

```sh
python3 /tmp/orca-ui-heavy-slot.py bun test apps/api/src/notifications/apns-signing.test.ts
```

To inspect the actual request-boundary/SQLite transcript for one scenario:

```sh
python3 /tmp/orca-ui-heavy-slot.py bun apps/api/src/notifications/apns-signing.probe.ts correction
```

Replace correction with read, session, account, permission, token, configuration, lease, lease-owner or unchanged. Each process creates only owned synthetic DB/session/key data and removes its fixture directories in finally; no live credentials, providers, browser, Apple simulator or OS notification is used. Global mock/signing hooks are isolated to the child process. The full API suite retains legacy dispatch, retry/concurrency, adoption and revocation coverage. Final full-head receipts are reported separately in the PR.

## Rollback

This patch has no database changes. Preserve adoption policies/tombstones and durable outbox data. Reverting the guard restores the reproduced pre-request race; disable affected dispatch before such an application rollback. Do not erase adoption history or reset account ownership as a workaround.
