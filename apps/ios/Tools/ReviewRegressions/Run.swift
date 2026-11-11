import Foundation

@main struct ReviewRegressions {
    @MainActor static func main() async throws {
        let connection = CommandLine.arguments.count > 1 ? try JSONDecoder().decode(Connection.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) : nil
        var results = [[String: Any]]()
        func check(_ name: String, _ ok: Bool, _ detail: String) { results.append(["case": name, "pass": ok, "detail": detail]) }
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
        check("465-known-newer-revision-disables-Undo", !undoController.canUndo, "current conversation revision2 supersedes receipt revision1")

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
        if let connection {
            state.client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
            let client = state.client!
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
            await view.review(); _ = await view.save()
            let after: MailActionJSON = try await client.request("__bre457/state")
            check("466-edit-retry-exactly-one-creation", after["count"].integer == committed["count"].integer, "actual view count after commit/retry = \(after["count"].integer ?? -1), first count = \(committed["count"].integer ?? -1)")
            view.close()
            let reopened = NativeViewEditorController(defaults: defaults)
            await reopened.open(selection: selection, state: state)
            reopened.name = "Reopened edit"; reopened.replaceSearch = true; reopened.subject = "Subject"; reopened.edited()
            await reopened.review(); _ = await reopened.save()
            let final: MailActionJSON = try await client.request("__bre457/state")
            check("466-dismiss-reopen-no-duplicate", final["count"].integer == committed["count"].integer, "actual view count after reopen = \(final["count"].integer ?? -1)")
            check("466-provider-boundary", final["providerCalls"].integer == 0, "synthetic provider calls = \(final["providerCalls"].integer ?? -1)")
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["scope": "production native controllers/Foundation HTTP/cache; not Apple UI", "results": results], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
        if results.contains(where: { $0["pass"] as? Bool == false }) { exit(1) }
    }
    struct Connection: Decodable { var baseURL: String; var token: String }
    static func json(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    static func resolution(_ effective: String, revision: Int) -> [String: Any] {
        ["effective": effective, "source": revision > 0 ? "conversation" : "unreviewed", "conversation": ["choice": revision > 0 ? "important" as Any : NSNull(), "revision": revision], "inherited": "unreviewed", "participantCounts": ["important": 0,"notImportant": 0,"unreviewed": 1,"total": 1], "preferences": [], "preferencesTruncated": false, "accountRevision": revision]
    }
}
