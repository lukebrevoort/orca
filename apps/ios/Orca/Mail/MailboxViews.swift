import SwiftUI
import Combine

@MainActor final class MailboxViews: ObservableObject {
    @Published private(set) var views = [SavedMailboxView]()
    @Published private(set) var destinations = [MailboxOption]()
    @Published private(set) var enabledIDs: Set<String> = ["focus", "all"]
    @Published private(set) var loading = false
    @Published private(set) var changing = false
    @Published private(set) var workspaceRevision: Int?
    @Published private(set) var error: String?
    @Published var selectedID = "important"
    @Published private(set) var hiddenIDs = Set<String>()
    let browser = NativeMailBrowser()
    private var browserChanges: AnyCancellable?
    private let preferences: MailboxPreferenceStore
    private var scope: String?
    private var activeAccountID: String?
    private var generation = UUID()

    init(preferences: MailboxPreferenceStore = .init()) {
        self.preferences = preferences
        browserChanges = browser.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }
    var groups: [NativeMailboxGroup] {
        NativeMailboxProjection.groups(destinations: destinations, views: views, enabledIDs: enabledIDs, hiddenIDs: hiddenIDs, catalog: browser.catalog)
    }
    var hiddenOptions: [MailboxOption] {
        NativeMailboxProjection.hidden(destinations: destinations, views: views, enabledIDs: enabledIDs, hiddenIDs: hiddenIDs, catalog: browser.catalog)
    }
    func route(for id: String) -> NativeMailRoute? {
        guard let catalog = browser.catalog else { return nil }
        if let collection = catalog.collections.first(where: { $0.identity.selectionID == id }) { return .collection(collection) }
        if let pin = catalog.pins.first(where: { $0.identity.selectionID == id }) { return .pin(pin, catalog: catalog) }
        return nil
    }
    func identity(for id: String) -> NativeMailIdentity? {
        if ["important", "all", "normal", "focus"].contains(id) { return .init(kind: .utility, opaqueID: id) }
        if let space = browser.spaces?.spaces.first(where: { $0.identity.selectionID == id && !$0.retired }) { return space.identity }
        if let view = views.first(where: { $0.selectionID == id }) { return .init(kind: .savedView, opaqueID: view.id) }
        if let collection = browser.catalog?.collections.first(where: { $0.identity.selectionID == id }) { return collection.identity }
        return browser.catalog?.pins.first(where: { $0.identity.selectionID == id })?.identity
    }
    var selectsSeparateMailbox: Bool { selectedID.hasPrefix("view:") || selectsCatalog }
    var selectedRoute: NativeMailRoute? { route(for: selectedID) }
    var selectedIsHidden: Bool { hiddenIDs.contains(selectedID) || (selectedID == "focus" && !enabledIDs.contains("focus")) || (selectedID.hasPrefix("view:") && !enabledIDs.contains(selectedID)) }
    func accountDidChange(to id: String?) {
        guard activeAccountID != id else { return }
        generation = UUID(); activeAccountID = id; browser.invalidate(); destinations = []
        workspaceRevision = nil; loading = false; error = nil
    }
    var selectsCatalog: Bool { selectedID.hasPrefix("collection:") || selectedID.hasPrefix("pin:") }
    func setHidden(_ id: String, _ hidden: Bool) {
        guard let scope, !["normal", "focus", "important", "all"].contains(id) else { return }
        if id.hasPrefix("view:") { setEnabled(id, !hidden); return }
        if hidden { hiddenIDs.insert(id) } else { hiddenIDs.remove(id) }
        preferences.saveHidden(hiddenIDs, scope: scope)
        if hidden && selectedID == id { selectedID = "all" }
    }
    func restore(_ id: String) { if id == "focus" { setEnabled(id, true) } else { setHidden(id, false) } }

    var options: [MailboxOption] {
        groups.flatMap(\.options)
    }
    var selectedView: SavedMailboxView? { views.first { $0.selectionID == selectedID } }
    var title: String { options.first { $0.id == selectedID }?.name ?? hiddenOptions.first { $0.id == selectedID }?.name ?? "Mailbox unavailable" }
    var unavailableIDs: [String] { NativeMailboxProjection.unavailableIDs(enabledIDs: enabledIDs, views: views) }

