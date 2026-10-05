# Empty attention page scans

## Scope and correctness

The six-line reader change skips an attention group's per-account page queries only when the existing aggregate proves the group empty. Aggregate and page queries use the same authorization union, mailbox filters, effective-attention joins, Inbox visibility policy and SQLite transaction snapshot. Classification and cursor predicates can only narrow that set. Notify and focus deliberately share `focus_count`; a nonzero combined count never proves either individual group empty.

No schema, migration, authorization, response, cache or cursor contract changes are involved. Only page-query work changes. Counts, account metadata, enrichment and freshness are still produced normally. Scope and cursor validation still run before pruning.

## Deterministic comparison

Measured on 2026-10-05 using Bun 1.3.14 against published main `32a209637ef4d11ba927bc6b96af8ce820a13f4d`. These are synthetic databases with 5,000 and 20,000 total messages, evenly divided between two accounts, repeated timestamps and mixed classifications. No real mailbox data or credentials are used.

At **both** sizes, first-page per-account SQL page-query counts were:

| Scenario | Published base | Optimized |
| --- | ---: | ---: |
| Normal-only default mailbox | 6 | 2 |
| Empty Focus view | 4 | 0 |
| Empty All Mail text search | 10 | 0 |
| Empty sender filter | 10 | 0 |
| Empty date range | 10 | 0 |
| Empty classification in a nonempty normal group | 10 | 2 |

The comparison covers 38 dataset/scenario combinations and 94 page responses, checking up to three pages per nonempty scenario. All complete response objects are deeply equal, including account metadata, counts, message enrichment, freshness and exact next-cursor bytes. Projected row counts are equal. Across those sampled pages, page-query count falls from 328 to 176; nonempty mixed-attention scenarios do not regress. This is deterministic database work reduction, not an elapsed-time claim or a claim that aggregate counting is eliminated. Larger fixtures are not exhaustively paginated by this benchmark; the focused regression suite exhaustively checks a smaller tied, multi-account mailbox.

### Reproduce

From the repository root with Bun 1.3.14 and frozen dependencies installed:

```sh
baseline=apps/api/src/mailbox/read.baseline.local.ts
trap 'rm -f "$baseline"' EXIT
git show 32a209637ef4d11ba927bc6b96af8ce820a13f4d:apps/api/src/mailbox/read.ts > "$baseline"
MAILBOX_BASELINE_MODULE="$PWD/$baseline" bun apps/api/benchmarks/empty-attention-pages.ts
```

The benchmark asserts first-page reductions, equal complete responses, equal projected row counts and no increase in page queries, then emits JSON. The baseline module is a temporary copy of the published source, not a second implementation committed to this PR.

## Regression coverage and checks

- 17 mailbox-reader tests pass, including 12 added regression cases: zero/null aggregates, all five attention variants, effective attention precedence, a group present only in the second account, account/ID timestamp ties, later pages across empty ranks, text/sender/date/classification filters, collection and destination scopes, foreign/empty account authorization, Inbox skip policy, malformed/stale/mismatched cursors and a concurrent attention write after aggregate counting
- Full workspace tests: 1,370 pass, zero failures (shared 95, API 719, web 556)
- Full workspace typecheck, lint and production build pass
- Hosted browser/API and unsigned iOS fixture checks are required on the published PR revision; their authoritative results are the linked GitHub checks, not this local report

Rollback is a revert of the six production lines. Tests and the standalone synthetic comparison are independent of the UI/mobile performance branch.
