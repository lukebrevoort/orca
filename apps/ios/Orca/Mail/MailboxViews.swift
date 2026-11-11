import SwiftUI

struct MailboxOption: Identifiable, Equatable { var id: String; var name: String }

/// Browsing choices belong to this signed-in identity on this device, independently of push.
struct MailboxPreferenceStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    func load(scope: String) -> Set<String> {
        Set(defaults.stringArray(forKey: "mailboxViews|\(scope)") ?? ["focus", "all"])
    }
    func save(_ ids: Set<String>, scope: String) {
        defaults.set(ids.sorted(), forKey: "mailboxViews|\(scope)")
    }
}

@MainActor final class MailboxViews: ObservableObject {
    @Published private(set) var views = [SavedMailboxView]()
    @Published private(set) var destinations = [MailboxOption]()
    @Published private(set) var enabledIDs: Set<String> = ["focus", "all"]
    @Published private(set) var loading = false
    @Published private(set) var changing = false
    @Published private(set) var workspaceRevision: Int?
    @Published private(set) var error: String?
    @Published var selectedID = "important"
    private let preferences: MailboxPreferenceStore
    private var scope: String?
    private var generation = UUID()

    init(preferences: MailboxPreferenceStore = .init()) { self.preferences = preferences }
    var options: [MailboxOption] {
        [MailboxOption(id: "important", name: "Important"), MailboxOption(id: "all", name: "All Mail"), MailboxOption(id: "normal", name: "Inbox")]
            + [MailboxOption(id: "focus", name: "Focus")].filter { enabledIDs.contains($0.id) }
            + destinations
            + views.filter { enabledIDs.contains($0.selectionID) }.map { MailboxOption(id: $0.selectionID, name: $0.name) }
    }
    var selectedView: SavedMailboxView? { views.first { $0.selectionID == selectedID } }
    var title: String { options.first { $0.id == selectedID }?.name ?? "Important" }
    var unavailableIDs: [String] { enabledIDs.filter { id in id.hasPrefix("view:") && !views.contains(where: { $0.selectionID == id }) }.sorted() }

    func activate(scope: String) {
        guard self.scope != scope else { return }
        generation = UUID(); self.scope = scope
        views = []; destinations = []; workspaceRevision = nil; error = nil; loading = false; selectedID = "important"
        enabledIDs = preferences.load(scope: scope)
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
        guard state.phase == .ready, let client = state.client else { return }
        generation = UUID(); let request = generation
        loading = true; error = nil
        func current() -> Bool { !Task.isCancelled && generation == request && scope == requestedScope && state.ownerScope == requestedScope && state.phase == .ready }
        defer { if generation == request { loading = false } }
        do {
            let catalog = try await client.mailboxViews()
            guard current() else { return }
            let routing: MailActionJSON = try await client.request("v1/destinations")
            guard current() else { return }
            if case .array(let items) = routing["destinations"] {
                let builtIns = [routing["legacyDestinationIds"]["normal"].text, routing["legacyDestinationIds"]["focus"].text]
                destinations = items.compactMap { item in
                    guard let id = item["id"].text, let name = item["name"].text, !builtIns.contains(id), item["retiredAt"].text == nil else { return nil }
                    return MailboxOption(id: "destination:" + id, name: name)
                }
            }
            views = catalog.items; workspaceRevision = catalog.workspaceRevision; ensureSelection()
            try? await state.cache.save(catalog, key: "\(requestedScope)|mailboxViews")
        } catch {
            guard current() else { return }
            if Self.permitsOfflineCache(error), views.isEmpty,
               let cached = await state.cache.load(SavedMailboxViewCatalog.self, key: "\(requestedScope)|mailboxViews") {
                guard current() else { return }; views = cached.items
            }
            guard current() else { return }
            if !Self.permitsOfflineCache(error) { views = [] }
            self.error = views.isEmpty ? "Saved views could not be loaded. Your choices are unchanged." : "Could not refresh views — showing saved choices."
            ensureSelection()
        }
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
        let scope = state.ownerScope, requestedKey = "\(scope)|savedView|\(view.id)|\(view.revision)"
        if key != requestedKey { page = nil; error = nil; key = requestedKey }
        generation = UUID(); let request = generation
        loading = true
        func current() -> Bool { !Task.isCancelled && request == generation && state.ownerScope == scope && state.phase == .ready }
        defer { if generation == request { loading = false } }
        do {
            let cursor = reset ? nil : page?.nextCursor
            var replaces = reset
            let result: SavedViewPage
            do { result = try await client.mailboxViewResults(view.id, cursor: cursor) }
            catch APIClient.ClientError.http(400, _) where cursor != nil {
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
