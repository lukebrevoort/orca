import Foundation

/// The primary Mail handlers call this production adapter. Global search is not
/// substituted for Mail; URLProtocol observes the actual APIClient requests.
@MainActor func runPrimaryMailCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    func fixture(_ name: String) -> AppState {
        let state = AppState(cache: CacheStore(directory: cacheRoot.appending(path: name)))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { "primary-mail-fixture" }
        return state
    }
    func page(_ id: String, account: String, cursor: String? = nil) throws -> Data {
        let row = InboxMessage(id: id, accountId: account, provider: "gmail", providerMessageId: id, threadId: id, from: .init(email: "sender@example.com"), subject: id, snippet: id, receivedAt: "2026-11-11T00:00:00Z", unread: false, labels: [], attentionBehavior: "normal")
        return try JSONEncoder().encode(InboxPage(accounts: [], messages: [row], nextCursor: cursor, counts: .init(focus: 0, normal: 0, quiet: 0, hidden: 0, all: 1)))
    }
    for event in [InboxViewModel.PrimaryMailEvent.refresh, .page] {
        let state = fixture("event-\(event)"), model = InboxViewModel()
        var requests = [(query: String, cursor: String?)]()
        ReviewURLProtocol.handler = { request in
            let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
            let query = items.first { $0.name == "query" }?.value ?? ""
            let cursor = items.first { $0.name == "cursor" }?.value
            requests.append((query, cursor))
            return (200, try page(query + (cursor == nil ? "1" : "2"), account: "account", cursor: cursor == nil ? "page-two" : nil))
        }
        model.search = "A"; await model.loadPrimaryMail(state: state, mailboxView: "normal", event: .submit)
        check("CORE02-primary-\(event)-submitted-precondition", model.resultSearch == "A" && model.messages.map(\.id) == ["A1"] && model.nextCursor == "page-two", "real primary Mail Submit accepts A with a second page before editing B")
        model.search = "B"; await model.loadPrimaryMail(state: state, mailboxView: "normal", event: event)
        check("CORE02-primary-\(event)-request-keeps-submitted-query", requests.count == 2 && requests.last?.query == "A" && (event != .page || requests.last?.cursor == "page-two"), "routine primary Mail refresh/page must request submitted A, not unfinished B; observed=\(requests)")
        check("CORE02-primary-\(event)-rows-and-editable-provenance", model.search == "B" && model.resultSearch == "A" && model.messages.map(\.id) == (event == .page ? ["A1", "A2"] : ["A1"]), "typed B remains editable while accepted A rows/provenance and page append stay A")
    }
    do {
        let state = fixture("owned-two-query-cache"), model = InboxViewModel(), other = InboxViewModel()
        var offline = false
        ReviewURLProtocol.handler = { request in
            if offline { throw URLError(.notConnectedToInternet) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "query" }!.value!
            return (200, try page(query, account: "account"))
        }
        other.search = "B"; await other.loadPrimaryMail(state: state, mailboxView: "normal", event: .submit)
        model.search = "A"; await model.loadPrimaryMail(state: state, mailboxView: "normal", event: .submit)
        check("CORE02-primary-cache-two-query-precondition", other.messages.first?.id == "B" && model.messages.first?.id == "A", "both owned caches contain distinguishable accepted data")
        model.search = "B"; offline = true
        await model.loadPrimaryMail(state: state, mailboxView: "normal", event: .refresh)
        check("CORE02-primary-offline-refresh-keeps-A-cache", model.search == "B" && model.resultSearch == "A" && model.messages.map(\.id) == ["A"] && model.error?.hasPrefix("Offline — showing saved mail") == true, "refresh must read A's owned cache, not typed B's valid but unsubmitted cached rows")
    }
    for switchAccount in [false, true] {
        let state = fixture("held-\(switchAccount)"), model = InboxViewModel()
        ReviewURLProtocol.handler = { _ in (200, try page("A", account: "account")) }
        model.search = "A"; await model.loadPrimaryMail(state: state, mailboxView: "all", event: .submit)
        let hold = SearchRequestHold(), config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        state.client = APIClient(baseURL: URL(string: "https://example.invalid")!, session: URLSession(configuration: config)) { await hold.token() }
        var actualQuery: String?
        ReviewURLProtocol.handler = { request in
            actualQuery = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "query" }?.value
            return (200, try page(actualQuery ?? "none", account: "account"))
        }
        model.search = "B"
        let refresh = Task { await model.loadPrimaryMail(state: state, mailboxView: "all", event: .refresh) }
        await hold.waitUntilHeld()
        if switchAccount {
            state.accounts.append(.init(id: "other-account", provider: "gmail", email: "other@example.com", displayName: "Other", capabilities: .init(read: true, send: true, draft: true)))
            state.selectedAccountID = "other-account"; model.invalidate()
        } else { model.search = "C" }
        await hold.release(); await refresh.value
        check("CORE02-primary-held-\(switchAccount ? "account" : "typing")-request", actualQuery == "A", "the in-flight routine request must capture submitted A before any await")
        check("CORE02-primary-held-\(switchAccount ? "account" : "typing")-ownership", switchAccount ? model.messages.isEmpty && model.resultSearch.isEmpty : model.search == "C" && model.resultSearch == "A" && model.messages.map(\.id) == ["A"], "late other-account response cannot install; editing again must not clear the accepted submitted conversation set")
    }
}

