import Foundation
import SwiftUI

struct NativeCatalogSectionPresentation {
    let loading: Bool
    let message: String?
    let canShowEmpty: Bool
}

/// Read-only Organization catalogs. Section failure never removes fixed Mail.
@MainActor final class NativeMailBrowser: ObservableObject {
    @Published private(set) var catalog: NativeMailCatalog?
    @Published private(set) var spaces: NativeSpaceCatalog?
    @Published private(set) var catalogError: String?
    @Published private(set) var spaceError: String?
    @Published private(set) var loading = false
    @Published private(set) var staleCatalog = false
    @Published private(set) var staleSpaces = false
    private var context: NativeMailContext?
    private var generation = UUID()
    func invalidate() {
        generation = UUID(); context = nil; catalog = nil; spaces = nil; catalogError = nil; spaceError = nil
        loading = false; staleCatalog = false; staleSpaces = false
    }
    func load(context: NativeMailContext, client: APIClient, cache: CacheStore, isCurrent: @escaping @MainActor () -> Bool) async {
        if self.context != context { invalidate(); self.context = context }
        generation = UUID(); let request = generation
        func current() -> Bool { !Task.isCancelled && self.context == context && generation == request && isCurrent() }
        let authorize: @Sendable () async -> Bool = {
            guard await client.serverOrigin() == context.origin else { return false }
            return await MainActor.run { current() }
        }
        guard current(), await client.serverOrigin() == context.origin else { return }
        loading = true
        defer { if generation == request { loading = false } }
        let spacesKey = context.key + "|spaces"
        do {
            let raw: MailActionJSON = try await client.request("v1/destinations", authorize: authorize)
            guard current() else { return }
            spaces = try NativeSpaceCatalog(raw); spaceError = nil; staleSpaces = false
            try? await cache.save(raw, key: spacesKey)
            guard current() else { return }
        } catch {
            guard current() else { return }
            if Self.offline(error), let raw = await cache.load(MailActionJSON.self, key: spacesKey) {
                guard current() else { return }; spaces = try? NativeSpaceCatalog(raw); staleSpaces = spaces != nil
            } else if !Self.offline(error) {
                spaces = nil; staleSpaces = false; await cache.remove(key: spacesKey)
                guard current() else { return }
            }
            spaceError = staleSpaces ? "Offline — saved Space choices; membership may have changed." : "Spaces unavailable. Important and All Mail remain available."
        }
        guard current() else { return }
        let catalogKey = context.key + "|collections-pins"
        do {
            let raw: MailActionJSON = try await client.request("v1/organization/collections-pins/query", query: [.init(name: "accountId", value: context.accountID)], authorize: authorize)
            guard current() else { return }
            catalog = try NativeMailCatalog(raw, owner: context.userID, account: context.accountID, ownedAccounts: context.ownedAccountIDs)
            catalogError = nil; staleCatalog = false
            try? await cache.save(raw, key: catalogKey)
            guard current() else { return }
        } catch {
            guard current() else { return }
            if Self.offline(error), let raw = await cache.load(MailActionJSON.self, key: catalogKey) {
                guard current() else { return }
                catalog = try? NativeMailCatalog(raw, owner: context.userID, account: context.accountID, ownedAccounts: context.ownedAccountIDs); staleCatalog = catalog != nil
            } else if !Self.offline(error) {
                catalog = nil; staleCatalog = false; await cache.remove(key: catalogKey)
                guard current() else { return }
            }
            catalogError = staleCatalog ? "Offline — saved collections and pins; results may have changed." : "Collections and pins unavailable. Important and All Mail remain available."
        }
    }
    /// Settings uses the same independent catalog state as the mailbox picker.
    /// An unavailable or stale catalog must never look like a resolved empty one.
    func settingsSection(_ section: String) -> NativeCatalogSectionPresentation {
        let isSpaces = section == "spaces"
        let message = isSpaces ? spaceError : catalogError
        let resolved = isSpaces ? spaces != nil : catalog != nil
        return NativeCatalogSectionPresentation(loading: loading, message: message,
            canShowEmpty: resolved && !loading && message == nil)
    }
    static func offline(_ error: Error) -> Bool {
        if case APIClient.ClientError.http(let code, _) = error { return code >= 500 }
        return error is URLError
    }
}

