# Light checkpoint retention at the outer-kill boundary

This docs-only checkpoint retains ROOT's actual CI-boundary work at source `cbdcf6132c765f4e59aafcdb98c008437ba4871f`. No product, fixture, Swift, UI gesture/assertion, selection, simulator or45-minute policy changed. No worker verification or CI query occurred during retention.

## Observed hosted failure

Actual41a mailbox run43122924479/job130867673422 hit the outer45-minute limit: Light finished00:32:04, Dark started00:32:07, cap00:36:47. Uploader found no files; ROOT's actual artifact list was `[]`. **No Light pass/fail/count or Dark outcome can be established.** [Full job log](reports/bre313-41a-mailbox-job-130867673422.log) and the original [closure/identity record containing artifacts[]](reports/bre457-native-checkpoint-final-closure-cbdcf613.json) are retained; the empty list is ROOT-provided evidence, not a new worker API query.

ROOT reports all six required41a jobs terminal: Unit/browser PASS; reading/images/compose FAIL; mailbox outer timeout with no files. Existing per-phase failure counts and setup boundaries remain exact; these statuses do not establish whole-client/native acceptance.

## CI change and actual proof split

The used runner publishes a Light checkpoint before Dark using the existing full redactor/credential scan privately before public bytes. Its incomplete outcome stays `exitCode:null`, `complete:false`. Final export stages privately and publishes the final outcome last; corrupt Dark export preserves an already-published checkpoint. Fresh attachment scratch and actual-public-path diagnostics close the two optional review comments. [Exact five-file source diff](checkpoint-only.patch) changes only the mailbox workflow, runner progress hook, exporter, shell wrapper and new synthetic controls.

| Exact run | Actual evidence |
| --- | --- |
|62b940dd |1 executed synthetic outer-kill test,1 intended failure after held Dark and SIGKILL: missing completed-Light checkpoint. Runtime red, not an Apple/UI red. |
|ee513355 initial |New6/6 and existing sanitizer25/25 pass; appearance hit external10s driver cap124. Invocation NONPASS; lifecycle/shell not started. |
|ee513355 remaining, separately allocated |Only remaining appearance2/2, four lifecycle scopes, bash/zsh syntax all0. Cumulative same-source proof, not a single full green invocation. |
|fc3ba211 |Fresh private attachment scratch/strict mock:6/6 plus25/25 pass. |
|08ee0efc |Actual published-path6/6 pass. Driver template mentions25, but that invocation did not execute them;25 remains prior fc3 proof. |
|cbdcf613 |Final7/7 synthetic Python controls pass,3.507956s, exact clean source identity and owned groups empty; wrapper4393 terminal0. Includes browser/reader allowlist/nested-image/final-status compatibility. |

All six original output directories, manifests, full stage stdout, drivers, owned stage runners and wrapper logs are copied byte-for-byte under `raw/` and `drivers-and-wrappers/`. [Copied-file hashes](retained-files.json) and ROOT's full closure map preserve every NONPASS and exact source boundary.

## Review, current source identity and remaining limits

The [independent review](reports/bre457-native-checkpoint-review-ee513.md) is APPROVED WITH COMMENTS **at immutable ee513**. ROOT later closed C1 fresh-scratch and C2 published-path comments with the controls above. Final cbd is ROOT-supported closure; it is not relabeled independently reviewed. C3 remains: only kill after Dark starts is demonstrated. Killing before atomic publication can still leave no checkpoint; synchronous export consumes the unchanged45-minute budget. Neither budget fit nor actual hosted interruption/xcresult export/native UI is proved by fake-Apple controls.

Current44 grammar inputs remain exact b795;28 Foundation source plus five harness inputs remain exact f0e423/423. No423, grammar, Apple or full Bun repeat occurred. The broader f0e69-input map now differs in **three** paths: OrcaTests.swift (defer setup), OrcaUITests.swift (video query), and run-fixture-tests.sh (checkpoint hook). [Explicit source/input identity](verified-source-identity.json) distinguishes unchanged runtime/Swift input hashes from changed runner/CI evidence source. Production/API/shared source scopes remain unchanged. Main7c/API320cef8 ancestry remains integrated.

Full current native UI/screenshots, all33, OS/provider delivery, deployment and formal merge remain ROOT gates. Publication is HOLD until concrete body/source-proof readback and explicit ONE-push clearance. No timeout extension, retries, skips, raw-xcresult publication, live mail or local Apple acceptance is claimed.
