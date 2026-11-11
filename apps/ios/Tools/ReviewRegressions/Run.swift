import Foundation

@main struct ReviewRegressions {
    @MainActor static func main() async throws {
        let connection = CommandLine.arguments.count > 1 ? try JSONDecoder().decode(Connection.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) : nil
        var results = [[String: Any]]()
        func check(_ name: String, _ ok: Bool, _ detail: String) { results.append(["case": name, "pass": ok, "detail": detail]); FileHandle.standardOutput.write(Data("CASE \(name): \(ok ? "PASS" : "FAIL") — \(detail)\n".utf8)) }
        let root = FileManager.default.temporaryDirectory.appending(path: "bre457-controller-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let state = AppState(cache: CacheStore(directory: root.appending(path: "cache")))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { "synthetic" }
        let suite = "bre457-review-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var command: ImportanceCommand?, offline = false, revision = 0
        ReviewURLProtocol.handler = { request in
            let path = request.url!.path
            if path == "/v1/importance/choices" {
                command = try JSONDecoder().decode(ImportanceCommand.self, from: body(request)); revision = 1; offline = true
                throw URLError(.networkConnectionLost)
            }
            if path.contains("/operations/") {
                if offline { throw URLError(.notConnectedToInternet) }
                let c = command!
                return (200, try json(["status": "current", "receipt": ["operationId": c.operationId, "accountId": "account", "target": ["kind": "conversation", "threadId": "A"], "choice": "important", "previousChoice": NSNull(), "revision": 1, "undoUntil": ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))], "current": ["choice": "important", "revision": 1]]))
            }
            let id = request.url!.lastPathComponent
            return (200, try json(["accountId": "account", "threadId": id, "importance": resolution(id == "A" && revision > 0 ? "important" : "unreviewed", revision: id == "A" ? revision : 0)]))
        }
        let importance = ImportanceController(defaults: defaults)
        await importance.open(state: state, accountId: "account", threadId: "A")
        await importance.choose(.important, state: state)
        check("465-original-uncertain-lock", importance.uncertain && importance.receipt == nil, "A committed, acknowledgement lost and reconciliation offline")
        offline = false
        await importance.open(state: state, accountId: "account", threadId: "B")
        await importance.reconcile(state: state)
        check("465-no-A-receipt-under-B", importance.receipt == nil || importance.receipt?.target.threadId == "B", "visible receipt target = \(importance.receipt?.target.threadId ?? "none")")
        check("465-no-A-undo-under-B", !importance.canUndo, "Undo must not operate on A under B")
        let undoController = ImportanceController(defaults: defaults)
        revision = 0
        await undoController.open(state: state, accountId: "account", threadId: "A")
        await undoController.choose(.important, state: state); offline = false
        await undoController.reconcile(state: state)
        check("465-stale-test-established-current-receipt", undoController.receipt?.revision == 1 && undoController.canUndo, "must establish current revision1 receipt before checking revision2")
        revision = 2; await undoController.refresh(state: state)
        check("465-known-newer-revision-disables-Undo", !undoController.canUndo && undoController.receipt == nil, "current conversation revision2 supersedes receipt revision1")

