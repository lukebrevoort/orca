# One schema validation per HTTP thread read

## Scope and contract

Base: `c2bac9ad808836fca78bfe8d532df86a46ceb3fa`.

The only production change is the return expression in `GET /v1/threads/:threadId`.
`readThreadDetail` executes `readThreadDetailSnapshot` in a deferred transaction;
the snapshot ends with `threadDetailSchema.parse`. The HTTP route previously sent
that already-validated result through `jsonWithSchema`, applying the same schema
again. It now serializes the validated return value directly with `c.json`.

All callers of the reader were inspected:

- HTTP thread detail: keeps the reader's schema validation and removes only the duplicate
- MCP `getThread`: still calls the same validating reader after account and Organization authorization
- Reply-brief route: still calls the same validating reader after invocation and account checks

The reader, transaction, queries, authorization, serializer, HTML sanitizer, error
handling and shared schemas are unchanged. No general-purpose validation bypass
or opt-out is added. Other `jsonWithSchema` call sites are unchanged.

The thread schema is strict at every response object boundary. Its reachable
normalizations (trimming strings and lowercasing override targets) are idempotent;
its defaults are fixed values, not time-dependent or generated values. The first
parse still applies them and rejects unknown fields. The tests protect these
properties for defaults, trimming, strict contacts and the complete serialized
response. If a future schema adds a non-idempotent transform, the response
comparison assertion requires deliberate review.

## Reproduce the controlled comparison

Run from the repository root with Bun 1.3.14 and installed dependencies:

```sh
git show c2bac9ad808836fca78bfe8d532df86a46ceb3fa:apps/api/src/index.ts \
  > apps/api/src/index.thread-validation-baseline.ts
THREAD_BASELINE_MODULE="$PWD/apps/api/src/index.thread-validation-baseline.ts" \
  bun apps/api/benchmarks/thread-validation.ts
rm apps/api/src/index.thread-validation-baseline.ts
bun test apps/api/src/thread-detail.test.ts
bun run lint
bun run typecheck
bun run test
bun run build
```

Do not commit the temporary baseline module. The script uses a disposable SQLite
database, synthetic accounts/messages and test-only credentials. It uses no live
mailbox, provider network access, production database or deployment. It compares
the same database through both actual `createApp` implementations in one process.

## Evidence

Before changing production code, the existing thread test passed. Adding the
parse-count regression to the unchanged base failed as expected (`2 !== 1`).
The same test passes after the one-route change.

The controlled comparison requires exact equality of HTTP status, headers and
serialized response bytes. It covers empty, 4-message, 50-message and 250-message
threads, unsafe provider HTML, classifier normalization, missing authentication,
missing query, foreign account, missing thread, negative thread count, invalid
references and an unknown contact field. The regression additionally covers
foreign threads, attachment validation, message order, labels, attachments,
attention state, body values and no SQL body amplification.

Deterministic work counts:

| Thread messages | Before schema calls | After schema calls | Message objects validated before → after |
| --- | --- | --- | --- |
| 0 | 2 | 1 | 0 → 0 |
| 4 | 2 | 1 | 8 → 4 |
| 50 | 2 | 1 | 100 → 50 |
| 250 | 2 | 1 | 500 → 250 |

Invalid persisted output still invokes the schema once and returns the same 500
response. Authentication/query/account/missing-thread denials never invoke it.

The script also alternates schema-only single/double-parse batches in one process,
with 200 repetitions per sample, seven measured samples per mode after warm-up.
This measures the removed validation work, not request latency or user-visible
message-open performance. Wall-clock samples vary with host contention and GC;
they are observations, never pass/fail thresholds. Exact work counts and response
equivalence are the stable acceptance criteria.

Observed schema-only medians on the cloud Linux fixture run:

| Messages | Two parses (ms) | One parse (ms) |
| --- | --- | --- |
| 0 | 0.021 | 0.008 |
| 4 | 0.068 | 0.033 |
| 50 | 0.667 | 0.320 |
| 250 | 3.999 | 1.969 |
