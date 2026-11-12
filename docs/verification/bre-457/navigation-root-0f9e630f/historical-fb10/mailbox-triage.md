# BRE-457 current fb10 mailbox artifact: read-only triage

## Provenance and executed scope

Artifact 13890686259, ZIP `/tmp/bre457-mailbox-fb10.zip`, SHA256 independently checked: `483cdb22bb646ed540667ab36f8d7bb62f0f454ba8af7c204200069779c58ff3`. Extracted `/tmp/bre457-hosted-mailbox-fb10` contains 107 files. `identity.log` says tested/head `fb10f5c89f4c5147de3a7e7b9a375c4ad1f9951f`, event `56a2b65594ca10d6a07cce82e9ddee2665af93ed`; event/head tree equivalence was NOT asserted. Hosted ARM64 macOS26/Xcode26.4.1 (17E202), iPhone17 iOS26.4.1, Bun1.3.14/Node24.22.2. `outcome.json`: exit65, syntheticOnly true, rawXcresultUploaded false.

Actual summaries: Adoptionlight 1 passed/0 failed/0 skipped; Adoptiondark 1/0/0. Main Light 185 passed/11 failed/0 skipped, total196 **including unit tests**. Main Dark 2 passed/13 failed/0 skipped, total15. All summary failure entries and ordered checks were read. This is new executed mailbox failure evidence, distinct from e061's previous 45-minute timeout with no artifact.

Eight relevant source files were extracted by `git show fb10:<path>` to `/tmp/bre457-mailbox-fb10-source`; line numbers below refer to this exact tested source. Current local a71/e294 line offsets must not substitute for hosted callsites. Phase A has uncommitted behavior-preserving projection extraction only; its old exclusion/mapping is unchanged. No test/build/CI action, logical fix or artifact modification was performed during triage.

## All first-broken steps

| Phase/case | Exact source / ordered checks line | First failure and scope not reached |
| --- | --- | --- |
| Light09 | 2117 / 6176 | Empty saved View was opened and screenshot `23-empty-view-with-menu` added. After opening picker, `app.buttons["All Mail"].tap()` matches TWO buttons: popup All Mail and fixed `mail.filter.all`. Selection/return assertion not reached. This is a selector ambiguity with two legitimate controls, not proof All Mail is inaccessible. |
| Light10 | 1572 / 6358 | Actual long press, Move sheet, Focus choice and Move tap occurred. Inbox bar exists and message1 nonexistence passed. Picker Focus selection/bar exists; original 10s row1 return wait fails. All Mail retention, subsequent move-back, sender View preview/save are NOT reached. |
| Light12/13/40/42 | 1518/1441/2125/2195; checks6459/6560/6661/6877 | Initial `assertInboxLoaded`: Inbox bar is found, fixture row1 existence fails before scrolling/refresh/picker-repeat/held-refresh scenarios. |
| Light46 | 245 / 7130 | Writing signature exists and is edited; switches to Appearance & reading. Querying `settings.save.isEnabled` fails snapshot matching. Actual sparse hierarchy has **Save account choices** and **Discard edits**, both identifier `settings.root`, not `settings.save`. Stay/Leave assertions not reached. |
| Light49 | 276 / 7243 | Primary Mail Search input accepts Friday, Search key is pressed; waiting10s for `search.save-view` fails before opening editor. No UI preview/Save/recovery proof. |
| Light50/51/52 | 83/121/56; checks7346/7451/7554 | Initial fixture row1 existence wait fails. Query A/B reader-refresh, sender preview/refinement, and first SavedView search-pending UI handlers are NOT exercised. |
| Dark08/09/10/12/13/40/42 | 2050/2104/1557/1518/1441/2125/2195; checks7690/7791/7892/7993/8094/8195/8411 | Initial Inbox row1 wait fails. Dark09 does NOT repeat Light09's duplicate-All-Mail first step; Dark10 does NOT reach Move. |
| Dark45 | 203 / 8535 | Reset control executed, All Mail opened, conversation Importance button/sheet found, `importance.important` was tapped once. Original10s `importance.status` StaticText wait fails; current effective readback/Undo/reopen/correction assertions not reached. Do not substitute later teardown reset POST200 as UI acknowledgement. |
| Dark46/49 | 245/276; checks8644/8757 | Same first failing Settings Save identifier query / Search Save existence as light. |
| Dark50/51/52 | 83/121/56; checks8860/8962/9065 | Initial fixture row1 wait fails, not feature-handler execution. |

