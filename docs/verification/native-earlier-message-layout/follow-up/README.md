# Follow-up: native CI failure reproduction

Executable revision: `ee0ee866d14d199d0d6986e5c1f8a05649cf55cb`. Prior PR head: `3918aa01b770a79ece3e1511d2538bd0a9ee6c66`. Immutable baseline: `0a9ecd6f9db027ce0cf6ede004311b2567e197fe`. Any following evidence-only commit does not change executable sources. Hosted verification of the final published head is recorded on PR260.

## Results and supported correction

| Revision | Focused light run | Result |
| --- | --- | --- |
| Prior head | Image consent/reset | Passed; initial counter callback118ms after resume |
| Baseline | Image consent/reset | Passed; initial counter callback404ms after resume |
| Prior head | Search/reply persistence/send | Jordan query200 with expected IDs2,5; failed later at clearSearch tapping disabled empty Search key |
| Baseline | Search/reply persistence/send | Same later clearSearch failure; Jordan query200 with expected IDs2,5 |
| Final executable | Search/reply persistence/send, light and dark | Both passed, one selected test per theme |
| Final executable | Image consent/reset/late response, light and dark | Both passed, one selected test per theme |

The local failures at original OrcaUITests.swift:1344 are a pre-existing harness defect. Clearing the field triggers InboxView's empty-query reload; the keyboard Search key becomes disabled. The correction removes that invalid tap, adds a cleared-field check, and retains the original restored-inbox assertion. It does not alter product search behavior, wait durations, retries, or delivery assertions. The full final compose flows include one expected synthetic send apiece; no live mail was used.

## Original hosted failures remain distinct

The earlier hosted images job failed before app launch because its initial counter reached the server15.283 seconds after resume. That delay did not reproduce locally; its underlying cause is not claimed fixed. The original hosted compose job failed earlier, waiting for the Jordan result at line907. Local baseline and head both showed those results. The later clearSearch correction does not establish the cause of the original missing-result assertion.

The new diagnostics assert/log the actual submitted synthetic query, preserve a missing-result screenshot and bounded UI hierarchy, and correlate synthetic Inbox/destination request receipt with status/result IDs. Fixture receipt timestamps measure entry into that diagnostic branch after earlier fixture gates, not initial network arrival. They do not log authorization headers, connection metadata, or response bodies.

The failure excerpt now prioritizes source assertions/test failures over passing `0 failures` summaries and runtime noise. A synthetic regression failed before this change; all13 exporter tests pass afterward. Applied to the retained original hosted full compose log, the new excerpt includes line907. Full sanitized logs remain preserved. API typecheck passed. Independent immutable review found no blockers; see review.md.

## Evidence and limits

Each directory contains sanitized full checks/fixture logs, XCTest summaries/test trees, and source identity. Proxy runs additionally contain timestamped synthetic queries/status/result IDs. `submitted-jordan.png` shows the actual query and rows; `clear-search-failure-ax.txt` contains selected failure-time hierarchy lines. Final runs use direct fixture transport. Baseline/prior-head Jordan runs used an external loopback proxy that buffers responses, so their latency is not a direct-transport benchmark.

Build provenance records app and UI-test products; later runs verify97 hashes including xctestrun plus its executable paths before launch. The first prior-head image run preceded that preflight improvement; its build was successful and no concurrent build occurred, but it has no pre-run hash gate. Its evidence export was subsequently rerun and explicitly verified. Final four runs include the full gate. Post-test home-screen captures are not represented as failure-time UI evidence.

All local runs used unlocked Homebase, one iPhone17 simulator, Xcode26.4.1, iOS26.4.1, and one build/test lane. These focused runs do not prove a full-suite, physical-device, cold-host, or hosted-CI pass. No timeout increases, live credentials, production changes, merges, releases, duplicate workflow dispatches, or PR262 artifact-transfer retries. PR262's supported job log still lacks its actual assertion; no claim that its failure is the same.

Reproduction uses the existing `test01InboxSearchReplyDraftSurvivesReopenAndSendsOnceInLightMode` and `testImagesRequireExplicitLoadingAndResetOnReopen` tests through xcodebuild test-without-building against a fresh mobile-fixture.ts instance; only one selected test and simulator runs at once. Exact command lines are in the sanitized checks.txt files. Ephemeral injected xctestrun files and fixture processes are cleaned; raw xcresult bundles stay private.