        let inbox = InboxViewModel(); inbox.view = "all"
        var networkOffline = false
        ReviewURLProtocol.handler = { request in
            if networkOffline { throw URLError(.notConnectedToInternet) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "query" }!.value!
            let message = InboxMessage(id: query, accountId: "account", provider: "gmail", providerMessageId: query, threadId: query, from: .init(email: "person@example.com"), subject: query, snippet: query, receivedAt: "2026-11-11T00:00:00Z", unread: false, labels: [], attentionBehavior: "normal")
            return (200, try JSONEncoder().encode(InboxPage(accounts: [], messages: [message], nextCursor: nil, counts: .init(focus: 0, normal: 0, quiet: 0, hidden: 0, all: 1))))
        }
        for query in ["A", "B", "A"] { inbox.search = query; await inbox.load(state: state) }
        networkOffline = true; inbox.search = "B"; await inbox.load(state: state)
        check("cached-query-provenance", inbox.messages.first?.id == "B" && inbox.resultSearch == "B", "cached row \(inbox.messages.first?.id ?? "none") labeled \(inbox.resultSearch)")
        var corrected = false
        ReviewURLProtocol.handler = { request in
            if request.url!.path == "/v1/importance/choices" {
                let command = try JSONDecoder().decode(ImportanceCommand.self, from: body(request)); corrected = true
                return (200, try json(["status": "current", "receipt": ["operationId": command.operationId, "accountId": "account", "target": ["kind": "conversation", "threadId": "Submitted A"], "choice": "important", "previousChoice": NSNull(), "revision": 1, "undoUntil": ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))], "current": ["choice": "important", "revision": 1]]))
            }
            if request.url!.path.contains("/importance/conversations/") { return (200, try json(["accountId": "account", "threadId": "Submitted A", "importance": resolution(corrected ? "important" : "unreviewed", revision: corrected ? 1 : 0)])) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "query" }!.value!
            var message = InboxMessage(id: query, accountId: "account", provider: "gmail", providerMessageId: query, threadId: query, from: .init(email: "person@example.com"), subject: query, snippet: query, receivedAt: "2026-11-11T00:00:00Z", unread: false, labels: [], attentionBehavior: "normal")
            message.importance = try JSONDecoder().decode(ImportanceResolution.self, from: json(resolution(corrected ? "important" : "unreviewed", revision: corrected ? 1 : 0)))
            return (200, try JSONEncoder().encode(InboxPage(accounts: [], messages: [message], nextCursor: nil, counts: .init(focus: 0, normal: 0, quiet: 0, hidden: 0, all: 1))))
        }
        let globalSearch = InboxViewModel(); globalSearch.search = "Submitted A"
        _ = await globalSearch.openGlobalSearch(state: state)
        globalSearch.search = "Unsubmitted B"
        let beforeCorrectionKey = InboxViewModel.globalSearchRefreshIdentity(state: state)
        let acknowledgedSearchChoice = ImportanceController(defaults: defaults)
        await acknowledgedSearchChoice.open(state: state, accountId: "account", threadId: "Submitted A")
        await acknowledgedSearchChoice.choose(.important, state: state)
        check("480-correction-actually-acknowledged", acknowledgedSearchChoice.receipt?.target.threadId == "Submitted A", "production ImportanceController accepts the synthetic HTTP acknowledgement and publishes its real state revision callback")
        if beforeCorrectionKey != InboxViewModel.globalSearchRefreshIdentity(state: state) { _ = await globalSearch.openGlobalSearch(state: state) }
        check("480-acknowledged-correction-refreshes-submitted-search", globalSearch.messages.first?.importance?.effective == .important && globalSearch.resultSearch == "Submitted A" && globalSearch.search == "Unsubmitted B" && globalSearch.messages.first?.id == "Submitted A", "actual controller rows refresh on production task identity while submitted provenance and unsent query stay distinct; not SwiftUI runtime")
        let accountState = AppState(cache: state.cache), searchHold = SearchRequestHold()
        accountState.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await searchHold.token() }
        ReviewURLProtocol.handler = { request in
            let account = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "accountId" }!.value!
            let message = InboxMessage(id: account, accountId: account, provider: "gmail", providerMessageId: account, threadId: account, from: .init(email: "person@example.com"), subject: "Account query", snippet: "Synthetic", receivedAt: "2026-11-11T00:00:00Z", unread: false, labels: [], attentionBehavior: "normal")
            return (200, try JSONEncoder().encode(InboxPage(accounts: [], messages: [message], nextCursor: nil, counts: .init(focus: 0, normal: 0, quiet: 0, hidden: 0, all: 1))))
        }
        let accountSearch = InboxViewModel(); accountSearch.search = "Account query"
        let staleSearch = Task { _ = await accountSearch.openGlobalSearch(state: accountState) }
        await searchHold.waitUntilHeld()
        var otherAccount = accountState.accounts[0]; otherAccount.id = "other-account"
        accountState.accounts.append(otherAccount); accountState.selectedAccountID = otherAccount.id
        _ = await accountSearch.openGlobalSearch(state: accountState)
        await searchHold.release(); await staleSearch.value
        check("480-late-old-account-search-cannot-overwrite", accountSearch.messages.map(\.accountId) == ["other-account"] && accountSearch.resultSearch == "Account query", "production controller account/request generation rejects held older account response")
        let preferences = AccountPreferencesController()
        state.accountPreferences = preferences
        preferences.edits = .init(signature: "Unsaved", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false)
        state.selectedTab = "settings"
        state.routeNotification(["threadId": "incoming", "accountId": "account"])
        check("notification-route-keeps-unsaved-settings", state.selectedTab == "settings" && state.routedThread == nil && preferences.dirty, "notification must use the shared Stay/Leave guard")
        state.stayInSettings()
        check("473-stay-preserves-edits", state.selectedTab == "settings" && preferences.dirty && state.pendingSettingsNavigation == nil, "Stay cancels notification navigation")
        state.routeNotification(["threadId": "incoming", "accountId": "account"])
        state.discardSettingsAndLeave()
        check("473-leave-routes-original-thread", state.selectedTab == "inbox" && state.routedThread?.id == "incoming" && !preferences.dirty, "explicit discard applies captured route")
        state.selectedTab = "settings"; state.routedThread = nil
        preferences.edits = .init(signature: "Keep on changed owner", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false)
        state.routeNotification(["threadId": "old-owner", "accountId": "account"])
        let originalOwner = state.ownerScope; state.ownerScope = "other-owner"; state.discardSettingsAndLeave()
        check("473-stale-owner-cannot-route", state.selectedTab == "settings" && state.routedThread == nil && preferences.dirty, "delayed Leave cannot route or discard another owner's choices")
        state.ownerScope = originalOwner
        let preferenceHold = PreferenceCredentialHold()
        let preferenceState = AppState(cache: state.cache)
        preferenceState.userID = "verified-owner-a"; preferenceState.ownerScope = "origin|verified-owner-a"
        preferenceState.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await preferenceHold.token() }
        let ownedPreferences = AccountPreferencesController()
        var dispatchedOwner: String?, dispatchedToken: String?
        ReviewURLProtocol.handler = { request in
            if request.httpMethod == "PATCH" {
                dispatchedOwner = request.value(forHTTPHeaderField: "x-orca-expected-user-id")
                dispatchedToken = request.value(forHTTPHeaderField: "Authorization")
            }
            return (200, try json(["signature": "original", "composeFormat": "plain", "replyBehavior": "reply", "notifyByDefault": false]))
        }
        await ownedPreferences.load(state: preferenceState)
        ownedPreferences.edits?.signature = "Owner A unsaved choices"
        let preferenceSave = Task { await ownedPreferences.save(state: preferenceState) }
        await preferenceHold.waitUntilHeld()
        preferenceState.userID = "verified-owner-b"; preferenceState.ownerScope = "origin|verified-owner-b"
        await preferenceHold.release(); await preferenceSave.value
        check("469-native-header-retains-original-owner-after-held-token", dispatchedOwner == "verified-owner-a" && dispatchedToken == "Bearer owner-b-token", "actual APIClient dispatch retains captured draft owner even after token/observable owner change; server enforcement separate")
        check("469-native-stale-ack-keeps-original-edits", ownedPreferences.edits?.signature == "Owner A unsaved choices" && ownedPreferences.saved?.signature == "original", "late different-owner response cannot replace the original draft")
        if let connection {
            do {
            state.client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
            let client = state.client!
            let authenticated: AuthSession = try await client.request("v1/auth/session")
            state.userID = authenticated.user?.id; state.baseURLText = connection.baseURL
            state.ownerScope = await client.serverOrigin() + "|" + (authenticated.user?.id ?? "unknown")
            state.accounts = try await client.accounts()
            let apiHold = PreferenceCredentialHold(first: connection.token, second: connection.otherToken)
            let realPreferencesState = AppState(cache: state.cache)
            realPreferencesState.userID = authenticated.user?.id
            realPreferencesState.ownerScope = await client.serverOrigin() + "|" + (authenticated.user?.id ?? "unknown")
            realPreferencesState.client = APIClient(baseURL: URL(string: connection.baseURL)!) { await apiHold.token() }
            let realPreferences = AccountPreferencesController()
            let preferencesBefore: MailActionJSON = try await client.request("__bre457/state")
            await realPreferences.load(state: realPreferencesState)
            realPreferences.edits?.signature = "Owner A attempted save under B credential"
            let heldSave = Task { await realPreferences.save(state: realPreferencesState) }
            await apiHold.waitUntilHeld(); await apiHold.release(); await heldSave.value
            let preferencesAfter: MailActionJSON = try await client.request("__bre457/state")
            let canonical = JSONEncoder(); canonical.outputFormatting = .sortedKeys
            check("469-real-server-held-token-zero-preference-writes", try canonical.encode(preferencesBefore["preferences"]) == canonical.encode(preferencesAfter["preferences"]), "actual independent SQLite preference rows for A and B remain byte-equivalent")
            if case .array(let requests) = preferencesAfter["requests"] {
                let wrongOwner = requests.filter { $0["path"].text == "/v1/preferences" && $0["fixtureOwner"].text == "owner-b" }
                check("469-real-server-rejects-patch-and-recovery", wrongOwner.count == 2 && wrongOwner.allSatisfy { $0["status"].integer == 409 && $0["expectedOwner"].text == authenticated.user?.id && ($0["error"].text ?? "").contains("session_owner_changed") }, "actual APIClient PATCH and recovery GET use original verified A owner with B token; both actual server409")
            }
            check("469-real-server-preference-write-probe-zero", try canonical.encode(preferencesBefore["preferenceWrites"]) == canonical.encode(preferencesAfter["preferenceWrites"]), "fixture-owned SQLite INSERT/UPDATE/DELETE triggers observe no preference writes on rejected held PATCH/recovery")
            let _: AccountPreferences = try await client.request("v1/preferences", method: "PATCH", body: AccountPreferences(signature: "Owner A same-owner positive control", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false), headers: ["x-orca-expected-user-id": authenticated.user!.id])
            let positivePreferences: MailActionJSON = try await client.request("__bre457/state")
            if case .array(let observedWrites) = positivePreferences["preferenceWrites"] {
                check("469-write-probe-positive-control", observedWrites.count == 1 && observedWrites[0]["user_id"].text == authenticated.user?.id, "same-owner real PATCH succeeds and independently records one A write; B remains untouched")
            }
            let selection = NativeViewSelection(query: "Subject", accountId: "account")
            let view = NativeViewEditorController(defaults: defaults)
            await view.open(selection: selection, state: state)
            view.name = "Exactly one view"; view.replaceSearch = true; view.subject = "Subject"; view.edited()
            await view.review()
            let before: MailActionJSON = try await client.request("__bre457/state")
            let _: MailActionJSON = try await client.request("__bre457/drop-next-commit", method: "POST", body: ["drop": true])
            let lost = await view.save()
            let committed: MailActionJSON = try await client.request("__bre457/state")
            check("466-first-commit-actually-recorded", lost == nil && committed["count"].integer == (before["count"].integer ?? 0) + 1, "actual API/SQLite commit exists; response replaced by HTTP503")
            view.name = "Edited after lost acknowledgement"; view.edited()
            let _: MailActionJSON = try await client.request("__bre457/drop-next-commit", method: "POST", body: ["drop": true])
            await view.review(); _ = await view.save()
            let after: MailActionJSON = try await client.request("__bre457/state")
            check("466-edit-retry-exactly-one-creation", after["count"].integer == committed["count"].integer && view.pendingTarget != nil, "actual view count after commit/retry = \(after["count"].integer ?? -1), first count = \(committed["count"].integer ?? -1)")
            view.close()
            let reopened = NativeViewEditorController(defaults: defaults)
            await reopened.open(selection: selection, state: state)
            reopened.name = "Reopened edit"; reopened.replaceSearch = true; reopened.subject = "Subject"; reopened.edited()
            await reopened.review(); _ = await reopened.save()
            await reopened.review(); _ = await reopened.save()
            let final: MailActionJSON = try await client.request("__bre457/state")
            check("466-dismiss-reopen-no-duplicate", final["count"].integer == committed["count"].integer, "actual view count after reopen = \(final["count"].integer ?? -1)")
            if case .array(let ledger) = final["ledger"], ledger.count >= 3 {
                let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
                let commands = try ledger.prefix(3).map { try encoder.encode($0["command"]) }
                check("466-repeated-retry-preserves-exact-command", Set(commands).count == 1, "first three committed/replayed requests retain identical UUID, expected revisions and reviewed definition")
            } else { check("466-repeated-retry-preserves-exact-command", false, "replay ledger missing") }
            let definition: MailActionJSON = .object(["revision": .number(1), "accountIds": .array([.string("account")]), "sender": .object(["addresses": .array([.string("person@example.com")])]), "thread": .object(["subjectContains": .string("Subject"), "readState": .string("unread")])])
            let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object(["kind": .string("typed_definition"), "source": .object(["kind": .string("manual"), "label": .string("Synthetic advanced View")]), "identity": .object(["name": .string("Advanced original")]), "definition": definition]))
            let advancedPreview: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"]), "page": .object(["limit": .number(25)])]))
            let created: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object(["draft": advancedPreview["draft"], "expectedRevisions": .object(["workspace": advancedPreview["workspaceRevision"], "view": .null]), "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": advancedPreview["draft"]["definitionDigest"]]))
            let advancedID = created["view"]["id"].text!
            let editor = NativeViewEditorController(defaults: defaults)
            await editor.open(selection: .init(viewId: advancedID, accountId: "account"), state: state)
            editor.name = "Advanced renamed"; editor.edited(); await editor.review(); let updatedID = await editor.save()
            let listed: MailActionJSON = try await client.request("v1/organization/views")
            if case .array(let views) = listed["items"], let advanced = views.first(where: { $0["id"].text == advancedID }) {
                let expected = try JSONEncoder().encode(definition)
                let actual = try JSONEncoder().encode(advanced["definition"])
                let same = try NSDictionary(dictionary: JSONSerialization.jsonObject(with: expected) as! [String: Any]).isEqual(to: JSONSerialization.jsonObject(with: actual) as! [String: Any])
                check("466-advanced-definition-preserved", updatedID == advancedID && same && advanced["name"].text == "Advanced renamed", "actual API saved ID and complete sender/thread/readState definition retained")
            } else { check("466-advanced-definition-preserved", false, "updated advanced view missing") }
            let latest: MailActionJSON = try await client.request("__bre457/state")
            check("466-advanced-update-no-extra-creation", latest["count"].integer == (committed["count"].integer ?? 0) + 1, "one recovered View plus one intentional advanced fixture, updates retain both IDs")
            check("466-provider-boundary", latest["providerCalls"].integer == 0, "synthetic provider calls = \(latest["providerCalls"].integer ?? -1)")
            func createFixtureView(_ name: String) async throws -> String {
                let input: MailActionJSON = .object(["kind": .string("typed_definition"), "source": .object(["kind": .string("manual"), "label": .string("Rejected-commit fixture")]), "identity": .object(["name": .string(name)]), "definition": definition])
                let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: input)
                let editable = prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
                let preview: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": editable, "page": .object(["limit": .number(25)])]))
                let saved: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object(["draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]), "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["draft"]["definitionDigest"]]))
                return saved["view"]["id"].text!
            }
            let noopSuite = suite + ".noop", noopDefaults = UserDefaults(suiteName: noopSuite)!
            defer { noopDefaults.removePersistentDomain(forName: noopSuite) }
            let noop = NativeViewEditorController(defaults: noopDefaults)
            await noop.open(selection: .init(viewId: advancedID, accountId: "account"), state: state)
            await noop.review(); _ = await noop.save()
            let rejectedNoop: MailActionJSON = try await client.request("__bre457/state")
            if case .array(let ledger) = rejectedNoop["ledger"] {
                check("478-noop-actual-terminal-400", ledger.last?["actualStatus"].integer == 400 && rejectedNoop["count"].integer == latest["count"].integer, "actual API no-op rejection writes no View")
            }
            noop.name = "Noop recovery preserves latest edit"; noop.edited(); noop.close()
            let noopReopened = NativeViewEditorController(defaults: noopDefaults)
            await noopReopened.open(selection: .init(viewId: advancedID, accountId: "account"), state: state)
            check("478-noop-reopen-unlocks-preview", noopReopened.pendingTarget == nil && noopReopened.name == "Noop recovery preserves latest edit", "definitive rejection must recover current authorized saved identity without dropping newer edits")
            await noopReopened.review(); let noopSaved = await noopReopened.save()
            let afterNoop: MailActionJSON = try await client.request("__bre457/state")
            check("478-noop-recovery-updates-same-id", noopSaved == advancedID && afterNoop["count"].integer == latest["count"].integer, "fresh explicit preview/update retains original ID and creation count")
            let staleSuite = suite + ".stale", staleDefaults = UserDefaults(suiteName: staleSuite)!
            defer { staleDefaults.removePersistentDomain(forName: staleSuite) }
            let createSelection = NativeViewSelection(query: "Subject", accountId: "account")
            let stale = NativeViewEditorController(defaults: staleDefaults)
            await stale.open(selection: createSelection, state: state)
            stale.name = "Stale original"; stale.replaceSearch = true; stale.subject = "Subject"; stale.edited(); await stale.review()
            _ = try await createFixtureView("Independent workspace revision advance")
            let beforeStale: MailActionJSON = try await client.request("__bre457/state")
            _ = await stale.save()
            let rejectedStale: MailActionJSON = try await client.request("__bre457/state")
            if case .array(let ledger) = rejectedStale["ledger"] {
                check("478-stale-create-actual-terminal-409", ledger.last?["actualStatus"].integer == 409 && rejectedStale["count"].integer == beforeStale["count"].integer, "actual stale workspace rejection creates nothing")
            }
            stale.name = "Stale recovery preserves latest edit"; stale.edited(); stale.close()
            let staleReopened = NativeViewEditorController(defaults: staleDefaults)
            await staleReopened.open(selection: createSelection, state: state)
            check("478-stale-reopen-preserves-ready-edits", staleReopened.pendingTarget == nil && staleReopened.name == "Stale recovery preserves latest edit" && staleReopened.replaceSearch, "recovery must retain explicitly chosen predicate and editable draft")
            await staleReopened.review(); let createdAfterConflict = await staleReopened.save()
            let afterStale: MailActionJSON = try await client.request("__bre457/state")
            check("478-stale-recovery-creates-exactly-once", createdAfterConflict != nil && afterStale["count"].integer == (beforeStale["count"].integer ?? 0) + 1, "one creation only after fresh preview/explicit Save")
            for lostKind in ["noop", "stale"] {
                let lostSuite = suite + ".lost-rejection." + lostKind, lostDefaults = UserDefaults(suiteName: lostSuite)!
                defer { lostDefaults.removePersistentDomain(forName: lostSuite) }
                let lostSelection = lostKind == "noop" ? NativeViewSelection(viewId: advancedID, accountId: "account") : createSelection
                let lostEditor = NativeViewEditorController(defaults: lostDefaults)
                await lostEditor.open(selection: lostSelection, state: state)
                if lostKind == "stale" { lostEditor.name = "Lost stale original"; lostEditor.subject = "Subject"; lostEditor.replaceSearch = true; lostEditor.edited() }
                await lostEditor.review()
                if lostKind == "stale" { _ = try await createFixtureView("Advance before lost rejection") }
                let beforeLost: MailActionJSON = try await client.request("__bre457/state")
                let _: MailActionJSON = try await client.request("__bre457/drop-next-commit-response", method: "POST", body: ["drop": true])
                _ = await lostEditor.save()
                let afterLost: MailActionJSON = try await client.request("__bre457/state")
                if case .array(let ledger) = afterLost["ledger"] {
                    check("478-lost-" + lostKind + "-actual-rejection-hidden", ledger.last?["actualStatus"].integer == (lostKind == "noop" ? 400 : 409) && ledger.last?["deliveredStatus"].integer == 503 && afterLost["count"].integer == beforeLost["count"].integer && lostEditor.pendingTarget != nil, "actual server rejected without write, but client received503 and must preserve uncertainty")
                }
                lostEditor.name = "Recovered lost " + lostKind; lostEditor.edited(); lostEditor.close()
                let lostReopened = NativeViewEditorController(defaults: lostDefaults)
                await lostReopened.open(selection: lostSelection, state: state)
                check("478-lost-" + lostKind + "-reopen-retains-command", lostReopened.pendingTarget != nil && lostReopened.name == "Recovered lost " + lostKind, "reopening retains original immutable pending command and newer edits")
                _ = await lostReopened.save()
                await lostReopened.review(); let recoveredID = await lostReopened.save()
                let afterRecovery: MailActionJSON = try await client.request("__bre457/state")
                check("478-lost-" + lostKind + "-recovery-completes-once", recoveredID != nil && (lostKind != "noop" || recoveredID == advancedID) && afterRecovery["count"].integer == (beforeLost["count"].integer ?? 0) + (lostKind == "noop" ? 0 : 1), "typed authorized recovery must release rejected command after lost acknowledgement; preserve saved identity/exactly-one creation")
            }
            try await runCommitStatusCases(state: state, client: client, suite: suite, otherToken: connection.otherToken, createFixtureView: createFixtureView, check: check)
            } catch { check("native-actual-api-journey", false, String(describing: error)) }
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["scope": "production native controllers/Foundation HTTP/cache; not Apple UI", "results": results], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if results.contains(where: { $0["pass"] as? Bool == false }) { exit(1) }
    }
    struct Connection: Decodable { var baseURL: String; var token: String; var otherToken: String }
    static func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    static func resolution(_ effective: String, revision: Int) -> [String: Any] {
        ["effective": effective, "source": revision > 0 ? "conversation" : "unreviewed", "conversation": ["choice": revision > 0 ? "important" as Any : NSNull(), "revision": revision], "inherited": "unreviewed", "participantCounts": ["important": 0,"notImportant": 0,"unreviewed": 1,"total": 1], "preferences": [], "preferencesTruncated": false, "accountRevision": revision]
    }
}
