import Foundation

private func nativeJSON(_ value: [String: Any]) throws -> MailActionJSON { try JSONDecoder().decode(MailActionJSON.self, from: ReviewRegressions.json(value)) }
private func nativeAccount(_ id: String = "account") -> [String: Any] {
    ["id": id, "provider": "gmail", "email": id + "@example.com", "displayName": "Synthetic", "capabilities": ["read": true, "draft": true, "send": true]]
}
private func nativeRow(_ id: String = "row", account: String = "account") -> [String: Any] {
    ["id": id, "accountId": account, "provider": "gmail", "providerMessageId": id, "threadId": id, "from": ["name": "Synthetic", "email": "sender@example.com"], "subject": id, "snippet": "Synthetic only", "receivedAt": "2026-11-11T00:00:00Z", "unread": false, "labels": [], "attentionBehavior": "normal", "humanSignal": NSNull(), "humanClassification": NSNull()]
}
private func nativeRouting() -> [String: Any] {
    ["revision": 3, "fallbackDestinationId": "opaque-inbox", "legacyDestinationIds": ["normal": "opaque-inbox", "focus": "opaque-focus"], "destinations": [
        ["id": "opaque-focus", "name": "My named Focus", "isFallback": false, "color": "#70867d", "position": 0, "revision": 2, "retiredAt": NSNull(), "notificationPreference": "badge", "delivery": "proposal_only", "counts": ["total": 4, "unread": 1]],
        ["id": "opaque-inbox", "name": "My named Inbox", "isFallback": true, "color": "#70867d", "position": 1, "revision": 1, "retiredAt": NSNull(), "notificationPreference": "quiet", "delivery": "proposal_only", "counts": ["total": 0, "unread": 0]]
    ]]
}
private func nativeCatalog() -> [String: Any] {
    ["workspaceId": "owner", "accountIds": ["account"], "collections": [["id": "same", "accountId": "account", "name": "Équipe / keep", "color": "#70867d", "position": 0, "threadIds": ["row"], "revision": 4, "createdAt": "2026-11-11T00:00:00Z", "updatedAt": "2026-11-11T00:00:00Z"]], "pins": [], "queries": []]
}
private func nativeQueryValue() -> [String: Any] { ["id": "query", "accountId": "account", "name": "Keep query", "revision": 9, "definition": ["revision": 1, "filters": ["dataSource": "stored_mail", "text": "Synthetic"]]] }
private func nativePage(query: NativeSavedQuery? = nil, row: String = "row", cursor: String? = "opaque-next", freshness: String = String(repeating: "a", count: 64)) -> [String: Any] {
    var result: [String: Any] = ["accounts": [nativeAccount()], "messages": [nativeRow(row)], "nextCursor": cursor as Any? ?? NSNull(), "freshness": ["revision": "mailbox-v2:" + freshness, "lastSyncedAt": NSNull()]]
    if let query { result["query"] = ["id": query.id, "accountId": query.accountID, "revision": query.revision, "definitionDigest": query.definition.digest, "evaluationProfile": query.definition.profile] }
    else { result["counts"] = ["focus": 0, "normal": 1, "quiet": 0, "hidden": 0, "all": 1] }
    return result
}