/// Exact extracted legacy sender-sheet commands over real API/SQLite. This
/// establishes network/recovery behavior, not row rendering or SwiftUI behavior.
@MainActor func runPrimaryMailSenderAPICases(connection: ReviewRegressions.Connection, cacheRoot: URL,
                                            check: @MainActor (String, Bool, String) -> Void) async throws {
    let client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
    let state = AppState(cache: CacheStore(directory: cacheRoot))
    let auth: AuthSession = try await client.request("v1/auth/session")
    state.client = client; state.userID = auth.user?.id; state.baseURLText = connection.baseURL
    state.ownerScope = await client.serverOrigin() + "|" + (state.userID ?? "unknown"); state.accounts = try await client.accounts()
    let scope = state.ownerScope
    func current() -> Bool { scope == state.ownerScope && state.phase == .ready && !Task.isCancelled }
    func snapshot() async throws -> MailActionJSON { try await client.request("__bre457/state") }
    let primary = InboxViewModel(); primary.search = "Subject"
    await primary.loadPrimaryMail(state: state, mailboxView: "all", event: .submit)
    check("CORE02-primary-real-API-A-precondition", primary.messages.contains { $0.id == "mail" } && primary.resultSearch == "Subject", "actual production inbox endpoint returned owned matching mail before unsubmitted edit")
    primary.search = "Unsubmitted no matching fixture"
    await primary.loadPrimaryMail(state: state, mailboxView: "all", event: .refresh)
    let afterQuery = try await snapshot()
    if case .array(let requests) = afterQuery["requests"], let last = requests.last(where: { $0["path"].text == "/v1/inbox" }) {
        check("CORE02-primary-real-API-refresh-keeps-submitted-A", last["query"].text == "Subject" && primary.messages.contains { $0.id == "mail" } && primary.resultSearch == "Subject" && primary.search == "Unsubmitted no matching fixture", "actual HTTP ledger and rows must stay with submitted A, not editable B")
    } else { check("CORE02-primary-real-API-refresh-keeps-submitted-A", false, "actual inbox request ledger missing") }
    let message = InboxMessage(id: "mail", accountId: "account", provider: "gmail", providerMessageId: "mail", threadId: "thread", from: .init(email: "person@example.com"), subject: "Subject fixture", snippet: "Synthetic only", receivedAt: "1970-01-01T00:00:01Z", unread: true, labels: [], attentionBehavior: "normal")
    let fresh = LegacySenderViewCommand(), initial = try await snapshot()
    try await fresh.prepare(message: message, savedViews: [], viewID: "", name: "Fresh native sender", client: client, current: current)
    if case .array(let items) = fresh.preview?["results"]["items"] {
        check("VIEW01-sender-actual-matching-rows-returned", items.contains { $0["threadId"].text == "thread" && $0["accountId"].text == "account" }, "real preview returns actual matching rows; this positive control is not proof the old sheet renders them")
    } else { check("VIEW01-sender-actual-matching-rows-returned", false, "real preview rows missing") }
    let saved = try await fresh.commit(client: client, current: current)
    let repeatSaved = try await fresh.commit(client: client, current: current), afterFresh = try await snapshot()
    check("VIEW01-sender-fresh-repeated-command-one-creation", saved?["view"]["id"].text != nil && saved?["view"]["id"].text == repeatSaved?["view"]["id"].text && afterFresh["count"].integer == (initial["count"].integer ?? -1) + 1, "same prepared legacy command replays200 without a second creation")
    let lost = LegacySenderViewCommand()
    try await lost.prepare(message: message, savedViews: [], viewID: "", name: "Lost acknowledgement sender", client: client, current: current)
    let _: MailActionJSON = try await client.request("__bre457/drop-next-commit", method: "POST", body: MailActionJSON.object([:]))
    var lost503 = false
    do { _ = try await lost.commit(client: client, current: current) }
    catch APIClient.ClientError.http(503, _) { lost503 = true }
    let committed = try await snapshot()
    check("VIEW01-sender-lost-ack-actual-commit-precondition", lost503 && committed["count"].integer == (afterFresh["count"].integer ?? -1) + 1, "actual API committed once and fixture replaced only the200 acknowledgement with503")
    // Dismissal destroys the old sheet's StateObject; a fresh instance mirrors
    // the actual reopened sheet. There is no invented cancel/unadopt operation.
    let reopened = LegacySenderViewCommand()
    try await reopened.prepare(message: message, savedViews: [], viewID: "", name: "Lost acknowledgement sender", client: client, current: current)
    let reopenedSave = try await reopened.commit(client: client, current: current)
    _ = try await reopened.commit(client: client, current: current)
    let afterReopen = try await snapshot()
    check("VIEW01-sender-lost-ack-dismiss-reopen-exactly-one", reopenedSave?["view"]["id"].text != nil && afterReopen["count"].integer == committed["count"].integer, "reopening/repeated Save must adopt the original ID, not create again; actual before=\(committed["count"].integer ?? -1) after=\(afterReopen["count"].integer ?? -1)")
    if case .array(let ledger) = afterReopen["ledger"] {
        let commands = ledger.filter { $0["command"]["draft"]["identity"]["name"].text == "Lost acknowledgement sender" }
        let keys = Set(commands.compactMap { $0["command"]["retryKey"].text })
        check("VIEW01-sender-lost-ack-retains-original-command", commands.count == 3 && keys.count == 1, "lost response/reopen/retry must retain one immutable key; observed requests=\(commands.count) keys=\(keys.count)")
    }
    let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object([
        "kind": .string("typed_definition"), "skipInbox": .bool(true), "source": .object(["kind": .string("manual"), "label": .string("Advanced sender fixture")]),
        "identity": .object(["name": .string("Existing advanced sender target")]),
        "definition": .object(["revision": .number(1), "accountIds": .array([.string("account")]), "sender": .object(["domains": .array([.string("retained.example")])]), "thread": .object(["subjectContains": .string("Subject"), "readState": .string("unread")])])
    ]))
    let preview: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])]))
    let advanced: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object(["draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": .null]), "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null]))
    let catalog = try await client.mailboxViews(), addition = LegacySenderViewCommand()
    guard let target = catalog.items.first(where: { $0.id == advanced["view"]["id"].text }) else { check("VIEW01-sender-advanced-target-precondition", false, "advanced fixture target missing"); return }
    try await addition.prepare(message: message, savedViews: catalog.items, viewID: target.id, name: "Must not replace target", client: client, current: current)
    let result = try await addition.commit(client: client, current: current), final = try await snapshot()
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    let retainedDomains = try encoder.encode(result?["view"]["definition"]["sender"]["domains"] ?? .null) == encoder.encode(advanced["view"]["definition"]["sender"]["domains"])
    let retainedThread = try encoder.encode(result?["view"]["definition"]["thread"] ?? .null) == encoder.encode(advanced["view"]["definition"]["thread"])
    check("VIEW01-sender-advanced-target-preserved", result?["view"]["id"].text == target.id && result?["view"]["name"].text == target.name && result?["view"]["skipInbox"].flag == true && retainedDomains && retainedThread, "selected_senders adds the real exact sender while retaining target identity/advanced predicates/routing, using existing wire")
    check("VIEW01-sender-provider-boundary", final["providerCalls"].integer == 0, "actual independent provider counter stays0")
}
