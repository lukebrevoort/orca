import SwiftUI

struct DraftsView: View {
    @EnvironmentObject var state: AppState
    @State private var serverDrafts = [MessageDraft]()
    @State private var localDrafts = [LocalDraft]()
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Group {
                if localDrafts.isEmpty && serverDrafts.isEmpty {
                    if let error { ContentUnavailableView("Drafts unavailable", systemImage: "wifi.exclamationmark", description: Text("Local writing remains on this device. \(error)")) }
                    else { ContentUnavailableView("No drafts", systemImage: "doc.text", description: Text("Anything you start writing will be saved immediately.")) }
                } else {
                    List {
                        if !localDrafts.isEmpty { Section { ForEach(localDrafts) { draft in NavigationLink(destination: ComposeView(localDraft: draft)) { DraftRow(subject: draft.content.subject, recipients: draft.content.to.map(\.email), status: localStatus(draft.deliveryState)) }.accessibilityIdentifier("draft.\(draft.id.uuidString)") } } header: { DraftSectionHeader(title: "On this device", scope: "Protected local writing") } }
                        let localServerIDs = Set(localDrafts.compactMap(\.serverID))
                        let cloud = serverDrafts.filter { !localServerIDs.contains($0.id) }
                        if !cloud.isEmpty { Section { ForEach(cloud) { draft in NavigationLink(destination: ComposeView(serverDraft: draft)) { DraftRow(subject: draft.subject, recipients: draft.to.map(\.email), status: draft.providerSyncStatus == "failed" ? "Provider copy needs attention" : "Saved · revision \(draft.revision)") }.accessibilityIdentifier("draft.\(draft.id)") } } header: { DraftSectionHeader(title: "On server", scope: "Synced with your provider") } }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(OrcaTheme.paper)
                    .accessibilityIdentifier("drafts.list")
                }
            }
            .background(OrcaTheme.paper.ignoresSafeArea())
            .navigationTitle("Drafts").navigationBarTitleDisplayMode(.inline)
            .toolbar { NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose").accessibilityIdentifier("compose.open") }
            .task(id: state.selectedAccountID) { await load() }
            .onAppear { Task { await load() } }
            .refreshable { await load() }
        }
    }
    func localStatus(_ deliveryState: String) -> String { switch deliveryState { case "ambiguous", "sending": "Delivery uncertain — check before retrying"; case "rejected": "Delivery rejected — edit a new copy"; default: "Saved locally" } }
    func load() async {
        guard let account = state.selectedAccount else { localDrafts = []; serverDrafts = []; return }
        let scope = state.ownerScope, accountID = account.id, client = state.client
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == accountID }
        serverDrafts = []; error = nil
        let stored = await state.draftStore.all(ownerScope: scope, accountId: accountID)
        guard identityIsCurrent() else { return }; localDrafts = stored
        guard !state.demoMode, let client else { return }
        do { let loaded = try await client.drafts(accountId: accountID); guard identityIsCurrent() else { return }; serverDrafts = loaded.filter { $0.deliveryStatus != "sent" }; error = nil }
        catch { guard identityIsCurrent() else { return }; self.error = error.localizedDescription }
    }
}
private struct DraftRow: View {
    var subject: String; var recipients: [String]; var status: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(subject.isEmpty ? "(No subject)" : subject)
                .font(OrcaTheme.reader(20))
                .foregroundStyle(OrcaTheme.ink)
                .lineLimit(2)
            Text(recipients.isEmpty ? "No recipients yet" : recipients.joined(separator: ", "))
                .font(OrcaTheme.ui(12))
                .foregroundStyle(OrcaTheme.muted)
                .lineLimit(1)
            Text(status)
                .font(OrcaTheme.ui(10, weight: .semibold))
                .foregroundStyle(status.contains("uncertain") || status.contains("attention") ? .orange : OrcaTheme.muted)
                .textCase(.uppercase)
                .tracking(0.5)
        }
        .padding(.vertical, 9)
        .accessibilityElement(children: .combine)
    }
}

private struct DraftSectionHeader: View {
    var title: String
    var scope: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(OrcaTheme.ui(11, weight: .bold)).foregroundStyle(OrcaTheme.ink)
            Spacer()
            Text(scope).font(OrcaTheme.ui(9, weight: .medium)).foregroundStyle(OrcaTheme.muted)
        }
        .textCase(nil)
        .padding(.top, 10)
    }
}
