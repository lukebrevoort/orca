# Native current-corrections independent review

Reviewer: `/root/review_native_current_corrections_f0e3`, Codex gpt-6.1-sol. Read-only source/evidence review; no tests, builds, simulator, CI, network, or source mutations performed.

Exact comparison: `41a0998b14428f62280027f504678b1c243e5a77` → `f0e38725b0b18f82bb9a71d397cfa235473cbc77` (seven files). Reviewed the full diff, production projection/groups/caller and verified-context guards, changed unit/UI tests, expected-ID inventory, gate count change, and the retained baseline/candidate manifests.

## Verdict

**APPROVED WITH COMMENTS for this scoped source correction.** No blocking correctness or security finding. This does not approve merging or establish hosted XCTest/SwiftUI interaction acceptance.

## Act on

None blocking.

## Consider

- **Install mock cleanup before the throwing connection helper.** `apps/ios/OrcaTests/OrcaTests.swift:659` and `:748` call `try await verifyCatalogTestConnection(state)` before their `defer { StubURLProtocol.handler = nil }` is registered (`:668`, `:756`). If auth/account decoding or the helper's `XCTUnwrap` fails, the process-global handler remains installed and can contaminate subsequent tests. Move the cleanup defer before the helper call (or register it within the helper and replace it deliberately afterward). This is failure-path test isolation, not a production authorization defect, and does not invalidate the inspected successful Foundation gate.

## Noted / supported

- `NativeMailboxProjection.swift:43–47` restores only the legacy `view:` fallback when its visible option disappears. `MailboxViews.swift:115` calls it only after the existing post-await `current()` guards. It does not rewrite pins, collections, preferences, or hidden/unavailable history; the helper is exercised by four exact controls using the real group projection. Existing selected Views remain selected. The helper intentionally also treats a hidden legacy View as absent from visible options, matching the existing `ensureSelection()` contract.
- `MailboxViews.load` retains its origin/verified-owner/account/connection/client/generation/cancellation guards. No new network authority, credential path, provider call, cache key, write protocol, or public wire contract was added.
- `OrcaTests.swift:636–648` establishes the actual production verified connection through synthetic auth/account responses. The two tests keep their original removal/history and late-identity assertions and three-second start bound. The catalog mock now responds only to its real route; optional catalogs receive explicit 503s. Unique caches and restored standard-default keys avoid persistent account-cache/selection leakage on ordinary completion.
- `ReaderUITests.swift:641–645` selects the pre-existing fixed Inbox identifier emitted by `NativeMailboxPicker.swift:27`, requires one match and the truthful Inbox label, and retains the original five-second existence wait/single tap/twenty-second navigation wait. It does not remove or rename the actual named Inbox Space, use firstMatch, force coordinates, or weaken reader/image assertions.
- The inventory contains exactly 423 entries and 423 unique IDs, including all four new policy controls. The retained descriptive `newCount:139` is unchanged historical metadata; the exact expected-case list and total gate, rather than that field, support execution coverage.
- Inspected `/tmp/bre457-view-removal-policy-red-8afaf06a/manifest.json`: exact clean 8af start/end, 423 completed / 422 pass / one intended removed-View fallback fail, coverage matched, grammar 0; remaining five stages not started. This is an honest narrow policy red.
- Inspected `/tmp/bre457-view-removal-candidate-f0e38725/manifest.json`: exact f0e start/end, identity unchanged, 423 completed / 423 pass, coverage matched, no missing/unexpected IDs; all seven stages exit 0 without timeout, owned API cleanup receipt present, no not-started stages. This supports the Foundation/API/grammar/types/witness/runner/project scope stated by the manifest. I did not execute or independently instrument those stages.

## Dismissed / limits

- Passing grammar/Foundation controls do not demonstrate that the corrected UIKit selector now reaches reader/image behavior on hosted iPhone, nor that the two changed XCTest cases compile/run there. Fresh hosted evidence remains required.
- No claim about current whole-app/all33 completion, native hit areas, focus/scroll, screenshots, OS delivery, TestFlight, or production behavior follows from this review.
