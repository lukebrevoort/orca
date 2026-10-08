# Sent draft-list payload regression

## Reproduction before the fix

Base: `f0a9180a8a185cd2bdb293d87a617e81414ebbaf`.
Failing regression commit: `4819fcf3079f36761c9cebb0629cdcadc59470fc`.

The new regression calls the actual authenticated Hono application and migrated
SQLite database. It seeds only synthetic data: 200 sent and five unresolved
drafts, each with 16 KiB text, 8 KiB HTML and a 48 KiB attachment (64 KiB base64).
The opt-in request on the original code returns all sent content and fails
`opt-in list must omit sent text` (16,384 bytes instead of zero).

Reproduce with Bun 1.3.14:

```sh
ORCA_BENCHMARK_DRAFT_LIST=1 bun test apps/api/src/draft-list-payload.test.ts
```

The same test was run red against the byte-verified original API source before
the production change, then green after it. See [red.txt](red.txt) and
[green.txt](green.txt). No live mailbox, provider traffic or user data is used.

## Change and compatibility

`GET /v1/drafts?accountId=...&omitSentContent=true` keeps every draft identity,
revision, delivery/sync state, recipient and provider metadata. For `sent` rows
only, SQLite projects body text to `""`, body HTML to `null`, and attachments to
`[]`, before Drizzle materializes results. All unresolved states (`draft`,
`queued`, `sending`, `rejected`, `ambiguous`) retain complete content.

Omitting the flag or passing `false` preserves the original list contract.
Single-draft detail reads always return the full record. There are no schema
migrations or stored-content changes. The native list client opts in; older
servers ignore the new parameter safely. Its only production consumer is
`DraftsView`, which filters sent rows before constructing a composer. Recovery
uses the unchanged detail client. Sent identities remain available to reconcile
local copies; this change does not implement that separate reconciliation.

## Measurements

| Actual request measure | Legacy/full list | Opt-in list |
| --- | ---: | ---: |
| Response bytes | 18,596,791 | 553,391 |
| SQLite result bytes materialized into Drizzle | 18,550,256 | 503,256 |
| Draft records returned | 205 | 205 |
| Draft-list SELECTs | 1 | 1 |

Response bytes fall 97.0%; materialized result bytes fall 97.3%. The latter is
measured from actual SQLite statement values, not a reimplemented query.
It does not measure SQLite disk pages read.

The final local run also alternated seven warmed requests per mode with row-size
instrumentation disabled: median 61.98 ms legacy versus 27.13 ms opt-in. These
are informational in-process synthetic timings, not device, network or
production-latency claims. CI asserts deterministic byte reduction and contract
preservation, not a timing threshold.

## Verification

- Actual-route regression: red on baseline, green after fix
- API/shared/core suite: 815 passed, zero failures across 128 files
- API and shared TypeScript checks: passed
- CI shell syntax: passed
- Evidence exporter tests: four passed
- Independent review: focused API regression rerun, query/state/account-scope
  behavior checked, model declaration identity and uniqueness checked

The existing native wire smoke now checks sent list metadata and full detail
retrieval through the production Swift client. iOS fixture CI invokes it before
unit/UI tests. Its prior compiler-input blocker is corrected by moving four
existing pure Codable saved-view declarations verbatim from `MailboxViews.swift`
to `Models.swift`; model shapes and project membership are unchanged.

Swift/Xcode and iOS simulation are unavailable in this Linux environment. Native
compilation, wire smoke and device/UI behavior must be verified by macOS CI;
they are not claimed as passed here. Full web build/tests are likewise left to
repository CI. Keep the PR draft while these checks are pending.

## Remaining limits

Row count remains unbounded. Metadata for all sent rows is still returned, and
active/unresolved draft bodies and attachments remain complete. This narrowly
removes historical sent-content amplification; it does not introduce pagination,
a general summary/detail architecture, retention cleanup or local-store changes.
