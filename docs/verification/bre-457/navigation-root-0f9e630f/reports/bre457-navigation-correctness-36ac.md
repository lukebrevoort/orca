# Native navigation Phase B — independent correctness review

## Identity and verdict

- Reviewer: `/root/review_native_navigation_correctness_36ac`, inherited model; independent of the implementation agent. Correctness/maintainability review; separate security reviewer owns the security assessment.
- Worktree: `/Users/lbrevoort/.t3/worktrees/orca/t3-e7dbe952-6002d97f243ef88b`.
- Exact base: `93000c6116b61c80684fb8dd337ff28eb1793389`.
- Exact head: `36ac2e844715ec202d4b20841866e35afc2788b1`.
- Feature: `c65f303a469efd7f1e120208f21fced95a049edb`; normal main97 merge: `d9848cdd2e4335b03f850f3cd8ce10d07acbba07`; prepared docs follow. HEAD and clean status were read back during this review.
- **Verdict: CHANGES REQUESTED for one narrow P2 presentation/recovery omission (C1).** The remaining comments are nonblocking Consider/Noted items. This is a source verdict only, not permission to publish, merge or claim runtime acceptance.

No tests, compilers, Swift parses, API/fixture servers, browsers, CI queries, builds or heavy processes were run. No checkout files were edited. This report is the only produced file.

## Intent and reviewed scope

Read the applicable AGENTS instructions, `.agents/skills/interrogate/SKILL.md`, canonical P02/P06/P16 specs and the Phase B preparation README, inventory/source scope and integration receipt. Reviewed the relevant native delta and production callers: catalog/wire models, actual API320 metadata and canonical-definition agreement, real context factory and APIClient authorization callback, catalog/result controllers, mailbox projection/preferences, internal navigation and Settings dirty-exit guard, Inbox and source Back paths, grouped picker and visibility Settings. Also inspected the new Foundation controls, hosted units/UI54/55, routing receipt fixture, used compensation planner, loopback witness probe, gate and project/runner changes.

Inherited API320 `bfd47277` semantics were checked against the published shared schemas/canonicalizer where needed. API319's independent review was not duplicated. Reader/Message tools/Compose/DraftStore and viewport changes outside this delta were not relabeled as verified.

## Findings

### C1 — Act on, P2: Visible views Settings presents failed optional catalogs as empty/current

**Location:** `apps/ios/Orca/SettingsView.swift:415–422`; relevant state producers `Core/NativeMailBrowser.swift:37–45,56–65`; contrast the correct picker handling at `Mail/NativeMailboxPicker.swift:59–61`.

**Problem:** The new Settings sections use `mailboxes.groups` for Spaces, Collections and Pins and render `No visible choices. Hidden choices can be restored below.` whenever that group's options are empty. They never display `browser.spaceError`, `browser.catalogError`, the corresponding stale flags, or catalog loading. The only error displayed below is `mailboxes.error`, which belongs to the independent Saved Views request. A failure of only destinations/collections-pins therefore looks like a genuinely empty or fully hidden catalog even if Saved Views succeeded. If same-connection offline cache exists, the catalog's explicit stale warning is likewise dropped and the cached names/visibility choices appear current.

**Concrete static reproduction:** Fresh verified account with no optional catalog cache; Saved Views GET succeeds; destinations GET or collections-pins query GET returns503. `NativeMailBrowser` sets the failed section's error and leaves its model nil; `groups` projects an empty array; open Settings → Visible views. It displays the empty/hidden statement for that section and no failed-section error. The same failure is explained correctly in the Mailboxes picker, so the omission is in this new Settings caller rather than in controller state. With a valid connection-local cached catalog followed by offline failure, the same caller drops the existing offline/stale explanation.

**Why act:** P02 explicitly distinguishes catalog loading/empty/error; P16 requires truthful catalog-failure behavior while retaining visibility. The current text specifically suggests Hidden recovery although the options may merely be unavailable. Fixed All Mail remains reachable and saved preferences are retained, so this is not data loss or an authorization defect.

**Suggested narrow fix:** Render per-section loading/error/stale copy from the existing browser state in Visible views (or share a small section-state projection with the picker). Suppress the empty/hidden message until that section has a successful current catalog; retain existing preferences and fixed Mail. Reuse the existing refresh action. Add a focused actual-caller/view-state regression covering independent section failure with Saved Views success, and cached offline warning. No API/controller or mutation change is needed.

### C2 — Consider: new collection/pin result lists do not refresh on foreground when only stored mail changes

**Location:** `Mail/NativeCatalogResults.swift:61–64`; `OrcaApp.swift:119–133`; primary comparison `Mail/InboxView.swift:152–158`.

The new result list reloads for context/route fingerprint/read-revision changes and manual pull/reload. On active, MainView refreshes accounts and catalogs; neither changes the result task key if a query definition/collection membership is unchanged and only stored mail was synchronized elsewhere. Primary Mail has a separate active refresh, but explicitly excludes these separate-mailbox surfaces. Thus leave a saved-query pin open, background the app, add a matching stored message without editing the query, then return: this source path has no results GET until manual reload. A collection whose existing thread receives a newer message has the same issue unless catalog membership/revision also changes.

This is a concrete refresh asymmetry, but manual recovery exists and P02 does not explicitly prescribe an active refresh schedule, so it is **not an additional blocking claim**. Decide foreground policy intentionally. If parity with primary Mail is intended, add a same-context active reload and a result-request test; do not change definition/cursor provenance just to force it. A runtime native resume scenario remains necessary.