Main Light passes include test08 visibility and test45 actual importance journey; test44 and41 pass in both main phases. These limited successes do not close the failed scope. Seventeen failures across the two phases stop at the initial row1 precondition (7 light, 10 dark); that classification is not seventeen independent product defects or a claim all are conclusively cascades.

## Move/Focus identity and concrete request chronology

Test10 starts at 19:54:45.874 UTC in checks. `fixture.log` correlates by the same wall-clock epoch:

- 19:55:00.577 GET inbox `view=all`, response19:55:00.922 includes messages1–5 (initial Inbox source passes destination separately).
- Test taps Move at t33.07. At t35.20 waits for row1 nonexistence, which passes.
- 19:55:19.992 GET inbox `view=all`, response19:55:20.023 includes only messages2–5.
- Test opens mailbox picker, taps Focus at t40.29; Focus navigation bar is found.
- 19:55:27.072 GET inbox **view=focus**, response19:55:27.136 `messageIds:[]`.
- Original row1 wait fails at source1572; no `12-native-focus-result` or `13-native-all-mail-retention` attachment occurs.
- Following initial Inbox requests at19:55:53.146,19:56:30.977,19:57:08.281 and19:58:22.608 return messages2–5, continuing to exclude1.

Exact source explains distinct targets. `mobile-fixture.ts:95–98` creates an actual named Focus destination and records its opaque ID in legacy behavior `focus`. `MailActions.swift` loads every destination and PUTs `/v1/destinations/routing` for the conversation using selected destination ID. `MailboxViews.swift:65–76` excludes both normal/focus legacy IDs. `InboxViewModel.swift` maps utility `focus` to legacy **normal destination** plus `view=focus`. Test10 selects the real Focus destination in Move, then the differently scoped utility with the same displayed name in Mailboxes. The observed post-move disappearance and empty utility result are consistent with that source mismatch. A later utility cannot supply results of the actual moved-to named destination.

Limits: fixture logging includes path/view/query/result IDs but omits destinationId/accountId and does not log the Move PUT/body/receipt. No SQLite placement snapshot or request-owned routing readback is exported. Therefore the specific stored override ID and absence of other actors are not independently proven by this artifact. The source + before/after responses strongly support the moved-row state-cascade hypothesis; they do not justify labeling every later failure a cascade without target readback.

Test08 hides the optional utility, verifies saved View/notification independence, then restores the utility at its successful light end. It must continue to target that utility's typed ID after real Spaces are exposed. It must not assert absence of every user-owned destination merely named “Focus.”

## Independent boundaries

**Light09:** sparse failure tree directly lists popup `All Mail` and permanent `mail.filter.all`. Use the intended actual control identity, not arbitrary `.firstMatch`. A semantic picker-row identifier or explicit fixed-All-Mail action would resolve the stimulus while retaining the original escape assertion; no implementation authorized yet.

**Settings46:** source attaches `settings.save` to Button but `settings.root` to an ancestor; actual runtime snapshot shows both Save and Discard inheriting `settings.root`. This supports identifier propagation as a narrow cause, independent of missing Inbox mail. Save label is present; no claim saving, dirty guards or persistence failed. Candidate: scope the root identifier to an appropriate container without overriding leaf control IDs, preserving labels/hit areas and all assertions. Requires separate authorization/hosted proof.