    func activate(scope: String) {
        guard self.scope != scope else { return }
        generation = UUID(); self.scope = scope
        views = []; destinations = []; workspaceRevision = nil; error = nil; loading = false; selectedID = "important"
        enabledIDs = preferences.load(scope: scope); hiddenIDs = preferences.loadHidden(scope: scope); browser.invalidate()
    }
    func setEnabled(_ id: String, _ enabled: Bool) {
        guard let scope, !["normal", "important", "all"].contains(id) else { return }
        if enabled { enabledIDs.insert(id) } else { enabledIDs.remove(id) }
        preferences.save(enabledIDs, scope: scope)
        ensureSelection()
    }
    func ensureSelection() {
        if !options.contains(where: { $0.id == selectedID }) { selectedID = "important" }
    }
    func load(state: AppState) async {
        let requestedScope = state.ownerScope
        activate(scope: requestedScope)
        guard let context = state.nativeMailContext(), let client = state.client else { error = "Reconnect to verify workspace choices. Your saved visibility is retained."; return }
        accountDidChange(to: context.accountID)
        generation = UUID(); let request = generation
        loading = true; error = nil
        func current() -> Bool { !Task.isCancelled && generation == request && scope == requestedScope && state.nativeMailContext() == context && state.client === client }
        defer { if generation == request { loading = false } }
        let key = context.key + "|mailboxViews"
        do {
            let catalog: SavedMailboxViewCatalog = try await client.request("v1/organization/views", authorize: {
                guard await client.serverOrigin() == context.origin else { return false }
                return await MainActor.run { current() }
            })
            guard current() else { return }
            views = catalog.items; workspaceRevision = catalog.workspaceRevision
            try? await state.cache.save(catalog, key: key)
            guard current() else { return }
        } catch {
            guard current() else { return }
            workspaceRevision = nil
            if Self.permitsOfflineCache(error), let cached = await state.cache.load(SavedMailboxViewCatalog.self, key: key) {
                guard current() else { return }; views = cached.items
            } else if !Self.permitsOfflineCache(error) { views = []; await state.cache.remove(key: key); guard current() else { return } }
            self.error = "Saved views could not be refreshed. Important and All Mail remain available."
        }
        guard current() else { return }
        await browser.load(context: context, client: client, cache: state.cache, isCurrent: { current() })
        guard current() else { return }
        destinations = browser.spaces?.options ?? []
        selectedID = NativeMailboxProjection.selectionAfterCatalogRefresh(selectedID, options: options)
    }
    func reorder(_ view: SavedMailboxView, offset: Int, state: AppState) async {
        guard !changing, !loading, let revision = workspaceRevision, let index = views.firstIndex(where: { $0.id == view.id }),
              views.indices.contains(index + offset), let client = state.client else { return }
        let owner = state.ownerScope, request = generation
        var ordered = views; ordered.swapAt(index, index + offset)
        changing = true
        defer { changing = false }
        do {
            let _: MailActionJSON = try await client.request("v1/organization/views/reorder", method: "POST", body: MailActionJSON.object([
                "idempotencyKey": .string(UUID().uuidString), "expectedWorkspaceRevision": .number(Double(revision)),
                "items": .array(ordered.enumerated().map { position, item in .object(["id": .string(item.id), "expectedRevision": .number(Double(item.revision)), "position": .number(Double(position))]) })
            ]))
            guard owner == state.ownerScope, request == generation else { return }
            await load(state: state)
        } catch {
            guard owner == state.ownerScope, request == generation else { return }
            await load(state: state)
            guard owner == state.ownerScope else { return }
            self.error = "Order change could not be confirmed. Current catalog was requested; review before trying again."
        }
    }
    func remove(_ view: SavedMailboxView, state: AppState) async {
        guard !changing, !loading, let revision = workspaceRevision, let client = state.client else { return }
        let owner = state.ownerScope, request = generation
        changing = true
        defer { changing = false }
        do {
            let _: EmptyResponse = try await client.request("v1/organization/views", pathSuffix: [view.id], method: "DELETE", query: [
                .init(name: "expectedRevision", value: String(view.revision)), .init(name: "expectedWorkspaceRevision", value: String(revision)), .init(name: "idempotencyKey", value: UUID().uuidString)
            ])
            guard owner == state.ownerScope, request == generation else { return }
            setEnabled(view.selectionID, false); await load(state: state)
        } catch {
            guard owner == state.ownerScope, request == generation else { return }
            await load(state: state)
            guard owner == state.ownerScope else { return }
            self.error = "Removal could not be confirmed. Review the current catalog before trying again. Mail remains in All Mail."
        }
    }
    static func permitsOfflineCache(_ error: Error) -> Bool {
        if case let APIClient.ClientError.http(code, _) = error { return code >= 500 }
        return error is URLError
    }
}

