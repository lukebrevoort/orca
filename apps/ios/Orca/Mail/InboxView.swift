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
    @EnvironmentObject var state: AppState; @StateObject private var model = InboxViewModel(); @State private var selected: InboxMessage?
    var body: some View {
        NavigationStack { Group {
            if model.isLoading && model.messages.isEmpty { ProgressView("Getting your inbox") }
            else if let error = model.error, model.messages.isEmpty { ContentUnavailableView("Inbox unavailable", systemImage: "wifi.exclamationmark", description: Text("Your mail is safe. \(error)")); Button("Try again") { Task { await model.load(state: state) } } }
            else if model.messages.isEmpty { ContentUnavailableView("Nothing here", systemImage: "water.waves", description: Text(model.search.isEmpty ? "The current is quiet." : "No exact matches. Your search is still here.")) }
            else { List(model.messages) { message in NavigationLink(value: message) { MessageRow(message: message) }.accessibilityIdentifier("inbox.message.\(message.id)").onAppear { if message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } } }.listStyle(.plain).accessibilityIdentifier("inbox.list") }
        }
        .safeAreaInset(edge: .bottom) { if let error = model.error, !model.messages.isEmpty { Text(error).font(.caption).padding(8).frame(maxWidth: .infinity).background(.regularMaterial) } }
        .navigationTitle(model.view == "focus" ? "Focus" : (model.view == "all" ? "All Mail" : "Inbox"))
        .searchable(text: $model.search, prompt: "Search mail").accessibilityIdentifier("inbox.search")
        .onChange(of: model.search) { if model.search.isEmpty { Task { await model.load(state: state) } } }
        .onSubmit(of: .search) { Task { await model.load(state: state) } }
        .toolbar { ToolbarItem(placement: .topBarLeading) { Picker("Inbox view", selection: $model.view) { Text("Inbox").tag("normal"); Text("Focus").tag("focus"); Text("All Mail").tag("all") }.pickerStyle(.menu).onChange(of: model.view) { Task { await model.load(state: state) } } }; ToolbarItem(placement: .topBarTrailing) { NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose").accessibilityIdentifier("compose.open") } }
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
    var body: some View { HStack(alignment: .top, spacing: 12) { ContactGlyph(contact: message.from); VStack(alignment: .leading, spacing: 3) { HStack { Text(message.from.name ?? message.from.email).fontWeight(message.unread ? .semibold : .regular).lineLimit(1); Spacer(); Text(MailDate.compact(message.receivedAt)).font(.caption).foregroundStyle(.secondary) }; Text(message.subject.isEmpty ? "(No subject)" : message.subject).fontWeight(message.unread ? .semibold : .regular).lineLimit(1); Text(message.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2); if let score = message.humanSignal { Label("Human signal \(score) of 10", systemImage: "person.wave.2").font(.caption2).foregroundStyle(.secondary) } } }.padding(.vertical, 5).accessibilityElement(children: .combine) }
}

struct ContactGlyph: View { let contact: MailContact; var body: some View { Text(String((contact.name ?? contact.email).prefix(1)).uppercased()).font(.headline).foregroundStyle(.white).frame(width: 40, height: 40).background(Color(hue: Double(contact.email.lowercased().utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 } % 360) / 360, saturation: 0.5, brightness: 0.46), in: RoundedRectangle(cornerRadius: 13)).accessibilityHidden(true) } }