@MainActor func runNativeCatalogModelCases(check: @MainActor (String, Bool, String) -> Void) throws {
    func rejects(_ value: [String: Any]) -> Bool { (try? NativeMailCatalog(nativeJSON(value), owner: "owner", account: "account", ownedAccounts: ["account"])) == nil }
    let catalog = try NativeMailCatalog(nativeJSON(nativeCatalog()), owner: "owner", account: "account", ownedAccounts: ["account"])
    let spaces = try NativeSpaceCatalog(nativeJSON(nativeRouting()))
    check("NAV-B-literal-space-names-order", spaces.options.map(\.name) == ["My named Focus", "My named Inbox"], "used strict catalog calls production projection; both formerly omitted actual named Spaces survive")
    let views = [SavedMailboxView(id: "same", name: "Keep view", description: "", revision: 2)]
    let groups = NativeMailboxProjection.groups(destinations: spaces.options, views: views, enabledIDs: ["focus", "view:same"], hiddenIDs: [], catalog: catalog)
    check("NAV-B-group-order", groups.map(\.id) == ["fixed", "inbox", "spaces", "collections", "views", "pins"], "real UI uses this group projection")
    check("NAV-B-removed-saved-view-fallback", NativeMailboxProjection.selectionAfterCatalogRefresh("view:removed", options: groups.flatMap(\.options)) == "important", "legacy saved-View removal retains its existing Important fallback contract")
    check("NAV-B-current-saved-view-selection", NativeMailboxProjection.selectionAfterCatalogRefresh("view:same", options: groups.flatMap(\.options)) == "view:same", "a still-visible saved View never changes selection during refresh")
    check("NAV-B-missing-pin-selection-retained", NativeMailboxProjection.selectionAfterCatalogRefresh("pin:missing", options: groups.flatMap(\.options)) == "pin:missing", "new missing pin routes retain their explicit unavailable recovery surface")
    check("NAV-B-missing-collection-selection-retained", NativeMailboxProjection.selectionAfterCatalogRefresh("collection:missing", options: groups.flatMap(\.options)) == "collection:missing", "new missing collection routes are not silently reinterpreted as Important")
    check("NAV-B-focus-utility-distinct", groups[1].options.last?.id == "focus" && groups[1].options.last?.name == "Inbox focus" && groups[2].options.first?.id == "destination:opaque-focus", "attention-in-Inbox utility does not route as actual named Focus")
    let identity = catalog.collections[0].identity
    check("NAV-B-kinds-do-not-collide", identity.selectionID != NativeMailIdentity(kind: .savedView, opaqueID: "same").selectionID && identity.selectionID != NativeMailIdentity(kind: .pin, opaqueID: "same", accountID: "account").selectionID, "opaque IDs remain distinct across kinds")
    check("NAV-B-accounts-do-not-collide", identity.selectionID != NativeMailIdentity(kind: .collection, opaqueID: "same", accountID: "other").selectionID, "equal resource IDs in different accounts have distinct local identities")
    let suite = "bre457-catalog-" + UUID().uuidString, defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let prefs = MailboxPreferenceStore(defaults: defaults)
    prefs.save(["view:same", "unknown-old-choice"], scope: "origin|owner")
    prefs.saveHidden([identity.selectionID, "destination:opaque-focus", "unknown-hidden"], scope: "origin|owner")
    let reopened = MailboxPreferenceStore(defaults: defaults)
    check("NAV-B-local-hidden-reopen", reopened.loadHidden(scope: "origin|owner") == [identity.selectionID, "destination:opaque-focus", "unknown-hidden"] && reopened.load(scope: "origin|owner").contains("unknown-old-choice"), "additive hidden key retains old enabled choices and unknown IDs")
    check("NAV-B-local-hidden-owner-isolation", reopened.loadHidden(scope: "other-origin|owner").isEmpty && reopened.loadHidden(scope: "origin|other").isEmpty, "no browser/cross-device migration or email-based preference ownership")
    let hidden = prefs.loadHidden(scope: "origin|owner")
    let hiddenGroups = NativeMailboxProjection.groups(destinations: spaces.options, views: views, enabledIDs: [], hiddenIDs: hidden, catalog: catalog)
    let hiddenChoices = NativeMailboxProjection.hidden(destinations: spaces.options, views: views, enabledIDs: [], hiddenIDs: hidden, catalog: catalog)
    check("NAV-B-hidden-retains-fixed-mail", hiddenGroups[0].options.map(\.id) == ["important", "all"] && hiddenGroups[1].options.map(\.id) == ["normal"] && hiddenGroups[2].options.map(\.id) == ["destination:opaque-inbox"], "hidden collections/spaces never hide Important, All Mail, or Inbox")
    check("NAV-B-restore-preserves-name", hiddenChoices.contains { $0.id == identity.selectionID && $0.name == "Équipe / keep" } && hiddenChoices.contains { $0.id == "view:same" }, "hidden projection retains exact target names and legacy View visibility")
    var restored = hidden; restored.remove(identity.selectionID); prefs.saveHidden(restored, scope: "origin|owner")
    check("NAV-B-restore-retains-other-history", prefs.loadHidden(scope: "origin|owner").contains("unknown-hidden") && !prefs.loadHidden(scope: "origin|owner").contains(identity.selectionID), "Restore modifies only selected local visibility entry")
    var foreign = nativeCatalog(); foreign["workspaceId"] = "other"
    check("NAV-B-catalog-foreign-workspace", rejects(foreign), "response workspace must equal captured verified user")
    foreign = nativeCatalog(); foreign["accountIds"] = ["other"]
    check("NAV-B-catalog-foreign-account", rejects(foreign), "response account scope must equal selected owned account")
    foreign = nativeCatalog(); foreign["extra"] = true
    check("NAV-B-catalog-unknown-field", rejects(foreign), "strict top-level shape rejects unknown wire fields")
    foreign = nativeCatalog(); var collection = (foreign["collections"] as! [[String: Any]])[0]; collection["accountId"] = "other"; foreign["collections"] = [collection]
    check("NAV-B-catalog-foreign-child", rejects(foreign), "a foreign nested item cannot be published under an owned account")
    foreign = nativeCatalog(); foreign["collections"] = [collection, collection]
    check("NAV-B-catalog-duplicate-identity", rejects(foreign), "ambiguous catalog identities reject the whole section")
    for mailbox in ["inbox", "focus", "quiet", "hidden", "all"] {
        let target = try NativePinTarget(nativeJSON(["type": "resource", "resource": ["family": "view", "id": mailbox]]))
        if case .mailbox(let actual) = target { check("NAV-B-pin-legacy-\(mailbox)", actual.rawValue == mailbox, "legacy enum is not a saved View or named destination") }
        else { check("NAV-B-pin-legacy-\(mailbox)", false, "wrong target kind") }
    }
    for (family, id) in [("thread", "same"), ("collection", "same"), ("sender", "needle+nav@example.com")] {
        let target = try NativePinTarget(nativeJSON(["type": "resource", "resource": ["family": family, "id": id]]))
        let matched: Bool
        switch target { case .thread(let value): matched = family == "thread" && value == id
        case .collection(let value): matched = family == "collection" && value == id
        case .sender(let value): matched = family == "sender" && value == id
        default: matched = false }
        check("NAV-B-pin-resource-\(family)", matched, "typed resource ID retained without title parsing or domain expansion")
    }
    check("NAV-B-pin-rejects-view-ID", (try? NativePinTarget(nativeJSON(["type": "resource", "resource": ["family": "view", "id": "view:same"]]))) == nil, "wire view-family accepts legacy enum only")
    check("NAV-B-pin-rejects-unknown-kind", (try? NativePinTarget(nativeJSON(["type": "resource", "resource": ["family": "url", "id": "https://example.com"]]))) == nil, "no incoming URL authority is inferred")
    check("NAV-B-intent-rejects-utility-type-spoof", !NativeMailIdentity(kind: .utility, opaqueID: "destination:foreign").validForInternalNavigation, "a typed utility intent cannot smuggle a saved-target selection namespace")
    check("NAV-B-intent-rejects-unowned-shape", !NativeMailIdentity(kind: .collection, opaqueID: "same").validForInternalNavigation, "account-scoped targets require an explicit captured account")
    check("NAV-B-intent-rejects-empty-opaque-ID", !NativeMailIdentity(kind: .pin, opaqueID: "", accountID: "account").validForInternalNavigation, "no empty/guessed target is turned into a default destination")
    let query = try NativeSavedQuery(nativeJSON(nativeQueryValue()))
    check("NAV-B-query-schema-object-revisions", query.revision == 9 && query.definition.profile == "stored-mail-v1", "object revision9 is distinct from schema1")
    let composed = NativeMailIdentity(kind: .space, opaqueID: "é"), decomposed = NativeMailIdentity(kind: .space, opaqueID: "e\u{0301}")
    check("NAV-B-opaque-identity-UTF8", composed != decomposed, "opaque resource identity uses bytes, not Unicode display-name equivalence")
    let context = NativeMailContext(origin: "https://example.invalid", userID: "owner", accountID: "account", connection: UUID(), ownedAccountIDs: ["account", "other"])
    let accented = NativeMailContext(origin: context.origin, userID: "é", accountID: context.accountID, connection: context.connection, ownedAccountIDs: context.ownedAccountIDs)
    check("NAV-B-owner-identity-UTF8", accented != NativeMailContext(origin: accented.origin, userID: "e\u{0301}", accountID: accented.accountID, connection: accented.connection, ownedAccountIDs: accented.ownedAccountIDs), "verified user IDs are opaque, even when display strings are canonically equivalent")
    let source = NativeMailBackContext(context: context, selection: "view:same", readerAccount: "other")
    let current = NativeMailContext(origin: context.origin, userID: context.userID, accountID: "other", connection: context.connection, ownedAccountIDs: ["account", "other"])
    check("NAV-B-back-owned-source", source.mayRestore(current: current, currentReaderAccount: "other"), "cross-account reader can return to still-owned source without changing its query")
    check("NAV-B-back-new-session-rejected", !source.mayRestore(current: .init(origin: current.origin, userID: current.userID, accountID: current.accountID, connection: UUID(), ownedAccountIDs: current.ownedAccountIDs), currentReaderAccount: "other"), "same-owner reconnect is a new connection epoch")
    check("NAV-B-back-removed-source-rejected", !source.mayRestore(current: .init(origin: current.origin, userID: current.userID, accountID: current.accountID, connection: current.connection, ownedAccountIDs: ["other"]), currentReaderAccount: "other"), "Back never resurrects a disconnected source account")
    check("NAV-B-back-explicit-account-switch-rejected", !source.mayRestore(current: current, currentReaderAccount: "account"), "an explicit newer account choice is not overwritten")
}

