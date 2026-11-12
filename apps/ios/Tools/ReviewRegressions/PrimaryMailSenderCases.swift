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
    do {
        let state = fixture("explicit-boundaries"), model = InboxViewModel()
        var queries = [String?]()
        ReviewURLProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "query" }?.value
            queries.append(query); return (200, try page(query ?? "all", account: "account"))
        }
        model.search = "A"; await model.loadPrimaryMail(state: state, mailboxView: "all", event: .submit)
        model.search = ""; await model.loadPrimaryMail(state: state, mailboxView: "all", event: .refresh)
        check("CORE02-primary-empty-edit-remains-unsubmitted", queries == ["A", "A"] && model.search.isEmpty && model.resultSearch == "A" && model.messages.first?.id == "A", "backspacing an editable field through empty is not an implicit Submit")
        model.clearPrimaryMailSearch(); await model.loadPrimaryMail(state: state, mailboxView: "all", event: .refresh)
        check("CORE02-primary-explicit-clear-restores-mailbox", queries.count == 3 && queries.last! == nil && model.resultSearch.isEmpty && model.messages.first?.id == "all", "explicit All Mail/filter action clears submitted intent and uses the real mailbox endpoint")
        await model.loadPrimaryMail(state: state, mailboxView: "view:owned", event: .page)
        await model.loadPrimaryMail(state: state, mailboxView: "view:owned", event: .refresh)
        check("CORE02-primary-saved-view-transition-defers-own-endpoint", queries.count == 3 && model.resultSearch.isEmpty && model.messages.isEmpty, "a saved View is handled by SavedMailboxResults, never an invented inbox view parameter")
        model.search = "Fresh"; await model.loadPrimaryMail(state: state, mailboxView: "view:owned", event: .submit)
        check("CORE02-primary-search-from-saved-view-explicit-submit", queries.count == 4 && queries.last! == "Fresh" && model.view == "all" && model.resultSearch == "Fresh" && model.messages.first?.id == "Fresh", "explicit submission from a saved View still searches All Mail without clearing the new query")
    }
}

