import SwiftUI

struct SavedMailboxView: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var description: String
    var revision: Int
    var selectionID: String { "view:\(id)" }
}
struct SavedMailboxViewCatalog: Codable { var items: [SavedMailboxView] }
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
    @Published private(set) var enabledIDs: Set<String> = ["focus", "all"]
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published var selectedID = "normal"
    private let preferences: MailboxPreferenceStore
    private var scope: String?
    private var generation = UUID()

    init(preferences: MailboxPreferenceStore = .init()) { self.preferences = preferences }
    var options: [MailboxOption] {
        [MailboxOption(id: "normal", name: "Inbox")]
            + [MailboxOption(id: "focus", name: "Focus"), MailboxOption(id: "all", name: "All Mail")].filter { enabledIDs.contains($0.id) }
            + views.filter { enabledIDs.contains($0.selectionID) }.map { MailboxOption(id: $0.selectionID, name: $0.name) }
    }
    var selectedView: SavedMailboxView? { views.first { $0.selectionID == selectedID } }
    var title: String { options.first { $0.id == selectedID }?.name ?? "Inbox" }
    var unavailableIDs: [String] { enabledIDs.filter { id in id.hasPrefix("view:") && !views.contains(where: { $0.selectionID == id }) }.sorted() }

    func activate(scope: String) {
        guard self.scope != scope else { return }
        generation = UUID(); self.scope = scope
        views = []; error = nil; loading = false; selectedID = "normal"
        enabledIDs = preferences.load(scope: scope)
    }
    func setEnabled(_ id: String, _ enabled: Bool) {
        guard let scope, id != "normal" else { return }
        if enabled { enabledIDs.insert(id) } else { enabledIDs.remove(id) }
        preferences.save(enabledIDs, scope: scope)
        ensureSelection()
    }
    func ensureSelection() {
        if !options.contains(where: { $0.id == selectedID }) { selectedID = "normal" }
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
            views = catalog.items; ensureSelection()
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
    static func permitsOfflineCache(_ error: Error) -> Bool {
        if case let APIClient.ClientError.http(code, _) = error { return code >= 500 }
        return error is URLError
    }
}

struct SavedViewThread: Codable, Identifiable, Hashable {
    var accountId: String; var accountEmail: String; var provider: String; var threadId: String
    var subject: String; var latestReceivedAt: String; var messageCount: Int; var readState: String; var sender: MailContact
    var id: String { "\(accountId)|\(threadId)" }
}
struct SavedViewPage: Codable {
    var viewId: String; var viewRevision: Int; var accountIds: [String]
    var items: [SavedViewThread]; var nextCursor: String?
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
            let result = try await client.mailboxViewResults(view.id, cursor: reset ? nil : page?.nextCursor)
            guard current() else { return }
            guard Self.isValid(result, view: view, accounts: state.accounts),
                  reset || page?.accountIds.sorted() == result.accountIds.sorted() else {
                throw APIClient.ClientError.http(409, APIErrorBody(code: "view_changed", message: "This view changed. Refresh to load its current results.", retryable: true))
            }
            var next = result
            if !reset, let page { let existing = Set(page.items.map(\.id)); next.items = page.items + result.items.filter { !existing.contains($0.id) } }
            page = next; error = nil
            if reset { try? await state.cache.save(result, key: requestedKey) }
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