@MainActor func runNativeCatalogControllerCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    let context = NativeMailContext(origin: "https://example.invalid", userID: "owner", accountID: "account", connection: UUID(), ownedAccountIDs: ["account"])
    let query = try NativeSavedQuery(nativeJSON(nativeQueryValue()))
    let route = NativeMailRoute(identity: .init(kind: .pin, opaqueID: "pin", accountID: "account"), title: "Pin", subtitle: "Saved query", revision: 3, provenance: query.definition.digest, target: .query(query))
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
    let client = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { "synthetic-owned" }
    func store(_ label: String) -> CacheStore { CacheStore(directory: cacheRoot.appending(path: label)) }
    do {
        let reader = NativeMailResults(); var actualPath = "", actualItems = [URLQueryItem]()
        ReviewURLProtocol.handler = { request in
            actualPath = request.url!.path; actualItems = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
            return (200, try ReviewRegressions.json(nativePage(query: query)))
        }
        await reader.load(route: route, context: context, client: client, cache: store("transport"), readRevision: "initial", isCurrent: { true })
        check("NAV-B-query-transport-contract", actualPath == "/v1/organization/collections-pins/queries/query/results" && Set(actualItems.map(\.name)) == ["accountId", "limit"] && actualItems.first(where: { $0.name == "accountId" })?.value == "account" && actualItems.first(where: { $0.name == "limit" })?.value == "30" && reader.messages.map(\.id) == ["row"], "only published by-ID/account/limit inputs; no guessed filter/query definition parameters")
    }
    for failure in [(400, "unrelated_validation"), (401, "unauthorized"), (403, "forbidden"), (404, "not_found"), (422, "invalid_saved_query"), (503, "mailbox_unavailable")] {
        let reader = NativeMailResults(), cache = store("error-\(failure.0)")
        var requests = 0
        ReviewURLProtocol.handler = { _ in
            requests += 1
            return requests == 1 ? (200, try ReviewRegressions.json(nativePage(query: query))) : (failure.0, try ReviewRegressions.json(["error": ["code": failure.1, "message": "Synthetic failure"]]))
        }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        check("NAV-B-page-error-\(failure.0)-precondition", reader.messages.map(\.id) == ["row"] && reader.nextCursor == "opaque-next", "establish an accepted owned first page and opaque continuation")
        await reader.load(route: route, context: context, client: client, cache: cache, reset: false, readRevision: "initial", isCurrent: { true })
        let clears = [401, 403, 404, 422].contains(failure.0)
        check("NAV-B-page-error-\(failure.0)-no-restart", requests == 2 && reader.error != nil && (clears ? reader.messages.isEmpty && reader.nextCursor == nil : reader.messages.map(\.id) == ["row"] && reader.nextCursor == "opaque-next"), "only typed invalid_cursor may restart; auth/missing/invalid definition clear while ordinary partial failure retains rows/cursor")
    }
    for restartFails in [false, true] {
        let reader = NativeMailResults(), cache = store("cursor-\(restartFails)")
        var cursors = [String?]()
        ReviewURLProtocol.handler = { request in
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
            cursors.append(cursor)
            if cursor != nil { return (400, try ReviewRegressions.json(["error": ["code": "invalid_cursor", "message": "Synthetic revision changed"]])) }
            if cursors.count > 1 && restartFails { return (503, try ReviewRegressions.json(["error": ["code": "mailbox_unavailable", "message": "Synthetic unavailable"]])) }
            return (200, try ReviewRegressions.json(nativePage(query: query, row: cursors.count == 1 ? "old" : "fresh", cursor: cursors.count == 1 ? "opaque-next" : nil)))
        }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        await reader.load(route: route, context: context, client: client, cache: cache, reset: false, readRevision: "initial", isCurrent: { true })
        check("NAV-B-invalid-cursor-once-\(restartFails)", cursors.count == 3 && cursors[0] == nil && cursors[1] == "opaque-next" && cursors[2] == nil && reader.nextCursor == nil && reader.messages.map(\.id) == [restartFails ? "old" : "fresh"] && (restartFails ? reader.error != nil : reader.error == nil), "one cursor-free restart; failed restart stops with truthful accepted partial rows")
    }
    let mutations: [(String, ([String: Any]) -> [String: Any])] = [
        ("unknown-top", { var v = $0; v["invented"] = true; return v }),
        ("wrong-id", { var v = $0, q = v["query"] as! [String: Any]; q["id"] = "other"; v["query"] = q; return v }),
        ("wrong-account", { var v = $0, q = v["query"] as! [String: Any]; q["accountId"] = "other"; v["query"] = q; return v }),
        ("wrong-revision", { var v = $0, q = v["query"] as! [String: Any]; q["revision"] = 10; v["query"] = q; return v }),
        ("wrong-digest", { var v = $0, q = v["query"] as! [String: Any]; q["definitionDigest"] = String(repeating: "b", count: 64); v["query"] = q; return v }),
        ("wrong-profile", { var v = $0, q = v["query"] as! [String: Any]; q["evaluationProfile"] = "legacy-pin-v1"; v["query"] = q; return v }),
        ("unknown-query-field", { var v = $0, q = v["query"] as! [String: Any]; q["extra"] = true; v["query"] = q; return v }),
        ("two-accounts", { var v = $0; v["accounts"] = [nativeAccount(), nativeAccount("other")]; return v }),
        ("foreign-row", { var v = $0; v["messages"] = [nativeRow(account: "other")]; return v }),
        ("wrong-provider", { var v = $0, row = nativeRow(); row["provider"] = "outlook"; v["messages"] = [row]; return v }),
        ("duplicate-rows", { var v = $0; v["messages"] = [nativeRow(), nativeRow()]; return v }),
        ("unknown-row-field", { var v = $0, row = nativeRow(); row["extra"] = true; v["messages"] = [row]; return v }),
        ("unknown-account-field", { var v = $0, account = nativeAccount(); account["extra"] = true; v["accounts"] = [account]; return v }),
        ("unknown-capability", { var v = $0, account = nativeAccount(); account["capabilities"] = ["read": true, "send": true, "draft": true, "admin": true]; v["accounts"] = [account]; return v }),
        ("bad-freshness", { var v = $0; v["freshness"] = ["revision": "invented", "lastSyncedAt": NSNull()]; return v }),
        ("empty-cursor", { var v = $0; v["nextCursor"] = ""; return v }),
        ("oversized-page", { var v = $0; v["messages"] = (0..<31).map { nativeRow("row-\($0)") }; return v })
    ]
    for (name, mutation) in mutations {
        let reader = NativeMailResults(), cache = store("malformed-" + name)
        var requests = 0
        ReviewURLProtocol.handler = { _ in requests += 1; return (200, try ReviewRegressions.json(requests == 1 ? nativePage(query: query) : mutation(nativePage(query: query)))) }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        let precondition = reader.messages.map(\.id) == ["row"]
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        check("NAV-B-strict-response-" + name, precondition && requests == 2 && reader.messages.isEmpty && reader.nextCursor == nil && reader.error != nil, "a valid prior page cannot make malformed/foreign/changed metadata publishable or authorise cache recovery")
    }
    do {
        let reader = NativeMailResults(), cache = store("offline")
        var status = 200
        ReviewURLProtocol.handler = { _ in status == 200 ? (200, try ReviewRegressions.json(nativePage(query: query))) : (status, try ReviewRegressions.json(["error": ["code": "synthetic", "message": "unavailable"]])) }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true }); status = 503
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        check("NAV-B-offline-first-page-no-cursor", reader.offline && reader.messages.map(\.id) == ["row"] && reader.nextCursor == nil && reader.error?.hasPrefix("Offline") == true, "validated owned first page is explicitly stale and cannot reuse cached continuation")
        status = 401
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true }); status = 503
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        check("NAV-B-rejected-scope-no-cache-resurrection", reader.messages.isEmpty && !reader.offline, "401 retires this new reader's scope cache; a later503 cannot resurrect its rows")
        let newConnection = NativeMailContext(origin: context.origin, userID: context.userID, accountID: context.accountID, connection: UUID(), ownedAccountIDs: context.ownedAccountIDs)
        await reader.load(route: route, context: newConnection, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        check("NAV-B-relogin-no-old-cache", reader.messages.isEmpty && !reader.offline, "same user with a new real connection epoch cannot use a previous session's cache or cursor")
    }
    do {
        let reader = NativeMailResults(), cache = store("dedup")
        var count = 0
        ReviewURLProtocol.handler = { _ in
            count += 1; var response = nativePage(query: query, cursor: count == 1 ? "opaque-next" : nil)
            if count > 1 { response["messages"] = [nativeRow(), nativeRow("next")] }
            return (200, try ReviewRegressions.json(response))
        }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        await reader.load(route: route, context: context, client: client, cache: cache, reset: false, readRevision: "initial", isCurrent: { true })
        await reader.load(route: route, context: context, client: client, cache: cache, reset: false, readRevision: "initial", isCurrent: { true })
        check("NAV-B-pagination-dedup-exhaustion", reader.messages.map(\.id) == ["row", "next"] && reader.nextCursor == nil && count == 2, "dedup against the accepted page; exhausted repeated Load more sends no third request")
    }
    for boundary in ["account", "owner", "connection", "logout", "client", "origin"] {
        let reader = NativeMailResults(), cache = store("held-" + boundary), hold = SearchRequestHold()
        let heldClient = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { await hold.token() }
        var currentContext: NativeMailContext? = context, currentClient = heldClient, dispatches = 0
        ReviewURLProtocol.handler = { _ in dispatches += 1; return (200, try ReviewRegressions.json(nativePage(query: query))) }
        let pending = Task { await reader.load(route: route, context: context, client: heldClient, cache: cache, readRevision: "initial", isCurrent: { currentContext == context && currentClient === heldClient }) }
        await hold.waitUntilHeld()
        switch boundary {
        case "origin": await heldClient.updateBaseURL(URL(string: "https://foreign.invalid")!)
        case "account": currentContext = .init(origin: context.origin, userID: context.userID, accountID: "other", connection: context.connection, ownedAccountIDs: ["account", "other"])
        case "owner": currentContext = .init(origin: context.origin, userID: "other", accountID: context.accountID, connection: context.connection, ownedAccountIDs: context.ownedAccountIDs)
        case "connection": currentContext = .init(origin: context.origin, userID: context.userID, accountID: context.accountID, connection: UUID(), ownedAccountIDs: context.ownedAccountIDs)
        case "client": currentClient = client
        default: currentContext = nil
        }
        await hold.release(); await pending.value
        check("NAV-B-held-token-" + boundary, dispatches == 0 && reader.messages.isEmpty, "captured context plus original canonical origin is checked again after credential lookup, before dispatch")
    }
    do {
        let browser = NativeMailBrowser(), cache = store("optional-sections")
        ReviewURLProtocol.handler = { request in request.url!.path == "/v1/destinations" ? (503, try ReviewRegressions.json(["error": ["code": "synthetic", "message": "unavailable"]])) : (200, try ReviewRegressions.json(nativeCatalog())) }
        await browser.load(context: context, client: client, cache: cache, isCurrent: { true })
        let groups = NativeMailboxProjection.groups(destinations: [], views: [], enabledIDs: [], hiddenIDs: [], catalog: browser.catalog)
        check("NAV-B-optional-spaces-failure-independent", browser.spaceError != nil && browser.catalog?.collections.first?.id == "same" && groups[0].options.map(\.id) == ["important", "all"], "a failed optional section leaves successful catalog, fixed Important and All Mail available")
        let failedSpaces = browser.settingsSection("spaces"), goodCatalog = browser.settingsSection("collections")
        check("NAV-B-settings-spaces-error-visible", failedSpaces.message == browser.spaceError && failedSpaces.message != nil && !failedSpaces.canShowEmpty && goodCatalog.message == nil, "actual independent 503 remains visible in Settings instead of being described as an empty resolved section")
        ReviewURLProtocol.handler = { request in request.url!.path == "/v1/destinations" ? (200, try ReviewRegressions.json(nativeRouting())) : (403, try ReviewRegressions.json(["error": ["code": "synthetic", "message": "forbidden"]])) }
        await browser.load(context: context, client: client, cache: cache, isCurrent: { true })
        check("NAV-B-optional-catalog-failure-independent", browser.catalog == nil && browser.spaces?.options.count == 2 && browser.catalogError != nil, "403 clears inaccessible collections/pins while real Space choices remain")
        let failedCatalog = browser.settingsSection("pins"), goodSpaces = browser.settingsSection("spaces")
        check("NAV-B-settings-catalog-error-visible", failedCatalog.message == browser.catalogError && failedCatalog.message != nil && !failedCatalog.canShowEmpty && goodSpaces.message == nil, "actual inaccessible catalog is disclosed independently of successful Space choices")
    }
    do {
        let browser = NativeMailBrowser(), cache = store("settings-status"), hold = SearchRequestHold()
        let heldClient = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { await hold.token() }
        ReviewURLProtocol.handler = { request in (200, try ReviewRegressions.json(request.url!.path == "/v1/destinations" ? nativeRouting() : nativeCatalog())) }
        let pending = Task { await browser.load(context: context, client: heldClient, cache: cache, isCurrent: { true }) }
        await hold.waitUntilHeld()
        let loading = browser.settingsSection("spaces")
        check("NAV-B-settings-loading-not-empty", browser.loading && loading.loading && !loading.canShowEmpty, "actual suspended catalog load is presented as loading rather than a successful empty list")
        await hold.release(); await pending.value
        ReviewURLProtocol.handler = { _ in (503, try ReviewRegressions.json(["error": ["code": "synthetic", "message": "unavailable"]])) }
        await browser.load(context: context, client: client, cache: cache, isCurrent: { true })
        let stale = browser.settingsSection("collections")
        check("NAV-B-settings-stale-cache-warning", browser.staleCatalog && browser.catalog?.collections.first?.id == "same" && stale.message == browser.catalogError && stale.message?.hasPrefix("Offline") == true && !stale.canShowEmpty, "actual cached catalog remains available with its explicit stale warning in Settings")
    }
    for source in ["destination:opaque-focus", "collection:opaque-owned", "pin:opaque-owned"] {
        let state = AppState(cache: store("query-" + source)); state.client = client
        let model = InboxViewModel(); var queries = [String]()
        ReviewURLProtocol.handler = { request in
            let q = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "query" }?.value ?? ""
            queries.append(q); return (200, try ReviewRegressions.json(nativePage(row: q, cursor: nil)))
        }
        model.search = "A"; await model.loadPrimaryMail(state: state, mailboxView: source, event: .submit)
        model.search = "B"; await model.loadPrimaryMail(state: state, mailboxView: source, event: .refresh)
        check("NAV-B-source-search-A-B-" + source.components(separatedBy: ":")[0], queries == ["A", "A"] && model.resultSearch == "A" && model.search == "B" && model.messages.first?.id == "A" && !model.showsSavedMailboxResults(hasSavedView: true), "every new source explicitly searches All Mail; refresh preserves submitted A, unfinished B and the pending-search surface policy")
    }
    do {
        let state = AppState(cache: store("dirty-settings")), preferences = AccountPreferencesController()
        state.ownerScope = context.owner; state.mailConnectionGeneration = context.connection; state.accountPreferences = preferences
        preferences.edits = .init(signature: "Keep my edits", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false)
        let intent = NativeMailIntent(identity: .init(kind: .collection, opaqueID: "same", accountID: "account"), context: context)
        state.routeMailbox(intent)
        check("NAV-B-settings-intent-stay-guard", state.selectedTab == "settings" && state.routedMailbox == nil && state.pendingSettingsNavigation != nil && preferences.dirty, "typed native intents use the same real dirty-Settings guard")
        state.stayInSettings(); state.routeMailbox(intent); state.discardSettingsAndLeave()
        check("NAV-B-settings-intent-explicit-leave", state.selectedTab == "inbox" && state.routedMailbox?.identity == intent.identity && !preferences.dirty, "explicit discard routes the originally captured owned target")
        state.selectedTab = "settings"; state.routedMailbox = nil
        // discard() above restored saved=nil. Establish a real new edit rather
        // than optional-chaining into that nil snapshot and skipping the guard.
        preferences.edits = .init(signature: "New unsaved", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false)
        state.routeMailbox(intent)
        check("NAV-B-settings-intent-session-precondition", preferences.dirty && state.pendingSettingsNavigation != nil && state.routedMailbox == nil, "a real new edit and captured pending intent precede the connection change")
        state.mailConnectionGeneration = UUID(); state.discardSettingsAndLeave()
        check("NAV-B-settings-intent-session-change", state.routedMailbox == nil && state.selectedTab == "settings" && preferences.dirty, "delayed Leave cannot discard or route a superseded connection's target")
    }
}

