import SwiftUI

@MainActor final class InboxViewModel: ObservableObject {
    enum SearchStatus: Equatable { case idle, loading, ready, updating, blocked, offline, stale, invalidQuery, unavailable }
    @Published var messages = [InboxMessage]()
    @Published var nextCursor: String?
    @Published var isLoading = false
    @Published var error: String?
    @Published var search = "" { didSet { if oldValue != search { invalidateResults() } } }
    @Published var view = "normal" { didSet { if oldValue != view { invalidateResults() } } }
    @Published private(set) var searchStatus: SearchStatus = .idle
    @Published private(set) var searchCapabilities: MailSearchCapabilities?
    @Published private(set) var continuation: MailSearchContinuation = .none
    private(set) var snapshot: String?
    private var requestGeneration = UUID()
    private var activeKey: String?
    private var searchDestinationID: String?
    private var searchView: MailSearchView = .all
    private var searchSession: MailSearchSession?

    var isSearching: Bool { !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var searchCoverageLabel: String {
        searchCapabilities?.mode == .legacyMetadata
            ? "Searches senders, subjects and previews only. Message bodies are not searched."
            : "Searches stored senders, subjects, previews and message bodies."
    }
    var searchCountLabel: String {
        "\(messages.count) shown · \(searchCapabilities?.mode == .legacyMetadata ? "Mailbox order" : "Most relevant first")"
    }
    var searchEmptyDescription: String {
        searchCapabilities?.mode == .legacyMetadata
            ? "No matches in senders, subjects or previews. Your search is still here."
            : "No matches in stored mail for this mailbox. Your search is still here."
    }
    var searchErrorTitle: String {
        switch searchStatus {
        case .updating: "Search is updating"
        case .blocked: "Search needs attention"
        case .offline: "Search is offline"
        case .stale: "Search changed"
        case .invalidQuery: "Check your search"
        default: "Search unavailable"
        }
    }
    var retryTitle: String { searchStatus == .stale ? "Restart search" : "Try again" }

    private func invalidateResults() {
        requestGeneration = UUID(); activeKey = nil
        messages = []; nextCursor = nil; snapshot = nil; continuation = .none
        error = nil; isLoading = false; searchStatus = .idle; searchDestinationID = nil
        searchSession = nil; searchCapabilities = nil
    }

    func load(state: AppState, reset: Bool = true) async {
        await load(state: state, reset: reset, canResolveModeChange: true)
    }
    private func load(state: AppState, reset: Bool, canResolveModeChange: Bool) async {
        guard let account = state.selectedAccount, reset || (!isLoading && nextCursor != nil) else { return }
        let scope = state.ownerScope, requestedView = view
        let requestedSearch = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let searching = !requestedSearch.isEmpty
        let key = "\(scope)|\(account.id)|inbox|\(requestedView)|\(requestedSearch)"
        if activeKey != key { invalidateResults(); activeKey = key; if !reset { return } }
        requestGeneration = UUID(); let generation = requestGeneration
        func current() -> Bool {
            !Task.isCancelled && generation == requestGeneration && scope == state.ownerScope
                && account.id == state.selectedAccount?.id && requestedView == view
                && requestedSearch == search.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if searching, reset { messages = []; nextCursor = nil; snapshot = nil; continuation = .none; error = nil }
        if state.demoMode {
            if searching { failSearch(status: .unavailable, message: "Stored-mail search requires a connected account. Your query and mailbox are unchanged.") }
            else { messages = DemoData.messages.filter { requestedView == "all" || $0.attentionBehavior == requestedView } }
            return
        }
        guard let client = state.client else {
            if searching { failSearch(status: .offline, message: "Connect to search stored mail. Your query and mailbox are unchanged.") }
            return
        }
        isLoading = true
        if searching { searchStatus = .loading }
        defer {
            if generation == requestGeneration {
                isLoading = false
                if searching && searchStatus == .loading { searchStatus = messages.isEmpty && nextCursor == nil ? .idle : .ready }
            }
        }
        do {
            if searching && (reset || searchSession == nil) {
                let resolved = try await client.searchCapabilities(expectedOwnerID: state.userID)
                guard current() else { return }
                searchSession = resolved; searchCapabilities = resolved.capabilities
            }
            let destinationID: String?
            if searching && !reset {
                // Keep the original resolved scope with the opaque continuation.
                // Refresh resolves routing again and starts a new snapshot.
                guard let searchSession, searchSession.capabilities.mode == .legacyMetadata || snapshot != nil else { throw staleSearchError() }
                destinationID = searchDestinationID
            } else if requestedView == "all" {
                destinationID = nil
            } else if requestedView.hasPrefix("destination:") {
                destinationID = String(requestedView.dropFirst(12))
            } else {
                let catalog: MailActionJSON = try await client.request("v1/destinations")
                guard current() else { return }
                destinationID = catalog["legacyDestinationIds"][requestedView].text
            }
            if searching {
                guard let session = searchSession else { throw APIClient.ClientError.invalidResponse }
                if reset {
                    if session.capabilities.mode == .indexed {
                        guard let resolvedView = destinationID != nil ? MailSearchView.all
                            : MailSearchView(rawValue: requestedView == "normal" ? "inbox" : requestedView) else {
                            throw APIClient.ClientError.invalidResponse
                        }
                        searchView = resolvedView
                    }
                    searchDestinationID = destinationID
                }
                let requestedCursor = reset ? nil : nextCursor
                let resultMessages: [InboxMessage]
                if session.capabilities.mode == .legacyMetadata {
                    let page = try await client.inbox(accountId: account.id, view: requestedView.hasPrefix("destination:") ? "all" : requestedView,
                        query: requestedSearch, cursor: requestedCursor, destinationId: destinationID, limit: 10, searchSession: session)
                    guard current() else { return }
                    guard page.accounts.allSatisfy({ $0.id == account.id }), page.messages.allSatisfy({ $0.accountId == account.id }) else { throw APIClient.ClientError.invalidResponse }
                    guard reset || page.nextCursor != requestedCursor else { throw staleSearchError() }
                    resultMessages = page.messages; nextCursor = page.nextCursor
                    snapshot = nil; continuation = .none
                } else {
                    let page = try await client.searchMail(query: requestedSearch, accountId: account.id,
                        view: searchView, cursor: requestedCursor, destinationId: destinationID, searchSession: session)
                    guard current() else { return }
                    guard page.accounts.allSatisfy({ $0.id == account.id }), page.messages.allSatisfy({ $0.accountId == account.id }) else { throw APIClient.ClientError.invalidResponse }
                    guard reset || (page.snapshot == snapshot && page.nextCursor != requestedCursor) else { throw staleSearchError() }
                    resultMessages = page.messages
                    nextCursor = page.nextCursor; snapshot = page.snapshot; continuation = page.continuation
                }
                var seen = Set(reset ? [] : messages.map(\.id))
                let newMessages = resultMessages.filter { seen.insert($0.id).inserted }
                messages = reset ? newMessages : messages + newMessages
                searchStatus = .ready; error = nil
            } else {
                let page = try await client.inbox(accountId: account.id, view: requestedView.hasPrefix("destination:") ? "all" : requestedView,
                    query: nil, cursor: reset ? nil : nextCursor, destinationId: requestedView == "all" ? nil : destinationID)
                guard current() else { return }
                messages = reset ? page.messages : messages + page.messages; nextCursor = page.nextCursor; error = nil
                if reset { try? await state.cache.save(page, key: key) }
            }
        } catch {
            guard current() else { return }
            if searching {
                if canResolveModeChange, case let APIClient.ClientError.http(_, body) = error,
                   body?.code == "search_mode_changed" || body?.code == "search_not_activated" {
                    invalidateResults()
                    await load(state: state, reset: true, canResolveModeChange: false)
                } else { handleSearchError(error) }
            } else {
                let cached: InboxPage? = reset ? await state.cache.load(InboxPage.self, key: key) : nil
                guard current() else { return }
                if let cached { messages = cached.messages; nextCursor = nil; self.error = "Offline — showing saved mail" }
                else { self.error = error.localizedDescription }
            }
        }
    }

    private func staleSearchError() -> APIClient.ClientError {
        .http(409, APIErrorBody(code: "search_cursor_stale", message: "Stored mail changed. Restart this search to load a consistent set of results.", retryable: true))
    }
    private func failSearch(status: SearchStatus, message: String) {
        messages = []; nextCursor = nil; snapshot = nil; continuation = .none
        searchStatus = status; error = message
    }
    private func handleSearchError(_ error: Error) {
        if let networkError = error as? URLError,
           [.notConnectedToInternet, .networkConnectionLost, .dataNotAllowed].contains(networkError.code) {
            failSearch(status: .offline, message: "Connect to search stored mail. Your query and mailbox are unchanged.")
            return
        }
        let status: SearchStatus
        if case let APIClient.ClientError.http(_, body) = error {
            switch body?.code {
            case "search_index_updating": status = .updating
            case "search_index_blocked": status = .blocked
            case "search_cursor_stale", "search_invalid_cursor", "search_mode_changed", "search_not_activated": status = .stale
            case "search_invalid_query", "search_anchor_required": status = .invalidQuery
            default: status = .unavailable
            }
        } else { status = .unavailable }
        failSearch(status: status, message: error.localizedDescription)
    }
}

struct InboxView: View {
    @EnvironmentObject private var mailboxes: MailboxViews
    @State private var savedThread: SavedViewThread?
    @State private var actionTarget: MailActionTarget?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject var state: AppState; @StateObject private var model = InboxViewModel(); @State private var selected: InboxMessage?
    var body: some View {
        NavigationStack { VStack(spacing: 0) {
            // The picker is a sibling of the scrolling viewport, not a safe-area
            // inset that the List's native refresh control can scroll underneath.
            mailboxControls.fixedSize(horizontal: false, vertical: true)
            if mailboxes.selectedView == nil, model.isSearching, model.searchCapabilities != nil {
                Text(model.searchCoverageLabel).font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 8)
                    .accessibilityIdentifier("inbox.search.coverage")
            }
            ZStack {
                if let view = mailboxes.selectedView {
                    SavedMailboxResults(view: view) { item in
                        guard state.selectSavedViewThread(item) else { return }
                        savedThread = item
                    }
                } else if model.isLoading && model.messages.isEmpty { ProgressView(model.isSearching ? "Searching stored mail" : "Getting your inbox") }
                else if let error = model.error, model.messages.isEmpty {
                    VStack(spacing: 16) {
                        ContentUnavailableView(model.isSearching ? model.searchErrorTitle : "Inbox unavailable", systemImage: model.isSearching ? "magnifyingglass" : "wifi.exclamationmark", description: Text(error))
                        Button(model.isSearching ? model.retryTitle : "Try again") { Task { await model.load(state: state) } }
                            .buttonStyle(.bordered).accessibilityIdentifier("inbox.retry")
                    }
                }
                else if model.isSearching && model.searchStatus == .idle {
                    ContentUnavailableView("Search stored mail", systemImage: "magnifyingglass", description: Text("Submit your search to find matching mail in this mailbox."))
                }
                else if model.messages.isEmpty && model.nextCursor == nil { ContentUnavailableView(model.isSearching ? "No matching mail" : "Nothing here", systemImage: "water.waves", description: Text(model.isSearching ? model.searchEmptyDescription : "The current is quiet.")) }
                else {
                    List {
                        // Keep the introduction in the scrolling content. Plain List section
                        // headers pin above rows and participate in refresh inset layout.
                        VStack(alignment: .leading, spacing: 12) {
                            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                                .font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1.2).foregroundStyle(OrcaTheme.accent)
                            Text(model.isSearching ? "Search results" : (dynamicTypeSize.isAccessibilitySize ? "Your mail" : (model.view == "focus" ? "A little more focus." : "What deserves you now")))
                                .font(OrcaTheme.reader(dynamicTypeSize.isAccessibilitySize ? 20 : 34)).fixedSize(horizontal: false, vertical: true).tracking(-0.8).foregroundStyle(OrcaTheme.ink).textCase(nil)
                                .accessibilityAddTraits(.isHeader)
                            Text(model.isSearching ? model.searchCountLabel : "\(model.messages.filter(\.unread).count) unread shown").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted).textCase(nil)
                                .accessibilityIdentifier(model.isSearching ? "inbox.search.count" : "inbox.unread.count")
                        }.padding(.vertical, 18)
                        .listRowBackground(OrcaTheme.paper)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                        ForEach(model.messages) { message in
                            NavigationLink(value: message) { MessageRow(message: message) }
                                .listRowBackground(message.unread ? OrcaTheme.unread : OrcaTheme.surface)
                                .listRowSeparatorTint(OrcaTheme.border)
                                .listRowInsets(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 16))
                                .accessibilityIdentifier("inbox.message.\(message.id)")
                                .contextMenu { MailActionMenu(message: message) { actionTarget = $0 } }
                                .onAppear { if !model.isSearching, message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } }
                        }
                        if model.isSearching, model.nextCursor != nil {
                            VStack(alignment: .leading, spacing: 12) {
                                if model.continuation == .scan {
                                    Text("More stored mail remains to check. Additional matches are not yet known.")
                                        .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                                }
                                Button { Task { await model.load(state: state, reset: false) } } label: {
                                    if model.isLoading { ProgressView("Searching more…") } else { Text("Load more") }
                                }.disabled(model.isLoading).accessibilityIdentifier("inbox.search.load-more")
                            }.listRowBackground(OrcaTheme.paper)
                        }
                    }.listStyle(.plain).scrollContentBackground(.hidden).accessibilityIdentifier("inbox.list")
                        .refreshable { await model.load(state: state) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            // Contain elastic scrolling and the refresh indicator below the
            // fixed controls, including while a refresh request is in flight.
            .clipped()
        }
        .background(OrcaTheme.paper)
        .safeAreaInset(edge: .bottom) { if mailboxes.selectedView == nil, let error = model.error, !model.messages.isEmpty { Text(error).font(.caption).padding(8).frame(maxWidth: .infinity).background(.regularMaterial) } }
        .navigationTitle(mailboxes.title)
        .navigationBarTitleDisplayMode(.inline)
        .modifier(MailboxSearch(enabled: mailboxes.selectedView == nil, text: $model.search))
        .onChange(of: model.search) { if !model.isSearching { Task { await model.load(state: state) } } }
        .onSubmit(of: .search) { Task { await model.load(state: state) } }
        .toolbar {
            ToolbarItem(placement: .principal) { OrcaWordmark().fixedSize() }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(destination: ComposeView()) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 20, weight: .medium))
                }
                .tint(OrcaTheme.accent)
                .accessibilityLabel("Compose")
                .accessibilityHint("Write a new message")
                .accessibilityIdentifier("compose.open")
            }
        }
        .navigationDestination(for: InboxMessage.self) { ThreadView(message: $0) }
        .sheet(item: $actionTarget) { target in
            MailActionsSheet(target: target) { await model.load(state: state) }
        }
        .task(id: "\(state.ownerScope)|\(state.selectedAccountID ?? "")|\(mailboxes.selectedID)") {
            if mailboxes.selectedView == nil { model.view = mailboxes.selectedID; await model.load(state: state) }
        }
        .navigationDestination(item: $savedThread) { ThreadView(accountId: $0.accountId, threadId: $0.threadId) }
        .onChange(of: state.routedThread?.id, initial: true) { if let route = state.routedThread { selected = InboxMessage(id: route.id, accountId: route.accountId, provider: "gmail", providerMessageId: route.id, threadId: route.id, from: .init(name: nil, email: ""), subject: "Conversation", snippet: "", receivedAt: "", unread: false, labels: [], attentionBehavior: "normal", humanSignal: nil, humanClassification: nil); state.routedThread = nil } }
        .navigationDestination(item: $selected) { ThreadView(message: $0) }
        }
    }

    private var mailboxControls: some View {
        HStack {
            Picker("Mailbox view", selection: $mailboxes.selectedID) {
                ForEach(mailboxes.options) { option in Text(option.name).tag(option.id) }
            }
            .pickerStyle(.menu).font(OrcaTheme.ui(12, weight: .semibold))
            .tint(OrcaTheme.ink)
            .padding(.horizontal, 8).frame(minHeight: 44)
            .background(OrcaTheme.selected, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(OrcaTheme.border))
            .accessibilityIdentifier("inbox.view-picker")
            Spacer(minLength: 8)
            Button { state.selectedTab = "settings" } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                .foregroundStyle(OrcaTheme.accent).accessibilityLabel("Choose visible views")
                .accessibilityIdentifier("inbox.visible-views")
        }.padding(.horizontal, 20).padding(.vertical, 8)
            .background(OrcaTheme.paper, ignoresSafeAreaEdges: [])
    }
}