**Search49:** source `InboxView.swift:104–108` conditionally presents `search.save-view` when accepted resultSearch is nonempty. Exact server trace at20:00:40.951 has query Friday and response20:00:41.467 contains message2; input equality passed and Search key was pressed before failure. Thus empty Inbox due moved message1 is insufficient to explain this missing control. No post-submit button hierarchy/frames or screenshot is exported, so toolbar suppression during native searchable activity, identifier publication and layout remain hypotheses. Do not incorrectly substitute MailSearchView's separate toolbar or claim editor failure. Request targeted failure-teardown capture of Save label/ID count/frames, native navigation/search state and accepted rows, preserving single Submit/original10s wait.

**Dark45:** All Mail restores access to row1 and the Importance sheet before the missing receipt-state wait. A real dark before-choice screenshot exists; no post-choice screenshot/HTTP operation ledger/receipt-specific hierarchy is present. The helper GET and POST200 after original failure are teardown reset, not evidence the tap succeeded. Retain as separate unresolved receipt/control-boundary failure; capture post-original-failure UI/current-state/operation evidence without a second tap or longer deadline.

## Images actually inspected and mapping limits

All 22 main-phase phone screenshots (1206×2622) were visually inspected; the 68 other main-light images are unit-render-size artifacts, not inspected as phone UI. No ordinal→test attachment manifest/raw xcresult was exported, so ordinal mappings below describe observed content and timestamp correlation, not invented unique failure attribution.

Light: Orca-139 shows Move mail, subject “A quieter kind of inbox,” Move to Focus, Apply to Just this conversation, Move conversation; Orca-169 shows its matching long-press Inbox context. These correlate with only reached light Move steps at7:55. Orca-310 shows Empty view / No matching mail at7:54. Orca-1 shows the light saved-view picker; Orca-59 shows Hub notifications rows; Orca-149 notifications and190 visibility list show distinct utility/Spaces meanings. Orca-171/183 show AX picker/Inbox with four conversations at7:57/7:58, consistent with row1 omission. Orca-13 shows AX selected long-named destination/empty state. Orca-65/101 show Important empty;66 All Mail contains Maya;105/113 before/acknowledged importance;240 Important contains Maya. None is a screenshot of the failing Search49 or Settings46 post-edit boundary.

Dark: OrcaDark-28/288 show long-name/Inbox AX views with no visible row1,289 picker;42 All Mail contains Maya;206 Important loading;144 before-choice Importance sheet at8:10. The dark before-choice image is not a post-tap receipt or evidence of network failure.

## Narrow proposals; no fixes performed

1. Preserve this before evidence and Phase A's old projection/utility behavior. Execute its frozen production-projection baseline only after separate allocation; missing native named Focus browse is already a source feature gap and this runtime10 supplies a related honest end-to-end red.
2. Phase B should expose actual named destination IDs distinctly and label optional utility Inbox focus. Test10 must select the actual moved-to destination by typed/opaque identity, retaining same user Move/reader/retention assertions. Test08 stays utility-only; never use name-only `.firstMatch` to choose among meanings.
3. Capture original owned conversation routing before test10 mutation and register teardown BEFORE Move, restoring the exact prior explicit/inherited state using the existing authenticated revisioned route and verifying it. Keep the normal UI move-back assertions too; teardown protects later tests but cannot turn failed10 into pass. Do not silently reset all app/user state or weaken later initial-row assertions. Account/session/receipt ownership and late/uncertain mutation handling need review before a cleanup implementation.
4. Resolve only Light09's actual ambiguous control query with scoped identity; diagnose Search/Settings/Importance independently as above. No deadline inflation, skips, forced clicks, repeated taps, or fixture-mail-content changes.
5. Request richer sanitized routing target/account/readback diagnostics from the API owner if needed; no API/fixture-service edits were made here. Keep all later not-reached feature handlers pending current native acceptance.

No logical navigation, Settings, UI selector, fixture cleanup or Importance fix is included in this triage. No runtime allocation is requested until root reads this report and the clean Phase A source checkpoint.
