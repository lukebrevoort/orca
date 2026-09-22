import SwiftUI

struct ThreadView: View {
    @EnvironmentObject var state: AppState; let message: InboxMessage; @State private var detail: ThreadDetail?; @State private var error: String?; @State private var shareURL: URL?
    var body: some View { ScrollView { if let detail { LazyVStack(alignment: .leading, spacing: 16) { if let error { Label(error, systemImage: "info.circle").font(.callout).foregroundStyle(.secondary).padding(.horizontal).accessibilityIdentifier("thread.status") }; ForEach(detail.messages) { item in VStack(alignment: .leading, spacing: 10) { HStack { ContactGlyph(contact: item.from); VStack(alignment: .leading) { Text(item.from.name ?? item.from.email).font(.headline); Text(item.receivedAt).font(.caption).foregroundStyle(.secondary) } }; if let html = item.bodyHtml, !html.isEmpty { SafeHTMLView(html: html).fixedSize(horizontal: false, vertical: true) } else { Text(item.bodyText ?? item.snippet).textSelection(.enabled) }; ForEach(item.attachments) { attachment in Button { Task { await download(attachment) } } label: { Label("\(attachment.filename) · \(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))", systemImage: "paperclip") }.buttonStyle(.bordered) }; Divider() }.padding(.horizontal) } }.padding(.vertical) } else if let error { ContentUnavailableView("Conversation unavailable", systemImage: "exclamationmark.bubble", description: Text(error)); Button("Try again") { Task { await load() } } } else { ProgressView("Getting conversation").padding(.top, 80) } }
        .navigationTitle(detail?.thread.subject ?? message.subject).navigationBarTitleDisplayMode(.inline)
        .toolbar { if let detail { ToolbarItemGroup(placement: .bottomBar) { NavigationLink(destination: ComposeView(context: detail, kind: "reply")) { Label("Reply", systemImage: "arrowshape.turn.up.left") }; Spacer(); NavigationLink(destination: ComposeView(context: detail, kind: "reply_all")) { Label("Reply all", systemImage: "arrowshape.turn.up.left.2") }; Spacer(); NavigationLink(destination: ComposeView(context: detail, kind: "forward")) { Label("Forward", systemImage: "arrowshape.turn.up.right") } } } }
        .task { await load() }.sheet(isPresented: .constant(shareURL != nil), onDismiss: { if let shareURL { try? FileManager.default.removeItem(at: shareURL.deletingLastPathComponent()) }; shareURL = nil }) { if let shareURL { ShareSheet(items: [shareURL]) } }
    }
    func load() async {
        guard !state.demoMode else { error = "Demo conversations are list-only."; return }
        guard let client = state.client, state.selectedAccount?.id == message.accountId else { return }
        let scope = state.ownerScope, key = "\(state.ownerScope)|\(message.accountId)|thread|\(message.threadId)"
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == message.accountId }
        do {
            let loaded = try await client.thread(message.threadId, accountId: message.accountId)
            guard identityIsCurrent() else { return }; detail = loaded; error = nil
            try? await state.cache.save(loaded, key: key)
            guard identityIsCurrent() else { return }; try? await client.markRead(message.threadId, accountId: message.accountId)
        } catch {
            guard identityIsCurrent() else { return }
            if let cached: ThreadDetail = await state.cache.load(ThreadDetail.self, key: key) { guard identityIsCurrent() else { return }; detail = cached; self.error = "Offline — showing saved conversation" }
            else { self.error = error.localizedDescription }
        }
    }
    func download(_ attachment: MailAttachment) async {
        guard let client = state.client, state.selectedAccount?.id == message.accountId else { return }
        let scope = state.ownerScope
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == message.accountId }
        var temporaryDirectory: URL?
        do {
            let data = try await client.attachment(attachment.id, accountId: message.accountId); guard identityIsCurrent() else { return }
            let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString); temporaryDirectory = dir
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let safeName = attachment.filename.unicodeScalars.map { CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._- ")).contains($0) ? String($0) : "_" }.joined().replacingOccurrences(of: "..", with: "_")
            let url = dir.appending(path: safeName.isEmpty ? "attachment" : safeName); try data.write(to: url, options: [.atomic, .completeFileProtection])
            guard identityIsCurrent() else { try? FileManager.default.removeItem(at: dir); return }
            shareURL = url; error = nil; temporaryDirectory = nil
        } catch {
            if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
            guard identityIsCurrent() else { return }; self.error = "Attachment failed: \(error.localizedDescription)"
        }
    }
}
struct ShareSheet: UIViewControllerRepresentable { let items: [Any]; func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }; func updateUIViewController(_ controller: UIActivityViewController, context: Context) {} }
