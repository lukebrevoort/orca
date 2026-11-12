import SwiftUI

struct NativeCatalogResults: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @StateObject private var reader = NativeMailResults()
    @State private var importanceTarget: ImportanceSelection?
    @AccessibilityFocusState private var focusedRow: String?
    @State private var openedRow: String?
    @State private var actionTarget: MailActionTarget?
    let route: NativeMailRoute?
    let onOpen: (InboxMessage) -> Void
    let onThread: (String, String) -> Void
    let onAllMail: () -> Void
    var body: some View {
        List {
            if let route {
                VStack(alignment: .leading, spacing: 8) {
                    Text(route.title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Text(route.subtitle).font(.subheadline)
                    if let account = state.selectedAccount { Text(account.email).font(.caption) }
                    if let freshness = reader.freshness {
                        Text(freshness.lastSyncedAt.map { "Stored mail · last synced " + MailDate.full($0) } ?? "Stored mail · sync time unavailable")
                            .font(.caption).foregroundStyle(OrcaTheme.muted)
                    }
                }.fixedSize(horizontal: false, vertical: true)
                if case .thread(let id) = route.target {
                    action("Open pinned conversation", id: "mailbox.pin.open-thread") {
                        guard let account = state.selectedAccount, state.nativeMailContext() != nil, route.identity.accountID == account.id else { return }
                        onThread(account.id, id)
                    }
                } else {
                    if reader.loading { ProgressView(reader.messages.isEmpty ? "Loading stored mail…" : "Refreshing stored mail…") }
                    if reader.messages.isEmpty && !reader.loading && reader.error == nil {
                        ContentUnavailableView("No matching mail", systemImage: "tray", description: Text("This item has no matching stored mail in this account."))
                    }
                    ForEach(reader.messages) { message in
                        Button { openedRow = message.id; onOpen(message) } label: { MessageRow(message: message) }
                            .buttonStyle(.plain).frame(minHeight: 44)
                            .accessibilityIdentifier("catalog.message." + message.id)
                            .accessibilityFocused($focusedRow, equals: message.id)
                            .contextMenu {
                                Button("Importance…") { importanceTarget = .init(message) }
                                MailActionMenu(message: message, resolveMessage: message.providerMessageId.isEmpty) { actionTarget = $0 }
                            }
                    }
                    if reader.nextCursor != nil && !reader.offline && !reader.requiresCatalogReload {
                        action("Load more", id: "catalog.load-more", disabled: reader.loading) { Task { await load(reset: false) } }
                    }
                }
            } else { ContentUnavailableView("Saved item unavailable", systemImage: "rectangle.stack", description: Text("Reload current choices or open All Mail. Missing items are never recreated.")) }
            if let error = reader.error { Text(error).foregroundStyle(OrcaTheme.muted).accessibilityIdentifier("catalog.error") }
            if reader.requiresCatalogReload || route == nil {
                action("Reload catalog and review", id: "catalog.reload-definition") { Task { await mailboxes.load(state: state) } }
            } else {
                action(reader.messages.isEmpty ? "Try again" : "Reload results", id: "catalog.retry", disabled: reader.loading) { Task { await load() } }
            }
            action("Open All Mail", id: "catalog.all-mail", perform: onAllMail)
            Text("Search above searches All Mail in the selected account. Unfinished text waits for Search.").font(.caption)
        }.listStyle(.plain).scrollContentBackground(.hidden).accessibilityIdentifier("catalog.results")
            .onAppear { restoreFocus() }
            .onChange(of: reader.loading) { if !reader.loading { restoreFocus() } }
            .refreshable { await load() }
            .task(id: "\(state.nativeMailContext()?.key ?? "unavailable")|\(route?.fingerprint ?? "missing")|\(state.mailboxReadRevision)") { await load() }
            .sheet(item: $importanceTarget) { ImportanceView(selection: $0) }
            .sheet(item: $actionTarget) { target in MailActionsSheet(target: target) { await load() } }
    }
    private func action(_ title: String, id: String, disabled: Bool = false, perform: @escaping () -> Void) -> some View {
        Button(action: perform) { Text(title).fixedSize(horizontal: false, vertical: true).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }
            .disabled(disabled).accessibilityIdentifier(id)
    }
    private func restoreFocus() {
        guard let openedRow else { return }
        focusedRow = reader.messages.contains(where: { $0.id == openedRow }) ? openedRow : reader.messages.first?.id
        self.openedRow = nil
    }
    private func load(reset: Bool = true) async {
        guard let route, let context = state.nativeMailContext(), let client = state.client else { reader.invalidate(); return }
        if case .thread = route.target { return }
        let identity = route.fingerprint, revision = state.mailboxReadRevision
        await reader.load(route: route, context: context, client: client, cache: state.cache, reset: reset,
                          readRevision: revision.uuidString, isCurrent: {
            state.nativeMailContext() == context && state.client === client && mailboxes.selectedRoute?.fingerprint == identity && state.mailboxReadRevision == revision
        })
    }
}
