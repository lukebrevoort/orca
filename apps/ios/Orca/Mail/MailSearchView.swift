import SwiftUI

/// A native search workspace that keeps its invoking reader/Drafts/Settings stack intact.
struct MailSearchView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = InboxViewModel()
    @State private var viewEditor: NativeViewSelection?
    @State private var importanceTarget: ImportanceSelection?
    @FocusState private var queryFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(state.selectedAccount?.email ?? "Account unavailable").font(.subheadline).textSelection(.enabled)
            HStack {
                TextField("Search All Mail", text: $model.search).textFieldStyle(.roundedBorder).submitLabel(.search)
                    .focused($queryFocused).onSubmit { Task { await search() } }.accessibilityIdentifier("global-search.query")
                Button("Search") { queryFocused = false; Task { await search() } }.frame(minHeight: 44)
            }
            if model.search != model.resultSearch { Text("Press Search to update the results below.").font(.caption) }
            if let error = model.error { Text(error).font(.subheadline).foregroundStyle(OrcaTheme.danger) }
            if model.isLoading { ProgressView("Searching retained mail…") }
            List {
                Section {
                    ForEach(model.messages) { message in
                        NavigationLink(value: message) { MessageRow(message: message) }
                            .contextMenu { Button("Importance…") { importanceTarget = .init(message) } }
                            .onAppear { if message.id == model.messages.last?.id, model.nextCursor != nil { Task { await model.load(state: state, reset: false) } } }
                    }
                    if model.messages.isEmpty && !model.isLoading {
                        Text("No matches in All Mail. Your query remains available.")
                    }
                } header: { Text("\(model.messages.count) conversations shown · " + (model.resultSearch.isEmpty ? "All Mail" : "Results for “\(model.resultSearch)”")) }
            }.listStyle(.plain)
        }.padding(.horizontal, 16).background(OrcaTheme.paper)
            .navigationTitle("Search All Mail").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if !model.resultSearch.isEmpty, model.resultSearch == model.search, let account = state.selectedAccount {
                        Button("Save as View") { viewEditor = .init(query: model.resultSearch, accountId: account.id) }
                    }
                }
            }
            .navigationDestination(for: InboxMessage.self) { ThreadView(message: $0) }
            .sheet(item: $viewEditor) { selection in NativeViewEditor(selection: selection) }
            .sheet(item: $importanceTarget) { selection in ImportanceView(selection: selection) }
            .task(id: InboxViewModel.globalSearchRefreshIdentity(state: state)) { if await model.openGlobalSearch(state: state) { queryFocused = true } }
            .onChange(of: state.ownerScope) { model.invalidate(); dismiss() }
            .onChange(of: state.phase) { if state.phase != .ready { model.invalidate(); dismiss() } }
    }
    private func search() async { model.view = "all"; await model.load(state: state) }
}
