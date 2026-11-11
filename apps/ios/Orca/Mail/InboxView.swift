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
            if let cached { messages = cached.messages; nextCursor = nil; self.error = "Offline — showing saved mail; importance may have changed." }
            else { if !MailboxViews.permitsOfflineCache(error) { messages = []; nextCursor = nil }; self.error = error.localizedDescription }
        }
    }
}

struct InboxView: View {
    @EnvironmentObject private var mailboxes: MailboxViews
    @State private var savedThread: SavedViewThread?
    @State private var actionTarget: MailActionTarget?
    @State private var importanceTarget: ImportanceSelection?
    @State private var viewEditor: NativeViewSelection?
    private enum MailFocus: Hashable { case row(String), filter(String) }
    @AccessibilityFocusState private var mailFocus: MailFocus?
    @State private var importanceOrigin: String?
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject var state: AppState; @StateObject private var model = InboxViewModel(); @State private var selected: InboxMessage?
    var body: some View {
        NavigationStack { VStack(spacing: 0) {
            // The picker is a sibling of the scrolling viewport, not a safe-area
            // inset that the List's native refresh control can scroll underneath.
            mailboxControls.fixedSize(horizontal: false, vertical: true)
            ZStack {
                if let view = mailboxes.selectedView, model.search.isEmpty {
                    SavedMailboxResults(view: view) { item in
                        guard state.selectSavedViewThread(item) else { return }
                        savedThread = item
                    }
                } else {
                    // Keep one refreshable surface even when the mailbox is empty.
                    List {
                        if model.search != model.resultSearch {
                            Text(model.resultSearch.isEmpty ? "Press Search to search All Mail. Previous mail is shown below." : "Showing results for “\(model.resultSearch)”. Press Search to update.")
                                .font(.subheadline).foregroundStyle(OrcaTheme.muted)
                        }
                        if model.messages.isEmpty {
                            Group {
                                if model.isLoading { ProgressView(model.view == "important" ? "Getting important conversations" : "Getting mail") }
                                else if let error = model.error {
                                    VStack(spacing: 16) {
                                        ContentUnavailableView("Mail unavailable", systemImage: "wifi.exclamationmark", description: Text("Your mail is safe. \(error)"))
                                        Button("Try again") { Task { await loadCurrent() } }
                                    }
                                } else {
                                    VStack(spacing: 12) {
                                        ContentUnavailableView(model.view == "important" && model.search.isEmpty ? "No important conversations" : "No matching mail", systemImage: "tray", description: Text(model.search.isEmpty ? "All Mail keeps Unreviewed and Not important conversations available. Use Importance to make a choice." : "No matches in All Mail. Your query is still here."))
                                        Button("Open All Mail") { model.search = ""; mailboxes.selectedID = "all" }
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 240)
                            .listRowBackground(OrcaTheme.paper)
                            .listRowSeparator(.hidden)
                        } else {
                            // Keep the introduction in the scrolling content. Plain List section
                            // headers pin above rows and participate in refresh inset layout.
                            VStack(alignment: .leading, spacing: 6) {
                                Text(model.resultSearch.isEmpty ? mailboxes.title : "Search All Mail · " + model.resultSearch)
                                    .font(.title2.weight(.semibold)).foregroundStyle(OrcaTheme.ink).accessibilityAddTraits(.isHeader).accessibilityIdentifier("mail.list-heading")
                                Text("\(model.messages.count) conversations shown · \(model.messages.filter(\.unread).count) unread")
                                    .font(.subheadline).foregroundStyle(OrcaTheme.muted)
                            }.padding(.vertical, 12).listRowBackground(OrcaTheme.paper).listRowSeparator(.hidden)
                            ForEach(Array(model.messages.enumerated()), id: \.element.id) { index, message in
                                if index == 0 || MailPreview.day(message.receivedAt) != MailPreview.day(model.messages[index - 1].receivedAt) {
                                    Text(MailPreview.day(message.receivedAt)?.formatted(date: .abbreviated, time: .omitted) ?? "Date unavailable").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted).listRowBackground(OrcaTheme.paper).listRowSeparator(.hidden)
                                }
                                HStack(alignment: .top, spacing: 8) {
                                    NavigationLink(value: message) { MessageRow(message: message) }
                                        .accessibilityFocused($mailFocus, equals: .row(message.id))
                                    Button { importanceOrigin = message.threadId; importanceTarget = .init(message) } label: {
                                        Image(systemName: message.importance?.effective == .important ? "flag.fill" : "flag").frame(width: 44, height: 44)
                                    }.buttonStyle(.plain).foregroundStyle(OrcaTheme.ink)
                                        .accessibilityLabel("Importance for " + message.subject)
                                        .accessibilityValue(message.importance?.effective.title ?? "Unavailable")
                                        .accessibilityIdentifier("mail.importance." + message.threadId)
                                }
                                    .listRowBackground(message.unread ? OrcaTheme.unread : OrcaTheme.surface)
                                    .listRowSeparatorTint(OrcaTheme.border)
                                    .listRowInsets(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 16))
                                    .accessibilityIdentifier("inbox.message.\(message.id)")
                                    .contextMenu {
                                        Button("Importance…") { importanceOrigin = message.threadId; importanceTarget = .init(message) }
                                        MailActionMenu(message: message, resolveMessage: message.providerMessageId.isEmpty) { actionTarget = $0 }
                                    }
                                    .onAppear { if message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } }
                            }
                        }
                    }.listStyle(.plain).scrollContentBackground(.hidden).accessibilityIdentifier("inbox.list")
                        .refreshable { await loadCurrent() }
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
        .searchable(text: $model.search, prompt: "Search All Mail")
        .onChange(of: state.selectedAccountID) { model.invalidate(); importanceOrigin = nil; importanceTarget = nil }
        .onChange(of: state.ownerScope) { model.invalidate(); importanceOrigin = nil; importanceTarget = nil }
        .onChange(of: model.search) { if model.search.isEmpty { Task { await loadCurrent() } } }
        .onSubmit(of: .search) { Task { await loadCurrent() } }
        .toolbar {
            ToolbarItem(placement: .principal) { OrcaWordmark().fixedSize() }
            ToolbarItem(placement: .topBarLeading) {
                if !model.search.isEmpty, let account = state.selectedAccount {
                    Button("Save search") { viewEditor = .init(query: model.search, accountId: account.id) }.accessibilityIdentifier("search.save-view")
                }
            }
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
        .sheet(item: $viewEditor) { selection in NativeViewEditor(selection: selection) }
        .sheet(item: $importanceTarget, onDismiss: restoreImportanceFocus) { target in ImportanceView(selection: target) }
        .onChange(of: model.isLoading) { if !model.isLoading && importanceTarget == nil { restoreImportanceFocus() } }
        .sheet(item: $actionTarget) { target in
            MailActionsSheet(target: target) { await loadCurrent() }
        }
        .task(id: "\(state.ownerScope)|\(state.selectedAccountID ?? "")|\(mailboxes.selectedID)|\(state.mailboxReadRevision)") {
            if mailboxes.selectedView == nil || !model.search.isEmpty { await loadCurrent() }
        }
        .onChange(of: scenePhase) {
            if scenePhase == .active, state.phase == .ready, mailboxes.selectedView == nil {
                Task { await loadCurrent() }
            }
        }
        .navigationDestination(item: $savedThread) { ThreadView(accountId: $0.accountId, threadId: $0.threadId) }
        .onChange(of: state.routedThread?.id, initial: true) { if let route = state.routedThread { selected = InboxMessage(id: route.id, accountId: route.accountId, provider: "gmail", providerMessageId: route.id, threadId: route.id, from: .init(name: nil, email: ""), subject: "Conversation", snippet: "", receivedAt: "", unread: false, labels: [], attentionBehavior: "normal", humanSignal: nil, humanClassification: nil); state.routedThread = nil } }
        .navigationDestination(item: $selected) { ThreadView(message: $0) }
        }
    }

    private var mailboxControls: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                filter("Important", id: "important")
                filter("All Mail", id: "all")
            }
            if let account = state.selectedAccount {
                Menu {
                    ForEach(state.accounts) { item in Button(item.email) { state.selectedAccountID = item.id } }
                } label: { Label(account.email, systemImage: "person.crop.circle").font(.subheadline).frame(minHeight: 44) }
                .accessibilityLabel("Account: " + account.email)
            }
            HStack {
            Menu {
                Picker("Mailbox view", selection: $mailboxes.selectedID) {
                    ForEach(mailboxes.options) { option in Text(option.name).tag(option.id) }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(mailboxes.title)
                        .font(OrcaTheme.ui(14, weight: .semibold))
                        .lineLimit(2).truncationMode(.tail)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(OrcaTheme.muted)
                        .accessibilityHidden(true)
                }
                .foregroundStyle(OrcaTheme.ink)
                .padding(.vertical, 8)
                // Put the interaction area inside the Menu label. An outer
                // Picker frame reports 44pt but leaves its padded edge inert.
                .frame(minWidth: 44, maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Mailboxes")
            .accessibilityValue(mailboxes.title)
            .accessibilityHint("Choose which mail to show")
            .accessibilityIdentifier("inbox.view-picker")
            Button { state.selectedTab = "settings" } label: { Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44) }
                .foregroundStyle(OrcaTheme.accent).accessibilityLabel("Choose visible views")
                .accessibilityIdentifier("inbox.visible-views")
            }
            if mailboxes.selectedView != nil { Text("Saved-view results. Search searches All Mail in the selected account.").font(.caption).foregroundStyle(OrcaTheme.muted) }
        }.padding(.horizontal, 20).padding(.vertical, 4)
            .background(OrcaTheme.paper, ignoresSafeAreaEdges: [])
    }
    private func restoreImportanceFocus() {
        guard !model.isLoading, let thread = importanceOrigin else { return }
        importanceOrigin = nil
        guard !model.messages.contains(where: { $0.threadId == thread }) else { return }
        mailFocus = model.messages.first.map { .row($0.id) } ?? .filter("all")
    }
    private func loadCurrent() async {
        model.view = model.search.isEmpty ? mailboxes.selectedID : "all"
        await model.load(state: state)
    }
    private func filter(_ title: String, id: String) -> some View {
        Button { model.search = ""; mailboxes.selectedID = id } label: {
            HStack(spacing: 6) {
                if mailboxes.selectedID == id { Image(systemName: "checkmark").accessibilityHidden(true) }
                Text(title).fixedSize(horizontal: false, vertical: true)
            }.font(.subheadline.weight(.semibold)).foregroundStyle(OrcaTheme.ink)
                .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 8)
                .background(mailboxes.selectedID == id ? OrcaTheme.selected : OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(OrcaTheme.border))
        }.buttonStyle(.plain).accessibilityAddTraits(mailboxes.selectedID == id ? [.isSelected] : [])
            .accessibilityIdentifier("mail.filter." + id)
            .accessibilityFocused($mailFocus, equals: .filter(id))

    }

}