@MainActor func runNativeCatalogAPICases(connection: ReviewRegressions.Connection, cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    let client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
    let auth: AuthSession = try await client.request("v1/auth/session")
    let accounts = try await client.accounts()
    guard auth.isAuthenticated, let owner = auth.user?.id, accounts.contains(where: { $0.id == "account" }) else { throw NativeMailJSON.invalid() }
    let context = NativeMailContext(origin: await client.serverOrigin(), userID: owner, accountID: "account", connection: UUID(), ownedAccountIDs: Set(accounts.map(\.id)))
    let before: MailActionJSON = try await client.request("__bre457/navigation/state")
    let browser = NativeMailBrowser(), cache = CacheStore(directory: cacheRoot)
    await browser.load(context: context, client: client, cache: cache, isCurrent: { true })
    guard let catalog = browser.catalog, let spaces = browser.spaces else {
        check("NAV-B-API-catalog-precondition", false, "strict actual catalog failed: \(browser.catalogError ?? "none") / \(browser.spaceError ?? "none")"); return
    }
    check("NAV-B-API-catalog-precondition", catalog.workspaceID == owner && catalog.collections.contains { $0.id == "nav-collection" } && catalog.pins.count >= 10, "production browser decodes actual owned API/SQLite catalog after historical baseline bootstrap")
    check("NAV-B-API-named-spaces", spaces.options.contains { $0.id.hasPrefix("destination:") && $0.name == "Focus" } && spaces.options.contains { $0.name == "Inbox" }, "actual named Focus/Inbox coexist with the separate local Inbox-focus utility")
    for pin in catalog.pins.filter({ $0.id.hasPrefix("nav-pin-") }) {
        guard let route = NativeMailRoute.pin(pin, catalog: catalog) else { check("NAV-B-API-route-" + pin.id, false, "typed target was not resolved"); continue }
        if case .thread(let id) = route.target {
            let detail: ThreadDetail = try await client.request("v1/threads", pathSuffix: [id], query: [.init(name: "accountId", value: context.accountID)], headers: ["x-orca-image-version": "2", "x-orca-importance-version": "1"])
            check("NAV-B-API-route-" + pin.id, detail.thread.id == "nav-thread-archived" && detail.account.id == context.accountID, "direct owned thread GET, independent of current Inbox summaries")
        } else {
            let reader = NativeMailResults()
            await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
            let ids = Set(reader.messages.filter { $0.id.hasPrefix("nav-mail-") }.map(\.id))
            let expected: Set<String>
            switch pin.target {
            case .query, .collection, .sender: expected = ["nav-mail-archived", "nav-mail-quiet"]
            case .mailbox(.inbox): expected = ["nav-mail-inbox", "nav-mail-focus"]
            case .mailbox(.focus): expected = ["nav-mail-focus"]
            case .mailbox(.quiet): expected = ["nav-mail-quiet"]
            case .mailbox(.hidden): expected = []
            case .mailbox(.all): expected = ["nav-mail-inbox", "nav-mail-focus", "nav-mail-quiet", "nav-mail-archived"]
            case .thread: expected = []
            }
            check("NAV-B-API-route-" + pin.id, reader.error == nil && ids == expected && reader.messages.allSatisfy { $0.accountId == context.accountID }, "actual production resolver/controller reads exact owned rows under the target's real API semantics; query metadata/digest/profile checked, no provider fallback")
        }
    }
    let golden: MailActionJSON = try await client.request("__bre457/navigation/golden")
    for (index, vector) in try NativeMailJSON.array(golden["valid"]).enumerated() {
        let definition = try NativeSavedQueryDefinition(vector["input"])
        check("NAV-B-canonical-JS-Swift-\(index)", definition.canonical == vector["canonical"].text && definition.digest == vector["digest"].text && definition.profile == vector["profile"].text, "actual published Zod normalization + server canonicalizer + Node SHA256 versus production Swift normalization/canonical UTF8/CryptoKit; includes Unicode/escaping/defaults/profile/UTF16 boundaries")
    }
    for (index, vector) in try NativeMailJSON.array(golden["invalid"]).enumerated() {
        check("NAV-B-canonical-negative-\(index)", (try? NativeSavedQueryDefinition(vector)) == nil, "same input was rejected by the actual published JS schema before Swift comparison")
    }
    let after: MailActionJSON = try await client.request("__bre457/navigation/state")
    check("NAV-B-API-domain-read-only", before["readDomainDML"].integer == after["readDomainDML"].integer && before["membershipCount"].integer == after["membershipCount"].integer && before["queryCount"].integer == after["queryCount"].integer && before["pinCount"].integer == after["pinCount"].integer, "independent SQLite connections and original counts unchanged across new production GETs; bootstrap/session renewal reported separately")
    check("NAV-B-API-provider-zero", after["providerClientCalls"].integer == 0 && after["outboundNetworkCalls"].integer == 0 && (after["readRequests"].integer ?? 0) > (before["readRequests"].integer ?? 0), "nonzero actual read work with zero provider client/outbound calls; not physical provider evidence")
}

