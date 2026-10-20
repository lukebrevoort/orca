# Independent review evidence

Reviewer: /root/measurement_review, inherited model; no model-diversity claim.

Base e9f928258479aa7b46f7489c6e3e100c254a064f; reviewed product/test candidate a909fa009bf10dac2dbe6e528b7bd0768b87404c. Approval carries to f5569abc45fa9a47bd1c94e81025703595d7b7d5: inspected intervening diff; its only change annotates benchmark expectedProviderCalls as number, with no runtime behavior change.

The actual candidate helper was independently compared with the frozen original algorithm using parser 12.0.0. Executed result: 5,280 cases, 142 positive baseline results, zero mismatches. The corpus is 15 names × 8 opening prefixes × 11 wrappers × 4 endings. Names include image aliases, case variants, Unicode, control characters, whitespace, encoded/split names. Wrappers include comments, raw text, foreign content/integration point, template and hidden subtree. No live messages, downloads, sockets, or benchmarks were involved.

independent-equivalence.ts preserves that corpus and oracle. To make it standalone outside the checkout, its imports use a root argument and createRequire is anchored to the actual helper path rather than the original stdin script. An additional unsafePrefixMismatches counter reproduces the original alias-discovery mechanism; that extra counter has not been executed during ongoing measurements. No timing claim derives from this script.

Earlier independent investigation caught a blocking false negative in the proposed /<img/i check: <image src="https://images.example.org/banner.png"> is eligible under the baseline. Sanitizer htmlparser2 12 normalizes image to img. The final /<im/i check includes both and keeps full sanitizer/URL/dimension checks after any match. Final verdict: no blocking product/test findings; approved for draft handoff subject to performance evidence and CI completion.

Limitations: the proof depends on current parser/provider transformations; future tag-producing transforms require reconsideration. The finite corpus is not exhaustive. Input bytes are not parser-operation counts, RSS endpoints are not peak memory, and timing includes instrumentation. Existing full-suite isolated failure disposition must remain explicit. The earlier exploratory run had mixed parser resolution and must not serve as a speedup comparison to fresh parser-12 measurements.

## Final carry-forward and accepted measurement audit

Reviewed a2c7940b987df63d944d2218d5fcb7333b9dadac against f5569abc45fa9a47bd1c94e81025703595d7b7d5: only deterministic fallback-lane fixture seeding changed. Product/test approval carries forward. The first four-process set was rejected for cross-process response equivalence because random fixture destination IDs changed response hashes; do not silently mix it with accepted data.

Independent arithmetic audit of accepted/{1-baseline,2-candidate,3-candidate,4-baseline}.json and summary.json passed. All 336 samples have expected immutable revisions/roles, common harness/lock/runtime/parser metadata, correct helper calls/input bytes and provider sanitizer calls/input bytes. Each of seven workloads has one identical full response hash across all four runs. Recomputed every reported timing/count metric median and range and cross-process paired wall-ratio median.

Pooled wall-median deltas (candidate versus baseline): null-250 -13.22%; 4KiB-250-noimg -49.27%; 100KiB-1-noimg -28.39%; 100KiB-50-noimg -46.80%; 100KiB-50-tailimg +5.12%; 1MiB-1-noimg -44.88%; 1MiB-10-tailimg +9.52%. Representative image-free workload: 713.009848→379.336786ms and provider sanitizations 50→0. Positive-tail provider calls remain unchanged and both execution-order paired ratio medians exceed 1. Report these observed regressions explicitly; A/A variation does not establish that they are harmless noise.

Separate-process sample-index pairing is bookkeeping, not simultaneous matched environmental trials; there are only two independent process replicates per role, fixed workload ordering, process-history/GC/allocator effects, and instrumentation. A bounded diagnostic can investigate mechanisms but cannot erase accepted route-level regressions. This is workload-specific synthetic evidence, not a universal speedup or production capacity estimate. Reviewer launched no additional timing workloads during this audit.