struct NativeMailReadPage {
    let raw: MailActionJSON; let messages: [InboxMessage]; let cursor: String?; let freshness: Freshness?
    init(raw: MailActionJSON, route: NativeMailRoute, context: NativeMailContext) throws {
        self.raw = raw
        if case .query(let query) = route.target {
            let page = try NativeSavedQueryPage(raw, query: query, account: context.accountID, limit: 30)
            messages = page.messages; cursor = page.cursor; freshness = page.freshness
            return
        }
        _ = try NativeMailJSON.object(raw, required: ["accounts", "messages", "nextCursor", "counts"], optional: ["freshness"])
        let accounts = try NativeMailJSON.array(raw["accounts"])
        guard accounts.count == 1 else { throw NativeMailJSON.invalid() }
        try NativeMailWire.account(accounts[0]); guard accounts[0]["id"].text == context.accountID else { throw NativeMailJSON.invalid() }
        let rows = try NativeMailJSON.array(raw["messages"])
        guard rows.count <= 30 else { throw NativeMailJSON.invalid() }
        for row in rows { try NativeMailWire.message(row); guard row["accountId"].text == context.accountID, row["provider"].text == accounts[0]["provider"].text else { throw NativeMailJSON.invalid() } }
        messages = try rows.map { try NativeMailJSON.decode(InboxMessage.self, $0) }
        guard Set(messages.map(\.id)).count == messages.count else { throw NativeMailJSON.invalid() }
        cursor = try NativeMailJSON.nullableString(raw["nextCursor"])
        if case .object(let fields) = raw, let fresh = fields["freshness"] {
            _ = try NativeMailJSON.object(fresh, required: ["revision", "lastSyncedAt"])
            let revision = try NativeMailJSON.string(fresh["revision"], trim: false)
            guard revision.range(of: "^mailbox-v[12]:[0-9a-f]{64}$", options: .regularExpression) != nil else { throw NativeMailJSON.invalid() }
            if case .null = fresh["lastSyncedAt"] {} else { _ = try NativeMailJSON.date(fresh["lastSyncedAt"]) }
            freshness = .init(revision: revision, lastSyncedAt: fresh["lastSyncedAt"].text)
        } else { freshness = nil }
    }
}

