# Independent review follow-ups

Correctness and security reviewers `/root/review_importance_correctness` and `/root/review_importance_security` (GPT-6.1-sol) reviewed exact base `0182327c5fa36b8d686ed72130d8133ee9b3a1a2` to `2ebee41d73e3601610ef00dd39e5b81a60f486e2`. Both approved source subject to final CI/integration gates, with the following follow-ups. Client and notification acceptance remain unverified.

## Fixture source identity

The coordinator reproduced the security review's provenance issue by invoking the actual fixture from `/tmp`: all eight API/DB assertions passed, but its receipt had an empty commit and `dirty:false`. Evidence is retained at `/tmp/bre454-root-provenance-red-2ebee/` and the adjacent log. This does not invalidate the earlier receipts that were independently checked at the correct commit.

Fix commit `3d66783a102236c8052576b4c4998699262a80be` anchors Git to the script's repository root, requires successful Git commands and a full SHA, includes untracked source in the dirty flag, and checks identity before creating output or scratch data. Three direct CLI probes passed: clean invocation from `/tmp` recorded the exact commit and eight true API assertions; an owned untracked source marker correctly set `dirty:true` with the same eight assertions; unavailable Git failed before output creation. Both successful fixtures made zero provider calls. The marker and owned fixture databases were cleaned. Receipts: `/tmp/bre454-root-provenance-checks-3d66783a.json` and matching logs.

The two original raw baseline logs retain their bytes and hashes. `.gitattributes` exempts only those exact captured-output paths from whitespace diagnostics; application/source checks are unaffected.

## Long-conversation write work — BRE-461

The correctness review identified whole-conversation participant rebuilds during message/label writes. The coordinator executed its small paired probe on identical in-memory initial inserts, using SQLite 3.53.4. The implementation worktree was verified clean at `2ebee41d`, with all earlier migration files unchanged from the recorded baseline.

| Single-thread messages | Foundation `0182327c` through migration 0051 | Importance `2ebee41d` through 0052 |
| --- | ---: | ---: |
| 100 | 25,021 | 352,104 |
| 200 | 50,021 | 1,264,004 |

Values are actual SQLite progress callbacks at interval one. Doubling messages grows candidate work 3.59 times versus roughly twice for the baseline. These are work counts, not latency, CPU timings or a speedup claim. The probe covers initial inserts, not the complete Gmail label-refresh pipeline. Raw results and resource log are `/tmp/bre454-root-writework-2ebee41d.json` and its adjacent log; retained probe is `/tmp/bre454-review-writework.py`.

[BRE-461](https://linear.app/brevoort/issue/BRE-461) owns optimization, immutable-source replay and paired representative sync measurements before final merge. Preserve current contracts, trigger transitions, revisions/tombstones, source ownership, data retention and all existing functional cases. The final candidate must receive fresh full checks and independent review; source approval of `2ebee41d` is not approval of a later implementation.