private final class NativeDelayedReadProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var gate: NativeReadReplyGate?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Task { await Self.gate?.receive(self) } }
    override func stopLoading() {}
    func finish(_ data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}
private actor NativeReadReplyGate {
    private var first: NativeDelayedReadProtocol?
    private var started: CheckedContinuation<Void, Never>?
    private var requests = 0
    let next: Data
    init(next: Data) { self.next = next }
    func receive(_ request: NativeDelayedReadProtocol) {
        requests += 1
        if requests == 1 { first = request; started?.resume(); started = nil } else { request.finish(next) }
    }
    func wait() async { if first == nil { await withCheckedContinuation { started = $0 } } }
    func release(_ original: Data) { first?.finish(original); first = nil }
    func count() -> Int { requests }
}
private actor NativeCacheReadGate {
    private var held = false
    private var started: CheckedContinuation<Void, Never>?
    private var releaseContinuation: CheckedContinuation<Void, Never>?
    func load(_ cache: CacheStore, key: String) async -> MailActionJSON? {
        let raw = await cache.load(MailActionJSON.self, key: key)
        held = true; started?.resume(); started = nil
        await withCheckedContinuation { releaseContinuation = $0 }
        return raw
    }
    func wait() async { if !held { await withCheckedContinuation { started = $0 } } }
    func release() { releaseContinuation?.resume(); releaseContinuation = nil }
}

