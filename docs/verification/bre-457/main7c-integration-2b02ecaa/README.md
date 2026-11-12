# Normal main7c integration: unchanged execution inputs

ROOT normally merged exact published main `7c97193688599e5996bb657c34227a63927c384c` into this client at `2b02ecaaa82c510f8328fd76afc53f53e8b8e326`, parents `0a4293772c8aebba05b980df74a6e7bc88c5c417` and main7c. The merge was conflict-free and clean. Published API320cef8 and main7c are now actual ancestors, alongside the previously integrated API320bfd. This closes the prior integration gap; it does not establish deployment or whole-client acceptance.

[ROOT's exact identity receipt](root-integration-identity.json) is retained byte-for-byte, SHA256 `7cab904fe49b96cb007e77dfe3d57dd23a2264482918f1eaa2fa5b53a75d6612`. The retention worker independently checked parents, ancestry, all29 changed paths and all10 execution-source tree/blob scopes. The only merge changes are API query verification docs under `docs/verification/bre-457-pin-query/`. iOS, API, web, packages, scripts, GitHub/agent configuration, root package, lock and TypeScript configuration scopes are identical before/after. No product/test/runner/script bytes changed.

| Existing proof | Exact execution head | Current identity check / limit |
| --- | --- | --- |
| Foundation/API423/423, all seven stages green | `f0e38725b0b18f82bb9a71d397cfa235473cbc77` | All28 Foundation source and five harness inputs still identical. The broader69-input map differs only for the two known test files below. No runtime repeat. |
|44 Swift grammar, exit0 | `b795d3e57e30dc211dc816e18a2ffe452982b19f` | All44 current input hashes match. Syntax only; no SwiftUI/XCTest typecheck or execution claim. |
| Main integration | `2b02ecaaa82c510f8328fd76afc53f53e8b8e326` | All10 execution scopes unchanged from0a;29 evidence-doc changes only. No new heavy gate justified or executed. |

The known differences from f0e are `OrcaTests.swift` (e76's two mock cleanup-defer moves) and `OrcaUITests.swift` (b795's unique-video predicate). Current b795 grammar covers both. They are not promoted to423-case execution or hosted XCTest proof. [Machine-readable proof map](verified-proof-map.json) binds these separate scopes.

All historical failure counts, exact event/head distinctions, reviews and limits in [picker retention](../compose-picker-b795d3e5/README.md), [f0e corrections](../current-corrections-e76b2a03/README.md) and [earlier native evidence](../navigation-root-0f9e630f/README.md) remain. Main compose/units did not start in the actual41a compose run after the picker prelude failed. Current41a's other natural hosted outcomes and ROOT's source/runtime/screenshots/all33/formal merge gates remain pending. No new CI query, API/provider test, Apple job, publication, deployment or release is claimed. Publication remains on HOLD until explicit ROOT clearance.
