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
                        if !localDrafts.isEmpty { Section("On this device") { ForEach(localDrafts) { draft in NavigationLink(destination: ComposeView(localDraft: draft)) { DraftRow(subject: draft.content.subject, recipients: draft.content.to.map(\.email), status: draft.deliveryState == "ambiguous" ? "Delivery uncertain — check before retrying" : "Saved locally") }.accessibilityIdentifier("draft.\(draft.id.uuidString)") } } }
                        let localServerIDs = Set(localDrafts.compactMap(\.serverID))
                        let cloud = serverDrafts.filter { !localServerIDs.contains($0.id) }
                        if !cloud.isEmpty { Section("On server") { ForEach(cloud) { draft in NavigationLink(destination: ComposeView(serverDraft: draft)) { DraftRow(subject: draft.subject, recipients: draft.to.map(\.email), status: draft.providerSyncStatus == "failed" ? "Provider copy needs attention" : "Saved · revision \(draft.revision)") }.accessibilityIdentifier("draft.\(draft.id)") } } }
                    }.accessibilityIdentifier("drafts.list")
                }
            }
            .navigationTitle("Drafts")
            .toolbar { NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose").accessibilityIdentifier("compose.open") }
            .task(id: state.selectedAccountID) { await load() }
            .refreshable { await load() }
        }
    }
    func load() async {
        guard let account = state.selectedAccount else { return }
        localDrafts = await state.draftStore.all(ownerScope: state.ownerScope, accountId: account.id)
        guard !state.demoMode, let client = state.client else { return }
        do { serverDrafts = try await client.drafts(accountId: account.id); error = nil } catch { self.error = error.localizedDescription }
    }
}
private struct DraftRow: View {
    var subject: String; var recipients: [String]; var status: String
    var body: some View { VStack(alignment: .leading) { Text(subject.isEmpty ? "(No subject)" : subject).font(.headline); Text(recipients.joined(separator: ", ")).foregroundStyle(.secondary).lineLimit(1); Text(status).font(.caption).foregroundStyle(status.contains("uncertain") || status.contains("attention") ? .orange : .secondary) }.accessibilityElement(children: .combine) }
}
