import SwiftUI

@MainActor final class InboxViewModel: ObservableObject {
    @Published var messages = [InboxMessage](); @Published var nextCursor: String?; @Published var isLoading = false; @Published var error: String?; @Published var search = ""; @Published var view = "normal"
    private var requestGeneration = UUID()
    private var activeKey: String?
    func load(state: AppState, reset: Bool = true) async {
        guard let account = state.selectedAccount, reset || !isLoading else { return }
        let scope = state.ownerScope, requestedView = view, requestedSearch = search
        let key = "\(scope)|\(account.id)|inbox|\(requestedView)|\(requestedSearch)"
        if activeKey != key { messages = []; nextCursor = nil; error = nil; activeKey = key }
        requestGeneration = UUID(); let generation = requestGeneration
        if state.demoMode { messages = DemoData.messages.filter { requestedView == "all" || $0.attentionBehavior == requestedView }; return }
        guard let client = state.client else { return }
        isLoading = true
        defer { if generation == requestGeneration { isLoading = false } }
        do {
            let page = try await client.inbox(accountId: account.id, view: requestedView, query: requestedSearch.isEmpty ? nil : requestedSearch, cursor: reset ? nil : nextCursor)
            guard !Task.isCancelled, generation == requestGeneration, scope == state.ownerScope, account.id == state.selectedAccount?.id else { return }
            messages = reset ? page.messages : messages + page.messages; nextCursor = page.nextCursor; error = nil
            if reset { try? await state.cache.save(page, key: key) }
        } catch {
            let cached: InboxPage? = reset ? await state.cache.load(InboxPage.self, key: key) : nil
            guard !Task.isCancelled, generation == requestGeneration, scope == state.ownerScope, account.id == state.selectedAccount?.id else { return }
            if let cached { messages = cached.messages; nextCursor = nil; self.error = "Offline — showing saved mail" }
            else { self.error = error.localizedDescription }
        }
    }

}

struct InboxView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject var state: AppState; @StateObject private var model = InboxViewModel(); @State private var selected: InboxMessage?
    var body: some View {
        NavigationStack { Group {
            if model.isLoading && model.messages.isEmpty { ProgressView("Getting your inbox") }
            else if let error = model.error, model.messages.isEmpty { ContentUnavailableView("Inbox unavailable", systemImage: "wifi.exclamationmark", description: Text("Your mail is safe. \(error)")); Button("Try again") { Task { await model.load(state: state) } } }
            else if model.messages.isEmpty { ContentUnavailableView("Nothing here", systemImage: "water.waves", description: Text(model.search.isEmpty ? "The current is quiet." : "No exact matches. Your search is still here.")) }
            else {
                List {
                    Section {
                        ForEach(model.messages) { message in
                            NavigationLink(value: message) { MessageRow(message: message) }
                                .listRowBackground(message.unread ? OrcaTheme.unread : OrcaTheme.surface)
                                .listRowSeparatorTint(OrcaTheme.border)
                                .listRowInsets(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 16))
                                .accessibilityIdentifier("inbox.message.\(message.id)")
                                .onAppear { if message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } }
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                                .font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1.2).foregroundStyle(OrcaTheme.accent)
                            Text(dynamicTypeSize.isAccessibilitySize ? "Your mail" : (model.view == "focus" ? "A little more focus." : "What deserves you now"))
                                .font(OrcaTheme.reader(dynamicTypeSize.isAccessibilitySize ? 20 : 34)).fixedSize(horizontal: false, vertical: true).tracking(-0.8).foregroundStyle(OrcaTheme.ink).textCase(nil)
                            (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout())) {
                                Picker("Inbox view", selection: $model.view) { Text("Inbox").tag("normal"); Text("Focus").tag("focus"); Text("All Mail").tag("all") }
                                    .pickerStyle(.menu).font(OrcaTheme.ui(12, weight: .semibold))
                                    .padding(.horizontal, 8).background(OrcaTheme.selected, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(OrcaTheme.border))
                                    .onChange(of: model.view) { Task { await model.load(state: state) } }
                                if !dynamicTypeSize.isAccessibilitySize { Spacer() }
                                Text("\(model.messages.filter(\.unread).count) unread shown").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                            }.textCase(nil)
                        }.padding(.vertical, 18)
                    }
                }.listStyle(.plain).scrollContentBackground(.hidden).accessibilityIdentifier("inbox.list")
            }
        }
        .background(OrcaTheme.paper)
        .safeAreaInset(edge: .top) {
            if model.messages.isEmpty {
                Picker("Inbox view", selection: $model.view) { Text("Inbox").tag("normal"); Text("Focus").tag("focus"); Text("All Mail").tag("all") }
                    .pickerStyle(.segmented).padding(.horizontal, 20).padding(.vertical, 12).background(OrcaTheme.paper)
                    .onChange(of: model.view) { Task { await model.load(state: state) } }
            }
        }
        .safeAreaInset(edge: .bottom) { if let error = model.error, !model.messages.isEmpty { Text(error).font(.caption).padding(8).frame(maxWidth: .infinity).background(.regularMaterial) } }
        .navigationTitle(model.view == "focus" ? "Focus" : (model.view == "all" ? "All Mail" : "Inbox"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.search, prompt: "Search mail").accessibilityIdentifier("inbox.search")
        .onChange(of: model.search) { if model.search.isEmpty { Task { await model.load(state: state) } } }
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
        .task(id: state.selectedAccountID) { await model.load(state: state) }
        .refreshable { await model.load(state: state) }
        .onChange(of: state.routedThread?.id, initial: true) { if let route = state.routedThread { selected = InboxMessage(id: route.id, accountId: route.accountId, provider: "gmail", providerMessageId: route.id, threadId: route.id, from: .init(name: nil, email: ""), subject: "Conversation", snippet: "", receivedAt: "", unread: false, labels: [], attentionBehavior: "normal", humanSignal: nil, humanClassification: nil); state.routedThread = nil } }
        .navigationDestination(item: $selected) { ThreadView(message: $0) }
        }
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