@MainActor func runNativeCatalogHeldCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    let context = NativeMailContext(origin: "https://example.invalid", userID: "owner", accountID: "account", connection: UUID(), ownedAccountIDs: ["account"])
    let query = try NativeSavedQuery(nativeJSON(nativeQueryValue()))
    let route = NativeMailRoute(identity: .init(kind: .pin, opaqueID: "pin", accountID: "account"), title: "Keep source", subtitle: "Saved query", revision: 3, provenance: query.definition.digest, target: .query(query))
    let cache = CacheStore(directory: cacheRoot)
    do {
        let reader = NativeMailResults(), gate = NativeReadReplyGate(next: try ReviewRegressions.json(nativePage(query: query, row: "new", cursor: nil)))
        NativeDelayedReadProtocol.gate = gate
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NativeDelayedReadProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel(); NativeDelayedReadProtocol.gate = nil }
        let client = APIClient(baseURL: URL(string: context.origin)!, session: session) { "owned" }
        var current = context
        let old = Task { await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { current == context }) }
        await gate.wait()
        current = .init(origin: context.origin, userID: context.userID, accountID: context.accountID, connection: UUID(), ownedAccountIDs: context.ownedAccountIDs)
        let replacement = current
        await reader.load(route: route, context: replacement, client: client, cache: cache, readRevision: "initial", isCurrent: { current == replacement })
        let beforeOld = reader.messages.map(\.id)
        await gate.release(try ReviewRegressions.json(nativePage(query: query, row: "old", cursor: nil))); await old.value
        let count = await gate.count()
        check("NAV-B-held-response-cannot-overwrite-session", count == 2 && beforeOld == ["new"] && reader.messages.map(\.id) == ["new"], "a real URLSession response is held after dispatch; newer connection publishes first and late old response cannot overwrite/cache it")
    }
    do {
        let gate = NativeCacheReadGate(), reader = NativeMailResults(loadCachedPage: { cache, key in await gate.load(cache, key: key) })
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
        let client = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { "owned" }
        ReviewURLProtocol.handler = { _ in (200, try ReviewRegressions.json(nativePage(query: query))) }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        let cachedPrecondition = reader.messages.map(\.id) == ["row"]
        ReviewURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        var current: NativeMailContext? = context
        let pending = Task { await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { current == context }) }
        await gate.wait(); current = nil; reader.invalidate(); await gate.release(); await pending.value
        check("NAV-B-held-cache-cannot-restore-after-logout", cachedPrecondition && reader.messages.isEmpty && !reader.offline, "actual saved first-page cache read suspends, then logout invalidates before the data returns; no stale publication")
    }
}

