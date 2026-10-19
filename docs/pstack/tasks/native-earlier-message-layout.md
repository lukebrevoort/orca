# Native earlier-message accessibility layout

- Status: **running** — local verification and independent review complete; awaiting automatic hosted checks on draft publication.
- Base:0a9ecd6f9db027ce0cf6ede004311b2567e197fe. Branch:fix/native-earlier-message-layout.
- Final executable:e83278dc7af26114fce3260808187948cacc999c. Subsequent changes are documentation/evidence only.
- Owner:Homebase/root. Independent reviewer:/root/native_layout_review; no blocking findings, source/pixel review only.
- Acceptance: readable label at Accessibility XXXL, preserved44pt hit target and toggle semantics, ordinary text and both themes verified.
- Scope:ThreadView label and ReaderUITests regression. No web/API, CI repair, release or production changes.
- Negative control: final test fails against original reader44pt>63.6pt. Final head passes1 light and3 dark tests. Six earlier light tests pass identical product code before test relocation.
- Synthetic privacy: fresh loopback fixture, one expected mocked delivery in conflict-recovery test, no provider sends. Canvas authenticated tabs preserved.
- Known unresolved:first Jump to latest body alignment. New separate finding:Inbox view picker clips at largest type.
- [Full evidence, provenance, screenshots, review and limits](../../verification/native-earlier-message-layout/README.md).
- Hosted checks: follow existing automatic final-head runs; no redundant dispatch. PR check record is authoritative for terminal results.
- No merge or release authorized. Original worktrees/private demo data preserved; temporary baseline negative control restored to final commit.

## Follow-up CI reproduction

Status: running. Original PR head 3918aa01b770a79ece3e1511d2538bd0a9ee6c66 and baseline 0a9ecd6f9db027ce0cf6ede004311b2567e197fe were rebuilt and exercised sequentially on unlocked Homebase. Direct image tests passed on both; the hosted pre-launch delay did not reproduce. Jordan requests returned HTTP 200 with fixture IDs 2 and 5 on both; both then failed in clearSearch tapping the disabled Search key for an empty field. This later failure is distinct from the hosted missing-result assertion.

Narrow follow-up: remove that invalid tap while retaining the restored-inbox assertion; record submitted field value and missing-result screenshot/bounded UI hierarchy; emit correlated synthetic search response metadata; prioritize actual assertions over passing summaries in failure excerpts. Full sanitized logs, existing assertions and wait durations remain. Existing PR262 artifact-transfer restriction is respected; supported job logs still omit its actual assertion. No claim that its failure is the same.

Local raw results and sanitized evidence: homebase-private/pr260-repro and homebase-evidence/pr260-repro (outside repository). Independent review and final-revision UI checks pending.

Final local executable ee0ee866d14d199d0d6986e5c1f8a05649cf55cb: four focused direct-transport native checks passed (Jordan/compose and images in each theme); API typecheck and13 exporter tests passed. Independent immutable review found no blockers. Sanitized raw logs, source/build identity and screenshots are under docs/verification/native-earlier-message-layout/follow-up. Status remains running pending final automatic CI; no original hosted failure is claimed resolved by local passes alone.
