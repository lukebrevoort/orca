import SwiftUI

@MainActor final class InboxViewModel: ObservableObject {
    @Published var messages = [InboxMessage](); @Published var nextCursor: String?; @Published var isLoading = false; @Published var error: String?; @Published var search = ""; @Published var view = "all"
    func load(state: AppState, reset: Bool = true) async { guard !isLoading, let account = state.selectedAccount else { return }; if state.demoMode { messages = DemoData.messages.filter { view == "all" || $0.attentionBehavior == view }; return }; guard let client = state.client else { return }; isLoading = true; defer { isLoading = false }; do { let page = try await client.inbox(accountId: account.id, view: view, query: search.isEmpty ? nil : search, cursor: reset ? nil : nextCursor); messages = reset ? page.messages : messages + page.messages; nextCursor = page.nextCursor; error = nil } catch { self.error = error.localizedDescription } }
}

struct InboxView: View {
    @EnvironmentObject var state: AppState; @StateObject private var model = InboxViewModel(); @State private var selected: InboxMessage?
    var body: some View {
        NavigationStack { Group {
            if model.isLoading && model.messages.isEmpty { ProgressView("Getting your inbox") }
            else if let error = model.error, model.messages.isEmpty { ContentUnavailableView("Inbox unavailable", systemImage: "wifi.exclamationmark", description: Text("Your mail is safe. \(error)")); Button("Try again") { Task { await model.load(state: state) } } }
            else if model.messages.isEmpty { ContentUnavailableView("Nothing here", systemImage: "water.waves", description: Text(model.search.isEmpty ? "The current is quiet." : "No exact matches. Your search is still here.")) }
            else { List(model.messages) { message in NavigationLink(value: message) { MessageRow(message: message) }.onAppear { if message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } } }.listStyle(.plain) }
        }
        .navigationTitle(model.view == "focus" ? "Focus" : "Inbox")
        .searchable(text: $model.search, prompt: "Search mail")
        .onSubmit(of: .search) { Task { await model.load(state: state) } }
        .toolbar { ToolbarItem(placement: .topBarLeading) { Picker("Inbox view", selection: $model.view) { Text("Inbox").tag("all"); Text("Focus").tag("focus") }.pickerStyle(.segmented).frame(width: 170).onChange(of: model.view) { Task { await model.load(state: state) } } }; ToolbarItem(placement: .topBarTrailing) { NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose") } }
        .navigationDestination(for: InboxMessage.self) { ThreadView(message: $0) }
        .task(id: state.selectedAccountID) { await model.load(state: state) }
        .refreshable { await model.load(state: state) }
        .onChange(of: state.routedThread?.id) { if let route = state.routedThread { selected = InboxMessage(id: route.id, accountId: route.accountId, provider: "gmail", providerMessageId: route.id, threadId: route.id, from: .init(name: nil, email: ""), subject: "Conversation", snippet: "", receivedAt: "", unread: false, labels: [], attentionBehavior: "normal", humanSignal: nil, humanClassification: nil) } }
        .navigationDestination(item: $selected) { ThreadView(message: $0) }
        }
    }
}

struct MessageRow: View {
    let message: InboxMessage
    var body: some View { HStack(alignment: .top, spacing: 12) { ContactGlyph(contact: message.from); VStack(alignment: .leading, spacing: 3) { HStack { Text(message.from.name ?? message.from.email).fontWeight(message.unread ? .semibold : .regular).lineLimit(1); Spacer(); Text(relative(message.receivedAt)).font(.caption).foregroundStyle(.secondary) }; Text(message.subject.isEmpty ? "(No subject)" : message.subject).fontWeight(message.unread ? .semibold : .regular).lineLimit(1); Text(message.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2); if let score = message.humanSignal { Label("Human signal \(score) of 10", systemImage: "person.wave.2").font(.caption2).foregroundStyle(.secondary) } } }.padding(.vertical, 5).accessibilityElement(children: .combine) }
    private func relative(_ value: String) -> String { guard let date = ISO8601DateFormatter().date(from: value) else { return "" }; return date.formatted(.relative(presentation: .numeric)) }
}

struct ContactGlyph: View { let contact: MailContact; var body: some View { Text(String((contact.name ?? contact.email).prefix(1)).uppercased()).font(.headline).foregroundStyle(.white).frame(width: 40, height: 40).background(Color(hue: Double(abs(contact.email.hashValue % 256)) / 256, saturation: 0.45, brightness: 0.62), in: RoundedRectangle(cornerRadius: 13)).accessibilityHidden(true) } }

