# ROOT Discard runner-selection follow-up

Source review e061→f153 found one verification-wiring blocker: test53 existed but was not selected in either compose phase. No product defect or UI pass was inferred. Security/source review approved f153; correctness requested this selector correction.

ROOT added a fourth compose scope to the real production-runner/mock-Apple lifecycle model. At clean40cba1d6 the new guard reports compose FAIL while the original all/notifications/mailbox scopes PASS; actual test exit1. After ROOT added ONLY test53 to both existing compose arrays, clean1748efb952763968ff8fe121d82911e29486764a passes all four scopes and zsh syntax. The guard checks both real theme invocations select test53; compose has no adoption phase. All prior selector tokens are preserved byte-for-byte.

The test runner model uses synthetic Apple commands, not Xcode/XCTest/SwiftUI. Test53 confirmation/cancel/delete still awaits actual hosted execution. No timeout, production UI, test-body or failure assertion changed. AppCore/API/shared/OrcaTests and UI test-case trees remain identical to the actual223-case-tested f153 source; 223 cases were not redundantly rerun. The lifecycle harness hash is intentionally new. Native runtime6compose/2reader failures remain open.

Red elapsed6.11s; green3.19s, each through one shared guard wrapper with owned cleanup; no performance claim. Resource ledger entries root owner84012/84597 are retained externally at /tmp/orca-ui-heavy-resources.jsonl. Heavy slot explicitly released after terminal0; no Apple run or push occurred. Final narrow independent source recheck remains pending.