@MainActor func runNativeCatalogBoundaryCases(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    let context = NativeMailContext(origin: "https://example.invalid", userID: "owner", accountID: "account", connection: UUID(), ownedAccountIDs: ["account"])
    let query = try NativeSavedQuery(nativeJSON(nativeQueryValue()))
    let route = NativeMailRoute(identity: .init(kind: .pin, opaqueID: "pin", accountID: "account"), title: "Keep query", subtitle: "Saved query", revision: 3, provenance: query.definition.digest, target: .query(query))
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [ReviewURLProtocol.self]
    do {
        let preflight = SearchRequestHold(), token = SearchRequestHold()
        let client = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { await token.token() }
        var dispatchedOrigin: String?
        ReviewURLProtocol.handler = { request in dispatchedOrigin = request.url!.host; return (200, try ReviewRegressions.json(["ok": true])) }
        let pending = Task { () throws -> MailActionJSON in
            try await client.request("v1/inbox", authorize: { _ = await preflight.token(); return true })
        }
        await preflight.waitUntilHeld(); await client.updateBaseURL(URL(string: "https://foreign.invalid")!); await preflight.release()
        await token.waitUntilHeld(); await client.updateBaseURL(URL(string: context.origin)!); await token.release()
        _ = try await pending.value
        check("NAV-B-authorized-URL-origin-ABA", dispatchedOrigin == "example.invalid", "URL is captured before the first authorization suspension; foreign-then-original actor URL changes cannot leave a foreign endpoint behind an otherwise valid post-token origin check")
    }
    do {
        let client = APIClient(baseURL: URL(string: context.origin)!, session: URLSession(configuration: config)) { "owned" }
        let reader = NativeMailResults(), cache = CacheStore(directory: cacheRoot)
        var count = 0
        ReviewURLProtocol.handler = { _ in count += 1; return (200, try ReviewRegressions.json(nativePage(query: query, row: count == 1 ? "first" : "second", freshness: String(repeating: count == 1 ? "a" : "b", count: 64)))) }
        await reader.load(route: route, context: context, client: client, cache: cache, readRevision: "initial", isCurrent: { true })
        let precondition = reader.messages.map(\.id) == ["first"]
        await reader.load(route: route, context: context, client: client, cache: cache, reset: false, readRevision: "initial", isCurrent: { true })
        check("NAV-B-query-freshness-cannot-mix-pages", precondition && count == 2 && reader.messages.isEmpty && reader.nextCursor == nil && reader.requiresCatalogReload, "even a200 continuation cannot mix rows from a different mailbox revision under the accepted page")
    }
}

