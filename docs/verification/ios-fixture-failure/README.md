# iOS failure diagnostics evidence

## October 20 integration

The diagnostic implementation and its regression tests are already on main via commit `743d8ffbec4e87ce39d9aeefcb6acd7c04ec23d9`, which reused the exact PR #253 files. Main also contains assertion prioritization from `ee0ee866d14d199d0d6986e5c1f8a05649cf55cb` and newer fixture telemetry. The #262 exporter changes are therefore already present in main as well; its native changes remain separate.

Refreshed against main `6fa05f9cd6891a58a986fc922ebc4d94b3ac5efe`, this PR adds only the seven historical task/evidence files. Every pre-existing main blob is preserved; no exporter, test, workflow or application code is replaced. The original logs are unchanged. The sections below describe the October 16 checkpoint, not fresh execution or a fix for the unidentified original UI failure.

Current review/check status is maintained in [PR #253](https://github.com/lukebrevoort/orca/pull/253). #263 merged before this refresh; #253 remains held for parent sequencing. The cloud executor is unavailable during this refresh; repository comparison and integration use GitHub's supported APIs. No local test execution is claimed.

## Historical October 16 checkpoint

Original failure: main `5baf7f3ea9e208001c607a7bc0f5c418fb056d58`, [native job117026371921](https://github.com/lukebrevoort/orca/actions/runs/38916549300/job/117026371921). Light UI16 tests/1 failure, exit65. Test36 passed; failed assertion omitted by final80-line console tail. Dark mode did not execute after the failure. [Original artifact](https://github.com/lukebrevoort/orca/actions/runs/38916549300/artifacts/12054980076) download returns403 here; annotations endpoint unsupported. No access workaround attempted.

This checkpoint repairs missing diagnostics, not an unproven native behavior issue. Failure context is selected from the complete sanitized log, capped at20 marker groups with one neighboring line on each side and1000 characters per line. It prints only after successful credential scanning, retains exit65 and the complete artifact, and neutralizes workflow-command delimiters in emitted text. UI assertions, selections and timeouts are unchanged.

- `red.log`: new regressions against the original exporter, one assertion failure plus missing-helper error, exit1. Early failure was invisible.
- `export-tests.log`, `runner-tests.log`: initial development passes.
- `final-export-tests.log`, `final-runner-tests.log`: exact executable `88b2c0a9d22e9806cd409577fe4b948d97a254d1`, eight exporter + eight lifecycle tests pass. Covers early assertion visibility, credential redaction, bounded output, success silence, fail-closed export and workflow-command neutralization.
- Independent reviewer `/root/pilot_review` approved that immutable executable against main, independently16 tests pass. Initial review identified legacy GitHub workflow-command interpretation; neutralization was added and independently re-reviewed. Separate agent; model diversity not claimed.

Final publication includes only documentation/evidence after the executable revision. Hosted iOS and other automatic results will be recorded in the draft PR without documentation-only CI churn. A green diagnostic run alone cannot establish the original failure's cause or a native fix. No local Xcode execution, live mail, merge or release.
