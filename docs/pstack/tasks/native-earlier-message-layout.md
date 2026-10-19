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