@MainActor final class SavedViewReader: ObservableObject {
    @Published private(set) var page: SavedViewPage?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var generation = UUID()
    private var key: String?
    private let loadCachedPage: (CacheStore, String) async -> SavedViewPage?
    init(loadCachedPage: @escaping (CacheStore, String) async -> SavedViewPage? = { cache, key in
        await cache.load(SavedViewPage.self, key: key)
    }) { self.loadCachedPage = loadCachedPage }
    func load(view: SavedMailboxView, state: AppState, reset: Bool = true) async {
        guard let client = state.client, reset || (!loading && page?.nextCursor != nil) else { return }
        let scope = state.ownerScope, connection = state.mailConnectionGeneration, sourceAccount = state.selectedAccount?.id
        let owned = Set(state.accounts.map(\.id))
        let requestedKey = NativeMailJSON.tuple([scope, connection.uuidString, sourceAccount ?? "", "savedView", view.id, String(view.revision)] + owned.sorted())
        if key != requestedKey { page = nil; error = nil; key = requestedKey }
        generation = UUID(); let request = generation
        loading = true
        func current() -> Bool { !Task.isCancelled && request == generation && state.ownerScope == scope && state.phase == .ready && state.mailConnectionGeneration == connection && state.client === client && state.selectedAccount?.id == sourceAccount && Set(state.accounts.map(\.id)) == owned }
        defer { if generation == request { loading = false } }
        do {
            let cursor = reset ? nil : page?.nextCursor
            var replaces = reset
            let result: SavedViewPage
            do { result = try await client.mailboxViewResults(view.id, cursor: cursor) }
            catch APIClient.ClientError.http(400, let body) where body?.code == "invalid_cursor" && cursor != nil {
                guard current() else { return }; page?.nextCursor = nil; replaces = true
                result = try await client.mailboxViewResults(view.id)
            }
            guard current() else { return }
            guard Self.isValid(result, view: view, accounts: state.accounts),
                  reset || page?.accountIds.sorted() == result.accountIds.sorted() else {
                throw APIClient.ClientError.http(409, APIErrorBody(code: "view_changed", message: "This view changed. Refresh to load its current results.", retryable: true))
            }
            var next = result
            if !replaces, let page { let existing = Set(page.items.map(\.id)); next.items = page.items + result.items.filter { !existing.contains($0.id) } }
            page = next; error = nil
            if replaces { try? await state.cache.save(result, key: requestedKey) }
        } catch {
            guard current() else { return }
            var cached: SavedViewPage?
            if reset, MailboxViews.permitsOfflineCache(error) {
                cached = await loadCachedPage(state.cache, requestedKey)
                guard current() else { return }
            }
            if let cached, Self.isValid(cached, view: view, accounts: state.accounts) {
                page = cached; page?.nextCursor = nil; self.error = "Offline — showing saved results"
            } else {
                if reset || !MailboxViews.permitsOfflineCache(error) { page = nil }
                page?.nextCursor = nil
                self.error = error.localizedDescription
            }
        }
    }
    static func isValid(_ page: SavedViewPage, view: SavedMailboxView, accounts: [MailAccount]) -> Bool {
        page.viewId == view.id && page.viewRevision == view.revision
            && Set(page.accountIds).isSubset(of: Set(accounts.map(\.id)))
            && page.items.allSatisfy { page.accountIds.contains($0.accountId) }
    }

}

@MainActor extension AppState {
    func nativeMailContext() -> NativeMailContext? {
        guard phase == .ready, verifiedMailConnection == mailConnectionGeneration,
              let origin = draftServerOrigin, let verifiedMailOrigin, NativeMailJSON.exact(origin, verifiedMailOrigin), let userID, !userID.isEmpty,
              let account = selectedAccount, Set(accounts.map(\.id)).count == accounts.count, accounts.contains(where: { $0.id == account.id }) else { return nil }
        return .init(origin: origin, userID: userID, accountID: account.id, connection: mailConnectionGeneration, ownedAccountIDs: Set(accounts.map(\.id)))
    }
}