struct MessageRow: View {
    let message: InboxMessage
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ContactGlyph(contact: message.from)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(message.from.name ?? message.from.email).font(OrcaTheme.ui(12, weight: message.unread ? .semibold : .regular)).foregroundStyle(OrcaTheme.ink).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(MailDate.compact(message.receivedAt)).font(.system(size: 10, design: .monospaced)).foregroundStyle(OrcaTheme.muted)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if message.unread { Capsule().fill(OrcaTheme.accent).frame(width: 3, height: 14).accessibilityLabel("Unread") }
                    Text(message.subject.isEmpty ? "(No subject)" : message.subject).font(OrcaTheme.ui(15, weight: message.unread ? .semibold : .regular)).foregroundStyle(OrcaTheme.ink).lineLimit(2)
                }
                Text(message.snippet).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted).lineSpacing(3).lineLimit(2)
                if let score = message.humanSignal {
                    Label("Human signal \(score)/10", systemImage: "person.wave.2").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted).padding(.top, 2)
                }
            }
        }.accessibilityElement(children: .combine)
    }
}

struct ContactGlyph: View {
    let contact: MailContact
    private var initials: String {
        let words = (contact.name ?? contact.email).split(separator: " ")
        return words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
    private var tone: Color {
        let colors: [UInt32] = [0x3d6d84, 0x4f7356, 0x8a6348, 0x6f5a82, 0x3a6570, 0x7a7040, 0x4a5c8a, 0x845858]
        let index = contact.email.lowercased().utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        return Color(uiColor: UIColor(orcaHex: colors[Int(index % UInt32(colors.count))]))
    }
    var body: some View {
        Text(initials).font(OrcaTheme.ui(11, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
            .frame(width: 36, height: 36).background(tone.opacity(0.16), in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(tone.opacity(0.35))).accessibilityHidden(true)
    }
}

private struct MailboxSearch: ViewModifier {
    var enabled: Bool
    @Binding var text: String
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.searchable(text: $text, prompt: "Search mail") }
        else { content }
    }
}