struct MessageRow: View {
    let message: InboxMessage
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ContactGlyph(contact: message.from)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(message.from.name ?? message.from.email).font(.subheadline.weight(message.unread ? .semibold : .regular)).foregroundStyle(OrcaTheme.ink).lineLimit(2)
                    Spacer(minLength: 8)
                    Text(MailDate.compact(message.receivedAt)).font(.system(size: 10, design: .monospaced)).foregroundStyle(OrcaTheme.muted)
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if message.unread { Capsule().fill(OrcaTheme.accent).frame(width: 3, height: 14).accessibilityLabel("Unread") }
                    Text(message.subject.isEmpty ? "(No subject)" : message.subject).font(.body.weight(message.unread ? .semibold : .regular)).foregroundStyle(OrcaTheme.ink).lineLimit(2)
                }
                Text(MailPreview.decode(message.snippet)).font(.subheadline).foregroundStyle(OrcaTheme.muted).lineSpacing(3).lineLimit(2)
                Text(message.importance?.effective.title ?? "Importance unavailable")
                    .font(.caption).foregroundStyle(OrcaTheme.muted)

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

enum MailPreview {
    static func day(_ value: String, calendar: Calendar = .current) -> Date? {
        MailDate.parse(value).map { calendar.startOfDay(for: $0) }
    }
    static func decode(_ value: String) -> String {
        var result = value
        let pattern = #"&(amp|lt|gt|quot|apos|#39);"#
        let entities = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&#39;": "'"]
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return value }
        for _ in 0..<2 {
            for match in expression.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed() {
                if let range = Range(match.range, in: result), let replacement = entities[String(result[range])] { result.replaceSubrange(range, with: replacement) }
            }
        }
        return result
    }
}
