# Rejected search prototypes and baseline evidence

This is historical evidence explaining the indexed design. The scan prototype
and positional-phrase FTS prototype must not be deployed. The current candidate
and complete rollout/rollback plan are in [Indexed mail search migration](indexed-mail-search-plan.md).

## Reproducible baseline

Main commit `24c0de70a9371191485210f7acd4ce8bc7ab54d8` matches the complete
query as one literal substring over sender name/address, subject and preview.
It never matches stored body text. The invented Blue Harbor confirmation fixture
has unrelated subject/preview text and confirmation words after 100 preparation
sentences. Nine of the initial fifteen regression tests fail against main:
body-only, cross-field/reordered terms, quoted phrases, literal body markers,
scoped results and multi-page search. Existing single-field examples already pass.

No real email or private user content is included in fixtures or evidence.

## Rejected synchronous body scan

Extending the SQL LIKE predicate to bodies made the examples pass, but blocked the
API event loop. In 20k-message warm-cache fixtures with roughly 8 KiB text bodies,
the 16-term end-of-body case reached 3.63 seconds. With 1% 300 KiB body outliers,
ordinary ASCII end terms took approximately 0.80/1.59/2.85 seconds for 4/8/16 terms.
The corresponding one-character Unicode stress fixture reached 5.44 seconds.
These are local synthetic results, not production latency estimates.

See [full measured workload data](mail-search/rejected-scan-cost.json). This is
not a speedup benchmark: newly supported queries return different results, and
later admission errors are not counted as successful zero-match searches.

## Rejected positional FTS matching

A position-bearing trigram index improved ordinary searches but did not bound
pathological phrase evaluation. Independent review measured an accepted 200-letter
repeated-character phrase against only 100 synthetic 8 KiB bodies: approximately
886 ms for the count and the same delay to a scheduled timer.

The final candidate therefore uses positionless single-trigram anchors, explicit
candidate/comparison-work admission, one exact verification pass, and isolated
read-only execution. Broad queries return a typed refinement error without partial
counts. The plan documents its limits and operational tradeoffs.

## Remaining product scope

- Global web search uses stored mail; inline “Search the stream” still filters
  loaded metadata rows and can lose older matching replies through grouping
- iOS retains its selected account and mailbox/destination
- HTML-only bodies, attachments, unsynced provider history and fuzzy matching remain
  outside this slice
- Views still require explicit handling of unsupported general-text predicates

Recommended next UI slice: an explicit “Search all stored mail” action from the
stream filter, preserving its entered words without silently broadening a scope.
