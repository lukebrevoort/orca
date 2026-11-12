import Foundation

/// Tests the production projection used by MailboxViews; not a SwiftUI render.
@MainActor func runNavigationProjectionBaselineCases(check: (String, Bool, String) -> Void) throws {
    let routing = try JSONDecoder().decode(MailActionJSON.self, from: ReviewRegressions.json([
        "legacyDestinationIds": ["normal": "opaque-inbox", "focus": "opaque-focus"],
        "destinations": [
            ["id": "custom-z", "name": "Équipe / retained first", "retiredAt": NSNull()],
            ["id": "opaque-focus", "name": "My named Focus", "retiredAt": NSNull()],
            ["id": "opaque-inbox", "name": "My named Inbox", "retiredAt": NSNull()],
            ["id": "custom-a", "name": "Focus", "retiredAt": NSNull()],
            ["id": "retired", "name": "Retired", "retiredAt": "2026-11-01T00:00:00Z"]
        ]
    ]))
    let destinations = NativeMailboxProjection.destinations(routing: routing)!
    let views = [SavedMailboxView(id: "z", name: "Keep View Z", description: "", revision: 3), SavedMailboxView(id: "a", name: "Keep View A", description: "", revision: 2)]
    let enabled: Set<String> = ["focus", "all", "view:z", "view:a", "view:missing", "opaque-unknown"]
    let options = NativeMailboxProjection.options(destinations: destinations, views: views, enabledIDs: enabled)
    check("NAV-A-important-first", options.first?.id == "important", "used production projection keeps Important first")
    check("NAV-A-all-mail-permanent", NativeMailboxProjection.options(destinations: [], views: [], enabledIDs: []).contains { $0.id == "all" }, "empty/hidden catalog cannot remove All Mail")
    check("NAV-A-inbox-permanent", NativeMailboxProjection.options(destinations: [], views: [], enabledIDs: []).contains { $0.id == "normal" }, "current Inbox utility survives optional visibility choices")
    check("NAV-A-focus-utility-optional", options.contains { $0.id == "focus" } && !NativeMailboxProjection.options(destinations: [], views: [], enabledIDs: []).contains { $0.id == "focus" }, "old optional utility identity and visibility are preserved")
    check("NAV-A-custom-names-order", destinations.filter { $0.id.hasPrefix("destination:custom-") }.map(\.name) == ["Équipe / retained first", "Focus"], "server array order and literal names survive; not alphabetical/default reconstruction")
    check("NAV-A-view-names-order", options.filter { $0.id.hasPrefix("view:") }.map(\.name) == ["Keep View Z", "Keep View A"], "existing saved View order and names retained")
    check("NAV-A-hidden-view-excluded", !NativeMailboxProjection.options(destinations: [], views: views, enabledIDs: ["view:a"]).contains { $0.id == "view:z" }, "existing enabled-ID visibility remains authoritative")
    check("NAV-A-unknown-choice-retained", enabled.contains("opaque-unknown") && NativeMailboxProjection.unavailableIDs(enabledIDs: enabled, views: views) == ["view:missing"], "projection does not mutate the caller's choices; old unavailable-View policy unchanged")
    check("NAV-A-malformed-routing-keeps-prior", NativeMailboxProjection.destinations(routing: .null) == nil, "nil preserves the existing load path's prior destinations rather than replacing them with empty")
    check("NAV-A-retired-excluded", !destinations.contains { $0.id == "destination:retired" }, "retired destinations remain excluded")
    check("NAV-A-name-not-identity", destinations.contains { $0.id == "destination:custom-a" && $0.name == "Focus" }, "same display name alone does not trigger legacy-ID exclusion")
    check("NAV-A-focus-current-normal-destination", NativeMailboxRequestScope.destinationID(view: "focus", routing: routing) == "opaque-inbox", "behavior-preserving utility mapping; not actual named Focus browse")
    check("NAV-A-focus-current-api-view", NativeMailboxRequestScope.apiView(view: "focus", destinationID: "opaque-inbox") == "focus", "current API attention utility stays view=focus")
    check("NAV-A-inbox-current-api-view", NativeMailboxRequestScope.apiView(view: "normal", destinationID: "opaque-inbox") == "all", "resolved placement uses view=all plus destination")
    check("NAV-A-important-no-catalog", !NativeMailboxRequestScope.requiresDestinationCatalog(view: "important") && NativeMailboxRequestScope.destinationID(view: "important", routing: routing) == nil, "Important does not gain a destination intersection")
    check("NAV-A-all-mail-no-catalog", !NativeMailboxRequestScope.requiresDestinationCatalog(view: "all") && NativeMailboxRequestScope.destinationID(view: "all", routing: routing) == nil, "All Mail remains independent of destination hydration")
    check("NAV-A-opaque-destination-request", !NativeMailboxRequestScope.requiresDestinationCatalog(view: "destination:opaque-focus") && NativeMailboxRequestScope.destinationID(view: "destination:opaque-focus") == "opaque-focus" && NativeMailboxRequestScope.apiView(view: "destination:opaque-focus", destinationID: "opaque-focus") == "all", "explicit existing destination selection forwards opaque ID and view=all")
    check("NAV-A-unresolved-inbox-old-mapping", NativeMailboxRequestScope.requiresDestinationCatalog(view: "normal") && NativeMailboxRequestScope.apiView(view: "normal", destinationID: nil) == "normal", "extraction preserves unresolved-map behavior rather than fixing it silently")
    let suite = "bre457-navigation-baseline-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let preferences = MailboxPreferenceStore(defaults: defaults)
    preferences.save(enabled, scope: "https://a.invalid|owner-a")
    check("NAV-A-preference-exact-roundtrip", preferences.load(scope: "https://a.invalid|owner-a") == enabled && Set(defaults.stringArray(forKey: "mailboxViews|https://a.invalid|owner-a") ?? []) == enabled, "actual production store round-trips unknown IDs using the unchanged original key")
    check("NAV-A-preference-owner-isolated", preferences.load(scope: "https://a.invalid|owner-b") == Set(["focus", "all"]), "different owner receives original defaults, not A's configured View IDs")
    check("NAV-A-preference-origin-isolated", preferences.load(scope: "https://b.invalid|owner-a") == Set(["focus", "all"]), "different canonical origin does not inherit A's choices")
    // Intended feature-policy failures against the *used* old production projection.
    // They do not establish an Apple UI execution or missing collection/pin UI red.
    check("NAV-A-named-focus-preserved", destinations.contains { $0.id == "destination:opaque-focus" && $0.name == "My named Focus" }, "all active named Spaces must survive; old projection excludes this actual legacy Focus ID")
    check("NAV-A-named-inbox-preserved", destinations.contains { $0.id == "destination:opaque-inbox" && $0.name == "My named Inbox" }, "user-owned fallback name must survive in named Spaces; fixed utility label is not a substitute")
}

