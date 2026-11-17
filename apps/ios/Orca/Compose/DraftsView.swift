import SwiftUI

struct DraftsView: View {
    @EnvironmentObject var state: AppState
    @State private var serverDrafts = [MessageDraft]()
    @State private var localDrafts = [LocalDraft]()
    @State private var error: String?
    @State private var loadGeneration = UUID()
    var body: some View {
        NavigationStack {
            Group {
                if localDrafts.isEmpty && serverDrafts.isEmpty {
                    if let error { ContentUnavailableView("Drafts unavailable", systemImage: "wifi.exclamationmark", description: Text("Local writing remains on this device. \(error)")) }
                    else { ContentUnavailableView("No drafts", systemImage: "doc.text", description: Text("Anything you start writing will be saved immediately.")) }
                } else {
                    List {
                        if !localDrafts.isEmpty { Section { DraftSectionHeader(title: "On this device", scope: "Protected local writing").listRowBackground(OrcaTheme.paper); ForEach(localDrafts) { draft in NavigationLink(destination: ComposeView(localDraft: draft)) { DraftRow(subject: draft.content.subject, recipients: draft.content.to.map(\.email), status: localStatus(draft.deliveryState), account: state.accounts.first(where: { $0.id == draft.accountId })?.email ?? "Account unavailable", preview: draft.content.body.text, savedAt: draft.modifiedAt, attachmentCount: draft.content.attachments.count) }.accessibilityIdentifier("draft.\(draft.id.uuidString)") } } }
                        let localServerIDs = Set(localDrafts.compactMap(\.serverID))
                        let cloud = serverDrafts.filter { !localServerIDs.contains($0.id) }
                        if !cloud.isEmpty { Section { DraftSectionHeader(title: "On server", scope: "Stored in Orca").listRowBackground(OrcaTheme.paper); ForEach(cloud) { draft in NavigationLink(destination: ComposeView(serverDraft: draft)) { DraftRow(subject: draft.subject, recipients: draft.to.map(\.email), status: serverStatus(draft), account: state.accounts.first(where: { $0.id == draft.accountId })?.email ?? "Account unavailable", preview: draft.body.text, savedAt: MailDate.parse(draft.updatedAt), attachmentCount: draft.attachments.count) }.accessibilityIdentifier("draft.\(draft.id)") } } }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                    .background(OrcaTheme.paper)
                    .accessibilityIdentifier("drafts.list")
                }
            }
            .background(OrcaTheme.paper.ignoresSafeArea())
            .navigationTitle("Drafts").navigationBarTitleDisplayMode(.inline)
            .toolbar { NavigationLink(destination: MailSearchView()) { Image(systemName: "magnifyingglass").frame(width: 44, height: 44) }.accessibilityLabel("Search All Mail"); NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose").accessibilityIdentifier("compose.open") }
            .task(id: state.selectedAccountID) { await load() }
            .onAppear { Task { await load() } }
            .onDisappear { loadGeneration = UUID() }
            .refreshable { await load() }
        }
    }
    func localStatus(_ deliveryState: String) -> String { switch deliveryState { case "ambiguous", "sending": "Delivery uncertain — check before retrying"; case "rejected": "Delivery rejected — edit a new copy"; case "sent": "Sent elsewhere — local edits kept"; default: "Saved locally" } }
    func serverStatus(_ draft: MessageDraft) -> String {
        switch draft.deliveryStatus {
        case "sending", "ambiguous", "rejected": return localStatus(draft.deliveryStatus)
        default: return draft.providerSyncStatus == "failed" ? "Provider copy needs attention" : "Saved · revision \(draft.revision)"
        }
    }
    func load() async {
        let generation = UUID(); loadGeneration = generation
        guard let account = state.selectedAccount else { localDrafts = []; serverDrafts = []; return }
        let scope = state.ownerScope, accountID = account.id, client = state.client
        func identityIsCurrent() -> Bool {
            !Task.isCancelled && generation == loadGeneration && scope == state.ownerScope
                && state.selectedAccount?.id == accountID && state.client === client
        }
        serverDrafts = []; error = nil
        let stored = await state.draftStore.all(ownerScope: scope, accountId: accountID)
        guard identityIsCurrent() else { return }; localDrafts = stored
        guard !state.demoMode, let client else { return }
        do {
            let loaded = try await client.drafts(accountId: accountID)
            guard identityIsCurrent() else { return }
            let latest = await state.draftStore.all(ownerScope: scope, accountId: accountID)
            guard identityIsCurrent() else { return }
            let linkedIDs = Set(latest.compactMap(\.serverID))
            var reconciliationFailed = false
            for item in loaded where item.deliveryStatus == "sent" && linkedIDs.contains(item.id) {
                do {
                    // The list may omit sent bodies/attachments. Compare only a
                    // full verified detail against the actor's latest writing.
                    let remote = try await client.draft(item.id, accountId: accountID)
                    guard identityIsCurrent() else { return }
                    _ = try await state.draftStore.reconcileSent(remote, ownerScope: scope, accountId: accountID)
                    guard identityIsCurrent() else { return }
                } catch {
                    guard identityIsCurrent() else { return }
                    reconciliationFailed = true
                }
            }
            let reconciled = await state.draftStore.all(ownerScope: scope, accountId: accountID)
            guard identityIsCurrent() else { return }
            localDrafts = reconciled; serverDrafts = loaded.filter { $0.deliveryStatus != "sent" }
            error = reconciliationFailed ? "Some sent drafts could not be checked. Local writing was kept." : nil
        } catch { guard identityIsCurrent() else { return }; self.error = error.localizedDescription }
    }

}
private struct DraftRow: View {
    var subject: String; var recipients: [String]; var status: String
    var account: String; var preview: String; var savedAt: Date?; var attachmentCount: Int
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
            Text(account).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(preview).font(OrcaTheme.ui(13)).foregroundStyle(OrcaTheme.muted).lineLimit(2)
            }
            if let savedAt {
                (Text("Saved ") + Text(savedAt, style: .relative)).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            } else { Text("Saved time unavailable").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted) }
            if attachmentCount > 0 {
                Label("\(attachmentCount) \(attachmentCount == 1 ? "attachment" : "attachments")", systemImage: "paperclip")
                    .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            }
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OrcaTheme.paper)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
