import Foundation

/// Production InboxViewModel/APIClient over owned HTTP transport. No UI substitute.
@MainActor func runPaginationCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    func page(_ name: String, cursor: String?, account: String = "account") throws -> Data {
        let row = InboxMessage(id: name, accountId: account, provider: "gmail", providerMessageId: name, threadId: name,
                               from: .init(email: "sender@example.com"), subject: name, snippet: name,
                               receivedAt: "2026-11-11T00:00:00Z", unread: false, labels: [], attentionBehavior: "normal")
        return try JSONEncoder().encode(InboxPage(accounts: [], messages: [row], nextCursor: cursor,
                                                 counts: .init(focus: 0, normal: 0, quiet: 0, hidden: 0, all: 1)))
    }
    func fixture(_ name: String) -> AppState {
        let state = AppState(cache: CacheStore(directory: cacheRoot.appending(path: name)))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { "synthetic-pagination" }
        return state
    }
    for (code, kind, invalidates) in [(400, "invalid_request", false), (400, "other_error", false), (503, "unavailable", false),
                                      (401, "unauthorized", true), (403, "forbidden", true), (404, "account_not_found", true)] {
        let name = "\(code)-\(kind)", state = fixture(name), model = InboxViewModel()
        model.view = "all"; model.search = "submitted-query"
        var cursors = [String?]()
        ReviewURLProtocol.handler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            cursors.append(cursor)
            if cursors.count == 1 { return (200, try page("accepted", cursor: "valid-cursor")) }
            return (code, try ReviewRegressions.json(["error": ["code": kind, "message": "Controlled pagination failure"]]))
        }
        await model.load(state: state); await model.load(state: state, reset: false)
        check("CORE02-pagination-" + name + "-request-count", cursors.count == 2 && cursors.last! == "valid-cursor", "ordinary error codes never trigger cursor restart; no invented retry")
        check("CORE02-pagination-" + name + "-owned-state", invalidates ? model.messages.isEmpty && model.nextCursor == nil : model.messages.map(\.id) == ["accepted"] && model.nextCursor == "valid-cursor", "auth/ownership errors invalidate rows; other pagination failures retain the already accepted owned page and manual-retry cursor")
        check("CORE02-pagination-" + name + "-error-and-provenance", model.error == "Controlled pagination failure" && !model.isLoading && model.resultSearch == "submitted-query", "failure stays visible with submitted-query provenance and completed loading")
    }
    for freshSucceeds in [true, false] {
        let state = fixture("cursor-restart-\(freshSucceeds)"), model = InboxViewModel(); model.view = "all"
        var cursors = [String?]()
        ReviewURLProtocol.handler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            cursors.append(cursor)
            if cursors.count == 1 { return (200, try page("accepted", cursor: "expired-cursor")) }
            if cursors.count == 3 && freshSucceeds { return (200, try page("fresh", cursor: "fresh-cursor")) }
            return (400, try ReviewRegressions.json(["error": ["code": "invalid_cursor", "message": "Revision changed"]]))
        }
        await model.load(state: state); await model.load(state: state, reset: false)
        check("CORE02-typed-cursor-restart-\(freshSucceeds)", cursors.count == 3 && cursors[0] == nil && cursors[1] == "expired-cursor" && cursors[2] == nil, "only typed invalid_cursor restarts once against a fresh snapshot")
        check("CORE02-typed-cursor-result-\(freshSucceeds)", model.messages.map(\.id) == [freshSucceeds ? "fresh" : "accepted"] && model.nextCursor == (freshSucceeds ? "fresh-cursor" : nil) && !model.isLoading && (freshSucceeds ? model.error == nil : model.error != nil), "failed fresh restart retains accepted owned rows but retires stale cursor; successful restart replaces rows")
    }
    for transition in ["owner", "account", "logout"] {
        let state = fixture("held-\(transition)"), model = InboxViewModel(); model.view = "all"
        let hold = SearchRequestHold()
        var requests = 0
        ReviewURLProtocol.handler = { _ in requests += 1; return (200, try page(requests == 1 ? "accepted" : "late", cursor: "next")) }
        await model.load(state: state)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await hold.token() }
        let pending = Task { await model.load(state: state, reset: false) }
        await hold.waitUntilHeld()
        if transition == "owner" { state.ownerScope = "other-owner"; state.userID = "other-owner" }
        else if transition == "account" { state.accounts = [.init(id: "other-account", provider: "gmail", email: "other@example.com", displayName: "Other fixture", capabilities: .init(read: true, send: true, draft: true))]; state.selectedAccountID = "other-account" }
        else { state.phase = .signedOut }
        // This is the existing native navigation/logout invalidation boundary.
        model.invalidate(); await hold.release(); await pending.value
        check("CORE02-late-pagination-\(transition)-invalidated", model.messages.isEmpty && model.nextCursor == nil && model.resultSearch.isEmpty && !model.isLoading, "late old identity response cannot restore cleared rows after native invalidation")
    }
}