### C3 — Consider: retain the desired row until a post-Back refresh can restore focus

**Location:** `Mail/NativeCatalogResults.swift:61–75`.

`restoreFocus` clears `openedRow` on its first call, including `onAppear`, using whatever messages currently exist. When Back also causes a read-revision reload, the subsequent loading completion no longer knows the desired row. Depending on actual navigation/view lifetime, it can request focus before a refreshed list is installed and lose that request after replacement. This is a lifecycle concern, not a demonstrated AX failure: the new runtime tests are unexecuted and public SwiftUI focus timing was not observed here.

Keep the row token until a settled list can resolve it (or document why existing retained rows guarantee restoration); include source-row/fallback focus in hosted Back checks. Do not replace the existing row identity with firstMatch or add forced coordinates.

## Noted strengths and boundaries

- **Noted:** Fixed Important/All Mail, optional Inbox focus, literal named Spaces and typed account-owned catalog choices remain separate. Legacy pin mailbox enums are not reinterpreted as Saved View IDs. Sender pins are explicitly described as name/address substring search, not exact importance identity.
- **Noted:** The production query reader compares actual query ID/account/object revision/digest/profile and strict row/account/provider/freshness contracts before publication/cache; query canonicalization covers the published normalization, including inbox/all collapse and JS-compatible string/UTF16 handling. The golden-vector harness uses the actual published shared implementation.
- **Noted:** Context includes verified origin/user/account/real connection epoch/owned set, not cached username alone. The opt-in request authorization captures the URL before suspension and checks token/response boundaries. Controllers capture request generations and reject later stale publication; cold-offline workspace identity is not guessed.
- **Noted:** The results controller distinguishes ordinary pagination failure, auth/missing/malformed scope rejection and the single typed invalid-cursor restart. Cached first pages have no cached continuation; page freshness cannot mix. No broader cache-purge policy was introduced.
- **Noted:** New source-aware Back logic rejects old connection/owner/removed account/newer explicit account choice. Submitted A versus unfinished B is retained through the actual primary-mail handlers rather than testing only a parallel mock renderer.
- **Noted:** Routing cleanup uses actual bounded authenticated PUT witnesses and strict acknowledgment/inverse chains. The planner compensates only at the exact accepted revision, without adopting a later GET-current revision. Missing/ambiguous/intervening state fails rather than overwriting it. The fixture exception is synthetic/opt-in in purpose and does not substitute a fake success route.
- **Noted:** Exact planned IDs, source hashes, duplicate/missing coverage checks and grammar recording after controller failure are meaningful gate structure. The dedicated fixture tsconfig includes scripts omitted by the ordinary API tsconfig. This is still prepared source, not proof those stages pass.
- **Noted:** The optional section controller itself correctly separates its errors; C1 is a caller omission. The picker displays these errors and retains permanent recovery.
- **Dismissed:** Suspected account-query naming mismatch: the actual catalog route accepts the accountId alias and returns accountIds, matching this caller.
- **Dismissed:** Suspected humanSignal numeric mismatch: published schema is integer0–10 nullable, matching the new strict decoder.
- **Dismissed:** Suspected migration loss of per-destination visibility: the old projection did not use legacy enabled IDs to hide destinations. New hidden storage is additive; legacy optional focus/Saved View enabled history remains in use.

## Tests and evidence assessment

The inventory describes414 planned unique cases: historical275 plus139 new across models/decoders/controllers/held-origin-freshness/actual API and shared canonical vectors/routing planner. Meaningful adversarial assertions include strict wrong-account/provider metadata, malformed/unknown shape, duplicate rows, cursor restart/ordinary errors, late token/response/client/origin changes, offline cache boundaries, canonical parity, and independent SQL/provider counters. The actual AppState factory is separately covered by planned hosted units; Foundation support state does not prove SwiftUI or native AppState runtime.

Seven new hosted units, UI54/55 both mailbox themes,44 grammar inputs,13 actual witness controls, transitive fixture types and four runner selections remain **unexecuted at this review**. No source approval turns those into passes. Existing historical275/223, viewport geometry/grammar receipts and fb10 failures retain their original revisions and limits. New API integration is source publication, not deployed service or physical-device acceptance.

The new tests are generally tied to observable boundaries rather than implementation-only counters. The coverage does not currently exercise C1's actual Settings status rendering or C2's unchanged-definition foreground refresh. UI54/55 cover owned selection, reader Back, local Hide/Restore and search A/B; they do not yet establish two-account Apple UI return/focus behavior, large-text hit geometry, or independent native resume freshness.

## Security and maintainability assessment

No new concrete authorization/cross-owner write defect was identified in this correctness pass. This is not a replacement for the independent security review. New browsing operations are read-only; original-owner/context/session checks are pervasive and actual pin/query semantics are kept typed. Fail-closed decode logic is intentionally strict and therefore needs the planned real-contract execution before relying on it.

The split between catalog definitions, readers, projection and SwiftUI callers is substantially clearer than reconstructing pin JSON in views. Several new files pack multiple validation branches/statements onto single lines; a later readability-only pass would ease schema maintenance, but it is not a blocker and should not broaden this candidate before its gates.

## Required next disposition

Address C1 narrowly, obtain review of that delta, then run the root-allocated exact final-source gate. C2/C3 need an explicit policy/hosted verification disposition, not a fabricated pass. Preserve all previous reds and static/runtime distinctions. Root owns publication, hosted screenshots, whole-workspace/native checks and final acceptance.