/// Raw APIClient HTTP controls only. No new native catalog/query model is claimed.
@MainActor func runNavigationAPIBaselineCases(connection: ReviewRegressions.Connection, check: (String, Bool, String) -> Void) async throws {
    let client = APIClient(baseURL: URL(string: connection.baseURL)!) { connection.token }
    let seeded: MailActionJSON = try await client.request("__bre457/navigation/seed", method: "POST")
    check("NAV-API-seed-precondition", seeded["seeded"].flag && (seeded["seedDML"].integer ?? 0) > 0, "test-only owned fixture seed is explicit DML, not a read-only endpoint claim")
    let catalog: MailActionJSON = try await client.request("v1/organization/collections-pins/query", query: [.init(name: "accountId", value: "account")])
    guard case .array(let collections) = catalog["collections"], case .array(let pins) = catalog["pins"], case .array(let queries) = catalog["queries"] else { throw APIClient.ClientError.invalidResponse }
    let navPins = pins.filter { $0["id"].text?.hasPrefix("nav-pin-") == true }
    check("NAV-API-owned-catalog", catalog["workspaceId"].text == "owner" && collections.contains { $0["id"].text == "nav-collection" && $0["accountId"].text == "account" && $0["name"].text == "Équipe / retained collection" }, "actual authenticated account-aware catalog, not legacy first-Gmail projection")
    check("NAV-API-pin-targets", navPins.count == 10 && Set(navPins.compactMap { $0["target"]["resource"]["family"].text }) == Set(["thread", "view", "collection", "sender"]) && navPins.filter { $0["target"]["type"].text == "query" }.count == 2, "actual typed resource targets and query references all present")
    check("NAV-API-pin-order-names", navPins.compactMap { $0["position"].integer } == Array(0..<10) && navPins.first?["label"].text == "Keep thread pin", "server order and literal pin labels retained")
    check("NAV-API-query-object-revisions", queries.contains { $0["id"].text == "nav-query-legacy" && $0["revision"].integer == 7 && $0["definition"]["revision"].integer == 1 } && queries.contains { $0["id"].text == "nav-query-stored" && $0["revision"].integer == 9 }, "schema and object revisions have different meanings")
    // Bootstrap is recorded separately. It is intentionally before the read-only window.
    let _: MailActionJSON = try await client.request("v1/destinations")
    let _: InboxPage = try await client.request("v1/inbox", query: [.init(name: "accountId", value: "account"), .init(name: "view", value: "all")])
    let _: MailActionJSON = try await client.request("__bre457/navigation/seal", method: "POST")
    let collection: InboxPage = try await client.request("v1/inbox", query: [.init(name: "accountId", value: "account"), .init(name: "view", value: "all"), .init(name: "collectionId", value: "nav-collection"), .init(name: "limit", value: "30")])
    check("NAV-API-collection-retained-mail", Set(collection.messages.map(\.id)) == Set(["nav-mail-archived", "nav-mail-quiet"]) && collection.messages.allSatisfy { $0.accountId == "account" }, "actual membership read includes archived/quiet retained mail independent of Inbox")
    for (id, profile, revision) in [("nav-query-legacy", "legacy-pin-v1", 7), ("nav-query-stored", "stored-mail-v1", 9)] {
        let first: MailActionJSON = try await client.request("v1/organization/collections-pins/queries", pathSuffix: [id, "results"], query: [.init(name: "accountId", value: "account"), .init(name: "limit", value: "1")])
        guard let cursor = first["nextCursor"].text, case .array(let firstRows) = first["messages"] else { throw APIClient.ClientError.invalidResponse }
        check("NAV-API-query-\(profile)-metadata", first["query"]["id"].text == id && first["query"]["accountId"].text == "account" && first["query"]["revision"].integer == revision && first["query"]["evaluationProfile"].text == profile && first["query"]["definitionDigest"].text?.count == 64 && first["freshness"]["revision"].text?.hasPrefix("mailbox-v") == true, "actual wire metadata only; no Swift canonical-digest matching claim in phase A")
        let second: MailActionJSON = try await client.request("v1/organization/collections-pins/queries", pathSuffix: [id, "results"], query: [.init(name: "accountId", value: "account"), .init(name: "limit", value: "1"), .init(name: "cursor", value: cursor)])
        guard case .array(let secondRows) = second["messages"] else { throw APIClient.ClientError.invalidResponse }
        check("NAV-API-query-\(profile)-opaque-pagination", firstRows.count == 1 && secondRows.count == 1 && Set((firstRows + secondRows).compactMap { $0["id"].text }) == Set(["nav-mail-archived", "nav-mail-quiet"]) && second["nextCursor"].text == nil && second["query"]["definitionDigest"].text == first["query"]["definitionDigest"].text, "same opaque cursor/limit, no generated definition query params, distinct exact owned rows")
    }
    let thread: MailActionJSON = try await client.request("v1/threads", pathSuffix: ["nav-thread-archived"], query: [.init(name: "accountId", value: "account")])
    check("NAV-API-thread-pin-direct", thread["thread"]["id"].text == "nav-thread-archived", "direct owned thread GET works without finding it in loaded Inbox rows")
    let senderProbe = SyntheticSenderRequestProbe(baseURL: URL(string: connection.baseURL)!)
    let senderTransport = URLSession(configuration: .ephemeral, delegate: senderProbe, delegateQueue: nil)
    defer { senderTransport.invalidateAndCancel() }
    let senderClient = APIClient(baseURL: URL(string: connection.baseURL)!, session: senderTransport) { connection.token }
    let sender: InboxPage = try await senderClient.request("v1/inbox", query: [.init(name: "accountId", value: "account"), .init(name: "view", value: "all"), .init(name: "sender", value: "needle+nav@example.com")])
    check("NAV-API-sender-substring-scope", Set(sender.messages.map(\.id)) == Set(["nav-mail-archived", "nav-mail-quiet"]), "explicit All Mail literal sender name/address substring scope; not importance identity")
    for legacy in ["inbox", "focus", "quiet", "hidden", "all"] {
        var params = [URLQueryItem(name: "accountId", value: "account"), .init(name: "limit", value: "30")]
        if legacy != "inbox" { params.append(.init(name: "view", value: legacy)) }
        let page: InboxPage = try await client.request("v1/inbox", query: params)
        let owned = page.messages.allSatisfy { $0.accountId == "account" }
        let expected: Bool
        switch legacy {
        case "inbox": expected = page.messages.contains { $0.id == "nav-mail-inbox" } && !page.messages.contains { $0.id == "nav-mail-archived" }
        case "focus": expected = page.messages.contains { $0.id == "nav-mail-focus" } && page.messages.allSatisfy { ["focus", "notify"].contains($0.attentionBehavior) }
        case "quiet": expected = page.messages.contains { $0.id == "nav-mail-quiet" }
        case "hidden": expected = !page.messages.contains { $0.id.hasPrefix("nav-mail-") }
        default: expected = Set(page.messages.filter { $0.id.hasPrefix("nav-mail-") }.map(\.id)) == Set(["nav-mail-archived", "nav-mail-quiet", "nav-mail-inbox", "nav-mail-focus"])
        }
        check("NAV-API-legacy-pin-\(legacy)", owned && expected, "actual legacy enum endpoint semantics; not saved View ID or named Focus destination")
    }
    do {
        let _: MailActionJSON = try await client.request("v1/organization/collections-pins/queries", pathSuffix: ["nav-query-legacy", "results"], query: [.init(name: "accountId", value: "other-account")])
        check("NAV-API-query-account-boundary", false, "cross-account query unexpectedly accepted")
    } catch APIClient.ClientError.http(let code, let error) { check("NAV-API-query-account-boundary", code == 404 && error?.code == "not_found", "actual account mismatch is an indistinguishable missing-query response") }
    let snapshot: MailActionJSON = try await client.request("__bre457/navigation/state")
    check("NAV-API-independent-sqlite-membership", snapshot["membershipCount"].integer == 2 && snapshot["queryCount"].integer == 2 && snapshot["pinCount"].integer == 10, "independent SQLite counts, not response-derived totals")
    check("NAV-API-result-domain-dml-zero", snapshot["readDomainDML"].integer == 0 && snapshot["readRequests"].integer == 13, "13 measured read requests after explicit bootstrap; auth connection changes reported separately")
    check("NAV-API-provider-read-boundary-zero", snapshot["providerClientCalls"].integer == 0 && snapshot["outboundNetworkCalls"].integer == 0, "existing fail-closed GmailClient and sealed GET-only Bun fetch boundary both observe zero calls; not physical provider delivery")
    try await runSenderTransportDiagnosticCases(connection: connection, client: senderClient, transport: senderTransport, probe: senderProbe, check: check)
}
