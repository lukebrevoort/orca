import SwiftUI

struct DraftsView: View {
    @EnvironmentObject var state: AppState; @State private var serverDrafts = [MessageDraft](); @State private var error: String?
    var body: some View { NavigationStack { Group { if let error, serverDrafts.isEmpty { ContentUnavailableView("Drafts unavailable", systemImage: "wifi.exclamationmark", description: Text("Local writing remains on this device. \(error)")) } else if serverDrafts.isEmpty { ContentUnavailableView("No drafts", systemImage: "doc.text", description: Text("Anything you start writing will be saved immediately.")) } else { List(serverDrafts) { draft in VStack(alignment: .leading) { Text(draft.subject.isEmpty ? "(No subject)" : draft.subject).font(.headline); Text(draft.to.map(\.email).joined(separator: ", ")).foregroundStyle(.secondary).lineLimit(1); Text(draft.providerSyncStatus == "failed" ? "Saved locally · provider copy needs attention" : "Saved · revision \(draft.revision)").font(.caption).foregroundStyle(draft.providerSyncStatus == "failed" ? .orange : .secondary) }.accessibilityElement(children: .combine) } } }.navigationTitle("Drafts").toolbar { NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil") }.accessibilityLabel("Compose") }.task(id: state.selectedAccountID) { await load() }.refreshable { await load() } } }
    func load() async { guard !state.demoMode, let account = state.selectedAccount, let client = state.client else { return }; do { serverDrafts = try await client.drafts(accountId: account.id); error = nil } catch { self.error = error.localizedDescription } }
}

