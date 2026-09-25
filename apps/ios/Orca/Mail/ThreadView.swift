import SwiftUI

struct ThreadView: View {
    @EnvironmentObject var state: AppState; let accountId: String; let threadId: String; @State private var detail: ThreadDetail?; @State private var error: String?; @State private var shareURL: URL?
    init(message: InboxMessage) { accountId = message.accountId; threadId = message.threadId }
    init(accountId: String, threadId: String) { self.accountId = accountId; self.threadId = threadId }
    var body: some View {
        ScrollView {
            if let detail {
                LazyVStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("CONVERSATION").font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1.5).foregroundStyle(OrcaTheme.accent)
                        Text(detail.thread.subject.isEmpty ? "(No subject)" : detail.thread.subject).font(OrcaTheme.reader(34)).tracking(-0.6).foregroundStyle(OrcaTheme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                    if let error { Label(error, systemImage: "info.circle").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted).accessibilityIdentifier("thread.status") }
                    // The API is oldest-first. Reverse only the reading order so
                    // opening a conversation shows the latest reply immediately.
                    // Keep the original detail for Reply / Reply all / Forward.
                    ForEach(detail.messages.reversed()) { item in
                        VStack(alignment: .leading, spacing: 22) {
                            HStack(spacing: 12) {
                                ContactGlyph(contact: item.from)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(item.from.name ?? item.from.email).font(OrcaTheme.ui(13, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                                    Text(MailDate.full(item.receivedAt)).font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
                                }
                            }
                            if let html = item.bodyHtml, !html.isEmpty { SafeHTMLView(html: html).fixedSize(horizontal: false, vertical: true) }
                            else { Text(item.bodyText ?? item.snippet).font(OrcaTheme.reader(22)).lineSpacing(7).foregroundStyle(OrcaTheme.ink).textSelection(.enabled) }
                            ForEach(item.attachments) { attachment in
                                Button { Task { await download(attachment) } } label: {
                                    Label("\(attachment.filename) · \(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))", systemImage: "paperclip").font(OrcaTheme.ui(12))
                                }.buttonStyle(.bordered)
                            }
                            Rectangle().fill(OrcaTheme.border).frame(height: 1)
                        }
                    }
                }.padding(24)
            } else if let error {
                ContentUnavailableView("Conversation unavailable", systemImage: "exclamationmark.bubble", description: Text(error))
                Button("Try again") { Task { await load() } }
            } else { ProgressView("Getting conversation").padding(.top, 80) }
        }.background(OrcaTheme.paper)
        .navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom) {
            if let detail {
                HStack(spacing: 12) {
                    NavigationLink(destination: ComposeView(context: detail, kind: "reply")) { Label("Reply", systemImage: "arrowshape.turn.up.left") }.buttonStyle(OrcaPrimaryButtonStyle())
                    Spacer(minLength: 0)
                    NavigationLink(destination: ComposeView(context: detail, kind: "reply_all")) { Text("Reply all").frame(minHeight: 44).contentShape(Rectangle()) }.accessibilityLabel("Reply all")
                    NavigationLink(destination: ComposeView(context: detail, kind: "forward")) { Image(systemName: "arrowshape.turn.up.right").frame(width: 44, height: 44) }.accessibilityLabel("Forward")
                }.font(OrcaTheme.ui(12)).padding(.horizontal, 20).padding(.vertical, 12).background(OrcaTheme.paper)
                    .overlay(alignment: .top) { Rectangle().fill(OrcaTheme.border).frame(height: 1) }
            }
        }
        .task { await load() }.sheet(isPresented: .constant(shareURL != nil), onDismiss: { if let shareURL { try? FileManager.default.removeItem(at: shareURL.deletingLastPathComponent()) }; shareURL = nil }) { if let shareURL { ShareSheet(items: [shareURL]) } }
    }
    func load() async {
        guard !state.demoMode else { error = "Demo conversations are list-only."; return }
        guard let client = state.client, state.selectedAccount?.id == accountId else { return }
        let scope = state.ownerScope, key = "\(state.ownerScope)|\(accountId)|thread|\(threadId)"
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == accountId }
        do {
            let loaded = try await client.thread(threadId, accountId: accountId)
            guard identityIsCurrent() else { return }; detail = loaded; error = nil
            try? await state.cache.save(loaded, key: key)
            guard identityIsCurrent() else { return }; try? await client.markRead(threadId, accountId: accountId)
        } catch {
            guard identityIsCurrent() else { return }
            if let cached: ThreadDetail = await state.cache.load(ThreadDetail.self, key: key) { guard identityIsCurrent() else { return }; detail = cached; self.error = "Offline — showing saved conversation" }
            else { self.error = error.localizedDescription }
        }
    }
    func download(_ attachment: MailAttachment) async {
        guard let client = state.client, state.selectedAccount?.id == accountId else { return }
        let scope = state.ownerScope
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == accountId }
        var temporaryDirectory: URL?
        do {
            let data = try await client.attachment(attachment.id, accountId: accountId); guard identityIsCurrent() else { return }
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
