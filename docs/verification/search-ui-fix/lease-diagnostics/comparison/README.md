# PR261 API lease timeout follow-up
Baseline: 0a9ecd6f9db027ce0cf6ede004311b2567e197fe
Head: 9172959a38929f2c55fa3508784ac29672857b38
Hosted PR merge: 450703d24dea3e37eb228538ecba6c9c3e3a8383
Hosted failing job: https://github.com/lukebrevoort/orca/actions/runs/39287652704/job/118179373790

No API/shared/dependency declaration/lockfile changes between base and head. Unchanged Bun 1.3.14 and shared installed dependency tree (baseline node_modules symlink to head; shared source is identical). Synthetic tests only. Environment cleared to PATH and temporary HOME; --no-env-file. Each run uses a fresh process. No hosted reruns.

Bounded workload: base/head/head/base isolated exact test (20 second process bound, default 5000ms test timeout); base then head API import-inclusive exact-name filter (30 second process bound); base then head complete API suite (180 second process bound). Exact filter: releases an admitted MCP lease. Commands: bun --no-env-file test [apps/api/src/agents/g2-request-guards.test.ts] --test-name-pattern 'releases an admitted MCP lease'; full suite bun --no-env-file test from apps/api.

All isolated and import-inclusive runs passed. Full API baseline 779 passed, 0 failed, 3044 assertions, 79.022s process wall; head 779 passed, 0 failed, 3044 assertions, 77.958s process wall. Target test full-suite durations 29.23ms baseline / 29.20ms head. These are non-reproduction observations, not benchmark or speedup claims.

Independent reviewer /root/evidence_review found no source evidence linking the timeout to this UI patch. Four unbounded awaits prevent hosted failure attribution: deferred tool entry, MessageChannel event, second exchange, first exchange in finally. An early response before tool entry can leave entry pending; cleanup awaiting a stalled first exchange can mask an earlier assertion. SDK registers abort before dispatch; request signal is forwarded; lease release is in finally. Current data cannot distinguish hosted runtime/scheduling from transient test context. No deterministic defect reproduced. No security change, timeout increase, assertion weakening or speculative reliability fix justified. A future stage-specific diagnostic patch could identify failing stage, but would not be a demonstrated fix and requires a separately chosen follow-up.