private final class NativeForeignReadProtocol: URLProtocol {
    nonisolated(unsafe) static var data = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: URL(string: "https://foreign.invalid/v1/inbox")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@MainActor func runNativeCatalogResponseOriginCase(cacheRoot: URL, check: @MainActor (String, Bool, String) -> Void) async throws {
    let context = NativeMailContext(origin: "https://example.invalid", userID: "owner", accountID: "account", connection: UUID(), ownedAccountIDs: ["account"])
    let query = try NativeSavedQuery(nativeJSON(nativeQueryValue()))
    let route = NativeMailRoute(identity: .init(kind: .pin, opaqueID: "pin", accountID: "account"), title: "Keep query", subtitle: "Saved query", revision: 3, provenance: query.definition.digest, target: .query(query))
    NativeForeignReadProtocol.data = try ReviewRegressions.json(nativePage(query: query))
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [NativeForeignReadProtocol.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel(); NativeForeignReadProtocol.data = Data() }
    let client = APIClient(baseURL: URL(string: context.origin)!, session: session) { "owned" }
    let reader = NativeMailResults()
    await reader.load(route: route, context: context, client: client, cache: CacheStore(directory: cacheRoot), readRevision: "initial", isCurrent: { true })
    check("NAV-B-foreign-final-response-rejected", reader.messages.isEmpty && reader.error != nil && reader.nextCursor == nil, "even matching metadata cannot make a synthetic foreign-origin HTTP200 publishable; this is response-boundary validation, not a live redirect execution")
}
