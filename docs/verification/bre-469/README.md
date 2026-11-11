# BRE-469 — captured preference owner at the server boundary

Status: API regression/guard and corrected checkpoint typecheck pass; exact-final full gates, independent review and combined client/device verification remain separate. The user interface alone cannot atomically protect a generic preference PATCH when its session changes during an authenticated preflight.

## Actual failures and source identities

The web worker retained a real loopback browser/API/SQLite red at clean8955eab4: load U preferences, type an edit, switch to V, then Save wrote U edits into V. Client pre/post identity checks made that straightforward case pass, but the stronger held-response case still failed: hold committed U /auth/session response, switch cookie to V, release U, then Save could mutate V before the post-check hid the editor. `/tmp/bre469-held-identity-red-1/results.json` records4scenarios14assertions2failures/0pageerrors. These are web branch observations, not application executions on this API-only branch.

The independent API red at clean test-only `c74db69c86cbf4300bf9a66b04e753896c326d80` has1pass/3fail. Cookie GET returned200 instead of409 (the later cookie PATCH assertion was not reached); replacement mobile-bearer PATCH also returned200; malformed owner precondition returned200 instead of400. [Raw log](baseline-c74db69c.log). At `f5d38dedbea554facd10b29583ec90972b04f48e`, positive-control SQL instrumentation was added and the same1pass/3fail reproduced, [log](baseline-f5d38ded.log). The actual cookie write/independent DB red remains the browser evidence above; do not infer unexecuted assertions from the API failure.

Production guard `86030e8dd1b8212e015224eda191bdad73b3f1b8` passed41 focused/API-index tests,40 expect calls, [log](focused-86030e8d.log). Its typecheck failed because the new test helper promised Promise<Response> while Hono's request overload also permits synchronous Response, [failure](types-failed-86030e8d.log). Test-only `71c0a0fb9081f1c01f6a7699b0934515aceb96b4` makes the helper async; actual inspected typecheck passed, [log](types-71c0a0fb.log). The premature status sent before reading that failure was immediately corrected; no production guard logic changed.

## Contract

Optional request header `x-orca-expected-user-id` on GET/PATCH /v1/preferences contains the verified user ID captured when the draft/load/recovery operation belonged to that owner. Capture it before awaits. Do not substitute the current mutable account/user or the token lookup's owner at dispatch.

The server authenticates the request normally, then compares the precondition to that request's immutable authenticated user ID before any preference access. Mismatch:409 with `error.code = session_owner_changed`, no preference reads/writes and private,no-store response. Malformed empty/whitespace/over256-character values:400. Valid unauthenticated requests remain401. Missing header retains legacy behavior. Body, strict legacy/guidance responses, monotonic guidance completion and same-owner behavior are unchanged. The header is a precondition, never authentication or a claim to another account.

CORS already reflects requested headers for allowed origins in the installed Hono middleware. The explicit preflight regression verifies this header/PATCH are accepted without broadening allowed origins or opening a DB; no origin configuration was changed. No migration or provider/network/notification feature is added.

## Same-regression proof and client dependency

The guarded regression checks cookie GET/PATCH and mobile-bearer PATCH mismatches, complete independent preference rows unchanged, and zero preference-table preparation calls. A successful captured-owner read proves the instrumentation is live. Positive/legacy controls use exact strict schemas. Bounds/authentication and CORS tests remain separate.

Web integrated root71 at clean `5cbf636c62dfab8fa5ee3576a2b39d162032c260`; exact held-U-response/cookie-V replay passed4scenarios16assertions in both themes,0pageerrors. Request evidence records original U header; GET plus independent SQLite show V unchanged and the UI applies the owner barrier. `/tmp/bre456-runtime-committed-2/held-owner/results.json`. This is the actual combined web branch; this API-only PR does not contain the web changes. Native's transmitted-header/held-token fixture is separate and must integrate this server guard before claiming DB protection. Other legacy optional-header callers are not automatically owner-bound by this patch.

## Reproduce / demo

From a clean committed checkout with frozen dependencies, Bun1.3.14 and Node24:

```sh
bun test apps/api/src/preferences-owner.test.ts apps/api/src/index.test.ts
bun apps/api/scripts/preferences-owner-fixture.ts /tmp/bre469-NEW-demo
```

The fixture owns a127.0.0.1 ephemeral HTTP server, synthetic sessions and SQLite, prints counts and retains a credential-free transcript plus before/after rows. It refuses existing outputs, pins Git identity, and removes its own server/DB on completion. On the shared Mac, run through the session cooperative heavy wrapper. A fresh checkout may use the plain commands above; no local /tmp wrapper is required elsewhere. Final exact-head receipts are reported separately, not relabeled from earlier checkpoints.

## Rollback and limits

No DB change. Reverting the optional guard restores the reproduced race for clients that send the precondition; coordinate clients and disable affected preference saves before such a rollback. Preserve captured unsaved writing until its original authenticated owner returns. The guard neither serializes competing same-owner saves nor protects clients that omit the header; existing compatibility is intentional. Final full application, native SwiftUI/XCTest, real mail and device acceptance remain unverified.