/// Same controller drives collection/resource/query result screens and the
/// Foundation regressions. Only a validated first page can become stale cache.
@MainActor final class NativeMailResults: ObservableObject {
    @Published private(set) var messages = [InboxMessage]()
    @Published private(set) var nextCursor: String?
    @Published private(set) var freshness: Freshness?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var offline = false
    @Published private(set) var requiresCatalogReload = false
    private var key: String?
    private var generation = UUID()
    private var blockedCache = Set<String>()
    private let loadCachedPage: (CacheStore, String) async -> MailActionJSON?
    init(loadCachedPage: @escaping (CacheStore, String) async -> MailActionJSON? = { cache, key in await cache.load(MailActionJSON.self, key: key) }) { self.loadCachedPage = loadCachedPage }
    func invalidate() {
        generation = UUID(); key = nil; messages = []; nextCursor = nil; freshness = nil
        loading = false; error = nil; offline = false; requiresCatalogReload = false
    }
    func load(route: NativeMailRoute, context: NativeMailContext, client: APIClient, cache: CacheStore,
              reset: Bool = true, readRevision: String, isCurrent: @escaping @MainActor () -> Bool) async {
        guard route.identity.accountID == context.accountID else { invalidate(); return }
        guard reset || (!loading && nextCursor != nil && !requiresCatalogReload && !offline) else { return }
        let requestedKey = NativeMailJSON.tuple([context.key, route.fingerprint, readRevision, "limit:30"])
        if key != requestedKey { invalidate(); key = requestedKey }
        generation = UUID(); let request = generation
        func current() -> Bool { !Task.isCancelled && generation == request && key == requestedKey && isCurrent() }
        let authorize: @Sendable () async -> Bool = {
            guard await client.serverOrigin() == context.origin else { return false }
            return await MainActor.run { current() }
        }
        guard current(), await client.serverOrigin() == context.origin else { return }
        loading = true
        defer { if generation == request { loading = false } }
        do {
            let cursor = reset ? nil : nextCursor
            var replaces = reset
            let page: NativeMailReadPage
            do { page = try await fetch(route: route, context: context, client: client, cursor: cursor, authorize: authorize) }
            catch APIClient.ClientError.http(400, let body) where body?.code == "invalid_cursor" && cursor != nil {
                guard current() else { return }; nextCursor = nil; replaces = true
                page = try await fetch(route: route, context: context, client: client, cursor: nil, authorize: authorize)
            }
            guard current() else { return }
            if !replaces, freshness != page.freshness { throw APIClient.ClientError.http(409, APIErrorBody(code: "native_query_changed", message: "Mail changed during paging. Reload current results.", retryable: true)) }
            if replaces { messages = page.messages }
            else { let known = Set(messages.map(\.id)); messages += page.messages.filter { !known.contains($0.id) } }
            nextCursor = page.cursor; freshness = page.freshness; error = nil; offline = false; requiresCatalogReload = false
            blockedCache.remove(requestedKey)
            if replaces { try? await cache.save(page.raw, key: requestedKey); guard current() else { return } }
        } catch {
            guard current() else { return }
            if NativeMailBrowser.offline(error) {
                if reset, !blockedCache.contains(requestedKey), let raw = await loadCachedPage(cache, requestedKey) {
                    guard current() else { return }
                    if let cached = try? NativeMailReadPage(raw: raw, route: route, context: context) {
                        messages = cached.messages; freshness = cached.freshness; nextCursor = nil; offline = true
                    }
                }
                self.error = offline ? "Offline — saved results; importance and membership may have changed." : (messages.isEmpty ? Self.description(error) : "Partial results — more mail could not be loaded. Retry keeps these conversations.")
            } else {
                let rejectsScope: Bool
                if case APIClient.ClientError.http(let code, _) = error { rejectsScope = [401, 403, 404, 409, 422].contains(code) }
                else if case APIClient.ClientError.invalidResponse = error { rejectsScope = true }
                else if case APIClient.ClientError.decoding(_) = error { rejectsScope = true }
                else { rejectsScope = false }
                if rejectsScope {
                    messages = []; nextCursor = nil; freshness = nil; offline = false; blockedCache.insert(requestedKey)
                    await cache.remove(key: requestedKey); guard current() else { return }
                }
                if case APIClient.ClientError.http(409, let body) = error, body?.code == "native_query_changed" { requiresCatalogReload = true }
                self.error = Self.description(error)
            }
        }
    }
    private func fetch(route: NativeMailRoute, context: NativeMailContext, client: APIClient, cursor: String?, authorize: @escaping @Sendable () async -> Bool) async throws -> NativeMailReadPage {
        var query: [URLQueryItem] = [.init(name: "accountId", value: context.accountID), .init(name: "limit", value: "30")]
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        let raw: MailActionJSON
        switch route.target {
        case .query(let saved):
            if let cursor, cursor.utf16.count > 16_384 { throw NativeMailJSON.invalid() }
            raw = try await client.request("v1/organization/collections-pins/queries", pathSuffix: [saved.id, "results"], query: query, headers: ["x-orca-importance-version": "1"], authorize: authorize)
        case .inbox(let view, let destination, let collection, let sender):
            for (name, value) in [("view", view), ("destinationId", destination), ("collectionId", collection), ("sender", sender)] {
                if let value { query.append(.init(name: name, value: value)) }
            }
            raw = try await client.request("v1/inbox", query: query, headers: ["x-orca-importance-version": "1"], authorize: authorize)
        case .thread:
            // A pinned thread is opened by its typed reader route, not an inbox
            // approximation or a search over the currently loaded page.
            throw NativeMailJSON.invalid()
        }
        return try NativeMailReadPage(raw: raw, route: route, context: context)
    }
    private static func description(_ error: Error) -> String {
        switch error {
        case APIClient.ClientError.http(401, _): return "Session expired. Reconnect in Settings."
        case APIClient.ClientError.http(403, _): return "This account is no longer available to this session."
        case APIClient.ClientError.http(404, _): return "This saved item is unavailable. It has not been recreated."
        case APIClient.ClientError.http(422, _): return "This saved query cannot be evaluated. Choose another mailbox or Search."
        case APIClient.ClientError.http(409, _): return "This item or its results changed. Reload the catalog and review before continuing."
        case APIClient.ClientError.http(503, _): return "Stored mail is temporarily unavailable. Try again or open All Mail."
        default: return error.localizedDescription
        }
    }
}