/// The unified production native editor over real API/SQLite. Historical b3
/// exercised the old sender sheet; this is the same journey and invariants,
/// with the explicitly reviewed no-POST-after-ack count correction.
@MainActor func runPrimaryMailSenderAPICases(connection: ReviewRegressions.Connection, cacheRoot: URL,
                                            check: @MainActor (String, Bool, String) -> Void) async throws {
    let client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
    let state = AppState(cache: CacheStore(directory: cacheRoot))
    let auth: AuthSession = try await client.request("v1/auth/session")
    state.client = client; state.userID = auth.user?.id; state.baseURLText = connection.baseURL
    state.ownerScope = await client.serverOrigin() + "|" + (state.userID ?? "unknown"); state.accounts = try await client.accounts()
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
    let suite = "bre457-sender-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    func selection(_ name: String, target: String? = nil) -> NativeViewSelection {
        .init(viewId: target, accountId: message.accountId, senderReferences: [.init(accountId: message.accountId, threadId: message.threadId, messageId: message.id)], suggestedName: name)
    }
    let fresh = NativeViewEditorController(defaults: defaults), initial = try await snapshot()
    await fresh.open(selection: selection("Fresh native sender"), state: state); await fresh.review()
    if case .array(let items) = fresh.preview?["results"]["items"] {
        check("VIEW01-sender-actual-matching-rows-returned", items.contains { $0["threadId"].text == "thread" && $0["accountId"].text == "account" }, "real preview returns actual matching rows; visible rendering still requires hosted native UI")
    } else { check("VIEW01-sender-actual-matching-rows-returned", false, "real preview rows missing") }
    let saved = await fresh.save()
    let repeatSaved = await fresh.save(), afterFresh = try await snapshot()
    check("VIEW01-sender-fresh-repeated-command-one-creation", saved != nil && fresh.draft?["viewId"].text == saved && repeatSaved == nil && afterFresh["count"].integer == (initial["count"].integer ?? -1) + 1, "acknowledged original ID stays current and repeated Save is a no-op, with one actual creation")
    fresh.close()
    let lost = NativeViewEditorController(defaults: defaults)
    await lost.open(selection: selection("Lost acknowledgement sender"), state: state); await lost.review()
    let _: MailActionJSON = try await client.request("__bre457/drop-next-commit", method: "POST", body: MailActionJSON.object([:]))
    _ = await lost.save()
    let committed = try await snapshot()
    let committedLedger: [MailActionJSON]
    if case .array(let items) = committed["ledger"] { committedLedger = items } else { committedLedger = [] }
    let lost503 = committedLedger.last?["actualStatus"].integer == 200 && committedLedger.last?["deliveredStatus"].integer == 503 && lost.pendingTarget != nil
    let originalID = committedLedger.last?["response"]["view"]["id"].text
    check("VIEW01-sender-lost-ack-actual-commit-precondition", lost503 && committed["count"].integer == (afterFresh["count"].integer ?? -1) + 1, "actual API committed once and fixture replaced only the200 acknowledgement with503")
    lost.close()
    let reopened = NativeViewEditorController(defaults: defaults)
    await reopened.open(selection: selection("Lost acknowledgement sender"), state: state)
    let reopenedSave = await reopened.save(), afterAck = try await snapshot()
    _ = await reopened.save()
    let afterReopen = try await snapshot()
    check("VIEW01-sender-lost-ack-dismiss-reopen-exactly-one", reopenedSave != nil && reopenedSave == originalID && afterReopen["count"].integer == committed["count"].integer, "reopening/repeated Save adopts the owned original ID, not another creation; actual before=\(committed["count"].integer ?? -1) after=\(afterReopen["count"].integer ?? -1)")
    if case .array(let ledger) = afterReopen["ledger"], case .array(let acknowledgedLedger) = afterAck["ledger"] {
        let commands = ledger.filter { $0["command"]["draft"]["identity"]["name"].text == "Lost acknowledgement sender" }
        let keys = Set(commands.compactMap { $0["command"]["retryKey"].text })
        let canonical = JSONEncoder(); canonical.outputFormatting = .sortedKeys
        let bodies = try commands.map { try canonical.encode($0["command"]) }
        check("VIEW01-sender-pending-retry-exact-and-ack-quiescent", commands.count == 2 && keys.count == 1 && Set(bodies).count == 1 && ledger.count == acknowledgedLedger.count, "one lost ACK then original retry; every pending body/key is identical and repeated Save after definitive ACK issues NO further POST")
    }
    reopened.close()
    if let saved {
        let refined = NativeViewEditorController(defaults: defaults)
        await refined.open(selection: selection("Ignored target label", target: saved), state: state)
        refined.subject = "Subject fixture"; refined.replaceSearch = true; refined.edited(); await refined.review()
        let beforeRefineSave = try await snapshot()
        check("VIEW01-sender-refinement-is-real-preview-no-write", beforeRefineSave["count"].integer == afterReopen["count"].integer && refined.preview?["draft"]["definition"]["thread"]["subjectContains"].text == "Subject fixture" && refined.preview?["results"]["count"]["value"].integer == 1, "explicit sender refinement previews real matching mail and changes no stored View before Save")
        let refinedID = await refined.save(); refined.close()
        let reloaded = NativeViewEditorController(defaults: defaults)
        await reloaded.open(selection: .init(viewId: saved, accountId: "account"), state: state)
        let afterRefineSave = try await snapshot()
        check("VIEW01-sender-refinement-save-reopen-real-predicate", refinedID == saved && reloaded.draft?["definition"]["thread"]["subjectContains"].text == "Subject fixture" && afterRefineSave["count"].integer == afterReopen["count"].integer, "explicit Save/reopen updates the same owned ID and preserves actual refined predicate with no new creation")
        reloaded.close()
    }
    let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object([
        "kind": .string("typed_definition"), "skipInbox": .bool(true), "source": .object(["kind": .string("manual"), "label": .string("Advanced sender fixture")]),
        "identity": .object(["name": .string("Existing advanced sender target")]),
        "definition": .object(["revision": .number(1), "accountIds": .array([.string("account")]), "sender": .object(["domains": .array([.string("retained.example")])]), "thread": .object(["subjectContains": .string("Subject"), "readState": .string("unread")])])
    ]))
    let preview: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])]))
    let advanced: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object(["draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": .null]), "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null]))
    let catalog = try await client.mailboxViews(), addition = NativeViewEditorController(defaults: defaults)
    guard let target = catalog.items.first(where: { $0.id == advanced["view"]["id"].text }) else { check("VIEW01-sender-advanced-target-precondition", false, "advanced fixture target missing"); return }
    await addition.open(selection: selection("Must not replace target", target: target.id), state: state); await addition.review()
    let resultID = await addition.save(), final = try await snapshot()
    let result: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object(["kind": .string("saved_view"), "viewId": .string(target.id)]))
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    let retainedDomains = try encoder.encode(result["draft"]["definition"]["sender"]["domains"]) == encoder.encode(advanced["view"]["definition"]["sender"]["domains"])
    let retainedThread = try encoder.encode(result["draft"]["definition"]["thread"]) == encoder.encode(advanced["view"]["definition"]["thread"])
    check("VIEW01-sender-advanced-target-preserved", resultID == target.id && result["draft"]["viewId"].text == target.id && result["draft"]["identity"]["name"].text == target.name && result["draft"]["skipInbox"].flag && retainedDomains && retainedThread, "selected_senders adds the real exact sender while retaining target identity/advanced predicates/routing, using existing wire")
    check("VIEW01-sender-provider-boundary", final["providerCalls"].integer == 0, "actual independent provider counter stays0")
}
