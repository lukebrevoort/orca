# BRE-444 retained benchmark repair

The foundation review found the retained candidate harness still spied on `sanitizeProviderHtml`, although image scans now call `sanitizeImageSourceHtml`. An actual clean run at `0182327c5fa36b8d686ed72130d8133ee9b3a1a2` first exposed an earlier admission failure: legacy thread detail rejects 250-message/10 MiB workloads with HTTP 413. [Retained failure](red-admission.log).

The test-only checkpoint `5797d2e3b4a4391936b190d194edb56550b9a999` preserves all seven original message/byte workloads while partitioning requests within the existing 100-message/8 MiB detail budget. This endpoint exercises image eligibility; the reading-pagination endpoint does not, so it would not measure the intended work. The same partitioning is used on both revisions. No product budget or sanitizer changed. The actual rerun reached `100KiB-50-tailimg` and failed **0 versus 50 sanitizer calls**, [retained here](red-sanitizer.log).

At executable checkpoint `ed8493b5ab3e7ec74128852fe68c48fb53cafa72`, instrumentation selects `sanitizeImageSourceHtml` when exported and the original `sanitizeProviderHtml` on older revisions. The selected name is recorded. Both the candidate and genuine historical baseline `e9f928258479aa7b46f7489c6e3e100c254a064f` passed: **7 workloads, 84 measured repeats, 14 warmups, 4 authorization controls, zero downloads per revision**. Candidate no-image workloads each record zero sanitizer calls; the 50/10-image workloads record exactly 50/10. The baseline records every message, including 250/250/1/50/50/1/10. Every response remains checked for status, message count, account, expected eligibility, inert HTML and stable response hash within its revision; database page count stays unchanged. The harness bytes and workload payloads match across revisions. [Counts, identities and artifact hashes](observed-results.json).

This is harness correctness/replay evidence, **not a speedup claim**. The new bounded-request partition differs from original historical timing artifacts. Current and old product/lock/response shapes also differ; do not compare their response hashes or timings as a controlled performance study. A/B are same-code repeats, not two implementations. Synthetic loopback-free in-process HTTP requests use fresh owned SQLite; no provider, live mail or remote image request.

## Reproduce the actual demo

Use Bun 1.3.14, locked parser 12.0.0 for both helper/sanitizer, frozen compatible dependencies and a clean source/index at the chosen exact commit. Run the candidate from the repository root with an unused output path:

```sh
IMAGE_BENCH_SHA=$(git rev-parse HEAD) IMAGE_BENCH_ROLE=candidate python3 /tmp/orca-ui-heavy-slot.py /opt/homebrew/bin/bun apps/api/benchmarks/image-eligibility.ts /tmp/unique-candidate-results.json
```

For baseline replay, save this candidate harness outside the repository, switch an owned checkout to `e9f928258479aa7b46f7489c6e3e100c254a064f`, and copy the harness into the same **untracked** path. Do not modify tracked baseline source. Set `IMAGE_BENCH_SHA=e9f928258479aa7b46f7489c6e3e100c254a064f` and `IMAGE_BENCH_ROLE=baseline`, using a separate new output path. The harness rejects wrong HEAD or tracked/index changes. Remove only the copied untracked harness before restoring the checkout. Actual replay used root's own checkout sequentially; no child checkout, live credentials or user processes.

Resource serialization uses the task-owned wrapper; exit75 means no run started. These successful runs used one nice-priority Bun process at a time, around one CPU core, approximately 1.1–1.3 GB sampled peak RSS, with 75–77% memory free. Samples are approximate, not a hard memory/thermal limit. Full relevant checks and independent/current hosted gates are recorded on PR309; these checkpoint receipts do not certify a later head. Rollback these benchmark-only commits; product/data are unaffected.
