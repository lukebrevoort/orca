import Foundation
import SwiftUI

@MainActor final class InboxViewModel: ObservableObject {
    struct Rows: Codable { var messages: [InboxMessage]; var nextCursor: String?; var revision: Int? }
    @Published var messages = [InboxMessage](); @Published var nextCursor: String?; @Published var isLoading = false
    @Published var error: String?; @Published var search = ""; @Published var view = "normal"
    @Published private(set) var resultSearch = ""
    private var requestGeneration = UUID()
    private var activeKey: String?
    func invalidate() { requestGeneration = UUID(); activeKey = nil; messages = []; nextCursor = nil; isLoading = false; error = nil; resultSearch = "" }
    func load(state: AppState, reset: Bool = true) async {
        guard let account = state.selectedAccount else { invalidate(); error = "No connected mailbox. Open Settings to review accounts."; return }
        guard reset || (!isLoading && nextCursor != nil) else { return }
        let scope = state.ownerScope, requestedView = view, requestedSearch = search
        let key = state.inboxCacheKey(accountID: account.id, view: requestedView, search: requestedSearch)
        if activeKey != key { messages = []; nextCursor = nil; error = nil; activeKey = key }
        requestGeneration = UUID(); let generation = requestGeneration
        func current() -> Bool {
            !Task.isCancelled && generation == requestGeneration && scope == state.ownerScope && state.phase == .ready
            && account.id == state.selectedAccount?.id && view == requestedView && search == requestedSearch
            && key == state.inboxCacheKey(accountID: account.id, view: requestedView, search: requestedSearch)
        }
        if state.demoMode { messages = requestedView == "important" ? [] : DemoData.inbox(view: requestedView); nextCursor = nil; return }
        guard let client = state.client else { return }
        isLoading = true
        defer { if generation == requestGeneration { isLoading = false } }
        do {
            // Search explicitly covers All Mail, including when entered from a view or Important.
            let searching = !requestedSearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let destinationID: String?
            if requestedView == "all" || requestedView == "important" { destinationID = nil }
            else if requestedView.hasPrefix("destination:") { destinationID = String(requestedView.dropFirst(12)) }
            else {
                let catalog: MailActionJSON = try await client.request("v1/destinations")
                destinationID = catalog["legacyDestinationIds"][requestedView == "focus" ? "normal" : requestedView].text
            }
            guard current() else { return }
            let apiView = requestedView.hasPrefix("destination:") || (requestedView == "normal" && destinationID != nil) ? "all" : requestedView
            func fetch(_ cursor: String?) async throws -> Rows {
                if requestedView == "important" && !searching {
                    let page = try await client.important(accountId: account.id, cursor: cursor)
                    guard page.accountId == account.id, page.items.allSatisfy({ $0.accountId == account.id && $0.importance.effective == .important }) else { throw APIClient.ClientError.invalidResponse }
                    return Rows(messages: page.items.map { $0.row(provider: account.provider) }, nextCursor: page.nextCursor, revision: page.revision)
                }
                let page = try await client.inbox(accountId: account.id, view: apiView, query: searching ? requestedSearch : nil, cursor: cursor, destinationId: destinationID)
                guard page.messages.allSatisfy({ $0.accountId == account.id }) else { throw APIClient.ClientError.invalidResponse }
                return Rows(messages: page.messages, nextCursor: page.nextCursor)
            }
            let cursor = reset ? nil : nextCursor
            var replaces = reset
            let page: Rows
            do { page = try await fetch(cursor) }
            catch APIClient.ClientError.http(400, _) where !reset && cursor != nil {
                guard current() else { return }; nextCursor = nil; replaces = true
                page = try await fetch(nil) // One revision-bound restart, no retry loop.
            }
            guard current() else { return }
            if replaces { messages = page.messages }
            else { let known = Set(messages.map(\.id)); messages += page.messages.filter { !known.contains($0.id) } }
            nextCursor = page.nextCursor; resultSearch = requestedSearch; error = nil
            if replaces { try? await state.cache.save(page, key: key) }
        } catch {
            let cached: Rows? = reset && MailboxViews.permitsOfflineCache(error) ? await state.cache.load(Rows.self, key: key) : nil
            guard current() else { return }
            if let cached { messages = cached.messages; resultSearch = requestedSearch; nextCursor = nil; self.error = "Offline — showing saved mail; importance may have changed." }
            else { if !MailboxViews.permitsOfflineCache(error) { messages = []; nextCursor = nil }; self.error = error.localizedDescription }
        }
    }
}

