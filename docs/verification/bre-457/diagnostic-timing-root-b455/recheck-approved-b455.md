# Native diagnostic timing correction — fresh independent recheck

**Verdict: APPROVED for this narrow source/evidence correction.** The three diagnostic-timing blockers from the d485 review are closed. This is not SwiftUI/XCTest runtime acceptance, a product-fix claim, or permission to merge.

Reviewer: independent `/root/recheck_native_diagnostic_timing_b455`, Codex reviewer. Immutable comparison: `d485fae8138ce0ecdb49f5508c6ab360be7487c2` → `b455ae183ae7073b3e2ceb1f63bf490ff0f2cfda`. Read exact Git objects, the earlier diagnostic review, changed and relevant surrounding callers, fixture gating, corrected documentation and the supplied grammar manifest. No tests, compilation, browser, simulator, server, child agents, source edits, pushes or external posts were performed. Only this requested report was written.

## Act on

None in the reviewed correction.

## Closed findings

1. **History wait ordering — closed.** `apps/ios/OrcaUITests/OrcaUITests.swift:1972–1983` now performs the unchanged Show21 tap followed immediately by the original five-second unread-jump predicate. Its Boolean is stored before the new Show/Hide observations and expensive capture. The assertion uses that stored result, and the observed fields are honestly named `show_after_original_wait`/`hide_after_original_wait`. Later diagnostic work cannot rescue a failed original predicate.

2. **Tap-to-type focus boundary — closed.** `OrcaUITests.swift:1312–1320,1343–1344` registers one failure-only teardown capture before the tap and returns immediately after the original tap. The previous public-focus, keyboard, structural snapshot and PNG operations between `tap()` and the caller's original `typeText()` are gone. Registration is per-test/reset in setup and gated to the configured loopback fixture. Its closure checks the current test run's positive `totalFailureCount`, so it observes an already-failed test rather than providing a new focus-settling interval before the typing check. It does not retry typing, assign focus, dismiss anything, reset counters or suppress the original issue.

3. **Removal-to-form boundary — closed.** `OrcaUITests.swift:849–853` now captures/asserts the original removal result and proceeds directly to the existing reveal helper. The full post-removal capture was removed. `:1283–1285` retains the original ten-second form wait, captures its Boolean first, and performs failure diagnostics only after that result is false. The original missing-form check cannot become a pass because of evidence work inserted before it.

## Security and evidence assessment

- Existing bounded diagnostic helpers remain read-only and HTTP-loopback gated. They emit fixed aliases, numeric geometry/types/counts, booleans and allowlisted state values, without arbitrary mail labels/values/identifiers, addresses, URLs or credentials. The timing correction introduces no production authorization or privacy boundary change.
- The previously correct wide-toggle handling is unchanged: the first immediate value after the same tap is stored before diagnostic work and remains the value asserted. No corrective gesture, longer wait, second tap or replacement business assertion was added.
- Verified all **36** source hashes in `/tmp/bre457-root-timing-grammar-b455ae18/manifest.json` against the exact b455 Git objects. Before/after hash maps match; the manifest reports equal clean start/end b455 identities, exit0 and 0.517s. This is retained grammar evidence only; this reviewer did not execute it and it does not establish native typechecking/runtime.
- Independently checked that app product/Core, `OrcaTests`, Tools/harness, runner, API and shared paths are unchanged across d485→b455. The prior223-case controller/API and four-scope runner receipts retain their original scopes; no new repetition or UI pass is inferred.
- Documentation now accurately describes the reordered observations and the Orca251 sent-local-edits context correction. It labels the original d485 source/grammar records historical rather than relabeling them as the corrected source.

## Remaining limits

Pre-tap numeric geometry and snapshots still add observation overhead; the diagnostics are not a paired timing experiment or proof that an instrumented passing run fixes a product issue. Failure teardown itself has not executed in hosted XCTest yet; the source guard is appropriate, but artifact availability and actual runtime behavior remain to be observed. Named PNG-to-exported-ordinal mapping and raw xcresult remain unavailable. Current native reader/compose failures, actual new UI journeys, both-theme hosted execution and final application acceptance remain open.

**APPROVED — narrow timing-fidelity blockers closed; hosted UI evidence still pending.**
