import SwiftUI

struct ThreadView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject var state: AppState; let accountId: String; let threadId: String; @State private var detail: ThreadDetail?; @State private var error: String?; @State private var shareURL: URL?
    @State private var expanded: Set<String> = []
    @State private var showEarlier = false
    @State private var entryID: String?
    @AccessibilityFocusState private var focusedMessage: String?
    init(message: InboxMessage) { accountId = message.accountId; threadId = message.threadId }
    init(accountId: String, threadId: String) { self.accountId = accountId; self.threadId = threadId }
    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            if let detail {
                LazyVStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("CONVERSATION").font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1.5).foregroundStyle(OrcaTheme.accent)
                        DisclosureGroup("Attention: " + (detail.thread.attention.attentionBehavior ?? "normal").capitalized) {
                            Text("Attention sets the order: Notify, Focus, Normal, Quiet, then Hidden; dates sort within each group. This value is separate from the destination. The winning rule is unavailable in this response.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                        }.font(OrcaTheme.ui(12))
                        Text(detail.thread.subject.isEmpty ? "(No subject)" : detail.thread.subject).font(OrcaTheme.reader(34)).tracking(-0.6).foregroundStyle(OrcaTheme.ink).fixedSize(horizontal: false, vertical: true)
                    }
                    if let error { Label(error, systemImage: "info.circle").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted).accessibilityIdentifier("thread.status") }
                    let messages = detail.messages.sorted { $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt < $1.receivedAt }
                    let entry = messages.first(where: { $0.id == entryID }) ?? messages.first(where: \.unread) ?? messages.last
                    let firstIndex = messages.firstIndex(where: { $0.id == entry?.id }) ?? 0
                    let controlLayout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))
                    controlLayout {
                        Button("First unread") { if let item = messages.first(where: \.unread) { jump(item.id, proxy: proxy) } }.disabled(!messages.contains(where: \.unread))
                        Button("Newest ↓") { if let item = messages.last { jump(item.id, proxy: proxy) } }
                        Button(expanded.count == messages.count ? "Collapse all" : "Expand all") {
                            if expanded.count == messages.count { expanded = Set(entry.map { [$0.id] } ?? []); showEarlier = false }
                            else { expanded = Set(messages.map(\.id)); showEarlier = true }
                        }
                    }.font(OrcaTheme.ui(12)).buttonStyle(.bordered)
                    if firstIndex > 0 {
                        Button("\(showEarlier ? "Hide" : "Show") \(firstIndex) earlier messages") { showEarlier.toggle() }
                            .font(OrcaTheme.ui(13)).buttonStyle(.bordered)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, item in
                        if showEarlier || index >= firstIndex {
                        VStack(alignment: .leading, spacing: 16) {
                            Button {
                                if expanded.contains(item.id) { expanded.remove(item.id) } else { expanded.insert(item.id) }
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack {
                                        ContactGlyph(contact: item.from)
                                        Text(item.from.name ?? item.from.email).font(OrcaTheme.ui(13, weight: .semibold))
                                        Spacer()
                                        Image(systemName: expanded.contains(item.id) ? "chevron.up" : "chevron.down")
                                    }
                                    Text(MailDate.full(item.receivedAt)).font(OrcaTheme.ui(11))
                                    Text("To " + item.to.map { $0.name ?? $0.email }.joined(separator: ", ")).font(OrcaTheme.ui(12))
                                    if item.unread { Text("Unread").font(OrcaTheme.ui(11, weight: .semibold)) }
                                    if !expanded.contains(item.id) { Text(MailPreview.decode(item.snippet)).font(OrcaTheme.ui(13)).lineLimit(2) }
                                }.foregroundStyle(OrcaTheme.ink).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .accessibilityValue(expanded.contains(item.id) ? "Expanded" : "Collapsed")
                                .accessibilityFocused($focusedMessage, equals: item.id)
                            if expanded.contains(item.id) {
                            DisclosureGroup("Message details") {
                                Text("From: " + item.from.email)
                                Text("To: " + item.to.map(\.email).joined(separator: ", "))
                                if !item.cc.isEmpty { Text("Cc: " + item.cc.map(\.email).joined(separator: ", ")) }
                                if !item.bcc.isEmpty { Text("Bcc: " + item.bcc.map(\.email).joined(separator: ", ")) }
                            }.font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                            NativeReaderBody(html: item.bodyHtml, text: item.bodyText)
                            ForEach(item.attachments) { attachment in
                                Button { Task { await download(attachment) } } label: {
                                    Label("\(attachment.filename) · \(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))", systemImage: "paperclip").font(OrcaTheme.ui(12))
                                }.buttonStyle(.bordered)
                            }
                            }
                        }.padding(16).background(OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(OrcaTheme.border)).id(item.id)
                        }
                    }
                }.padding(24)
            } else if let error {
                ContentUnavailableView("Conversation unavailable", systemImage: "exclamationmark.bubble", description: Text(error))
                Button("Try again") { Task { await load() } }
            } else { ProgressView("Getting conversation").padding(.top, 80) }
        }.background(OrcaTheme.paper)
        }
        .navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom) {
            if let detail {
                replyActions(detail).font(OrcaTheme.ui(12)).padding(.horizontal, 20).padding(.vertical, 12).background(OrcaTheme.paper)
                    .overlay(alignment: .top) { Rectangle().fill(OrcaTheme.border).frame(height: 1) }
            }
        }
        .task { await load() }.sheet(isPresented: .constant(shareURL != nil), onDismiss: { if let shareURL { try? FileManager.default.removeItem(at: shareURL.deletingLastPathComponent()) }; shareURL = nil }) { if let shareURL { ShareSheet(items: [shareURL]) } }
    }
    @ViewBuilder
    private func replyActions(_ detail: ThreadDetail) -> some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        // Keep the same links alive as text size changes, including while a
        // composer is open. Only their layout and labels adapt.
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            NavigationLink(destination: ComposeView(context: detail, kind: "reply")) {
                Label("Reply", systemImage: "arrowshape.turn.up.left")
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: stacked ? .infinity : nil)
            }.buttonStyle(OrcaPrimaryButtonStyle()).accessibilityLabel("Reply")
            Spacer(minLength: 0)
                .frame(width: stacked ? 0 : nil, height: stacked ? 0 : nil)
                .accessibilityHidden(true)
            NavigationLink(destination: ComposeView(context: detail, kind: "reply_all")) {
                Text("Reply all")
                    .frame(maxWidth: stacked ? .infinity : nil, minHeight: 44,
                           alignment: stacked ? .leading : .center)
                    .padding(.horizontal, stacked ? 16 : 0).contentShape(Rectangle())
            }.accessibilityLabel("Reply all")
            NavigationLink(destination: ComposeView(context: detail, kind: "forward")) {
                if stacked {
                    Label("Forward", systemImage: "arrowshape.turn.up.right")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16).contentShape(Rectangle())
                } else {
                    Image(systemName: "arrowshape.turn.up.right").frame(width: 44, height: 44)
                }
            }.accessibilityLabel("Forward")
        }
    }

    private func accept(_ loaded: ThreadDetail) {
        if detail == nil {
            let ordered = loaded.messages.sorted { $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt < $1.receivedAt }
            entryID = (ordered.first(where: \.unread) ?? ordered.last)?.id
            expanded = Set(entryID.map { [$0] } ?? [])
        }
        detail = loaded
    }
    private func jump(_ id: String, proxy: ScrollViewProxy) {
        expanded.insert(id)
        // Scroll after the expanded card participates in layout.
        DispatchQueue.main.async {
            proxy.scrollTo(id, anchor: .top)
            focusedMessage = id
        }
    }

    func load() async {
        guard !state.demoMode else { error = "Demo conversations are list-only."; return }
        guard let client = state.client, state.selectedAccount?.id == accountId else { return }
        let scope = state.ownerScope, key = "\(state.ownerScope)|\(accountId)|thread|\(threadId)"
        func identityIsCurrent() -> Bool { !Task.isCancelled && scope == state.ownerScope && state.selectedAccount?.id == accountId }
        do {
            let loaded = try await client.thread(threadId, accountId: accountId)
            guard identityIsCurrent() else { return }; accept(loaded); error = nil
            try? await state.cache.save(loaded, key: key)
            guard identityIsCurrent() else { return }; try? await client.markRead(threadId, accountId: accountId)
        } catch {
            guard identityIsCurrent() else { return }
            if let cached: ThreadDetail = await state.cache.load(ThreadDetail.self, key: key) { guard identityIsCurrent() else { return }; accept(cached); self.error = "Offline — showing saved conversation" }
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


private struct NativeReaderBody: View {
    let html: String?
    let text: String?
    @State private var original = false
    @State private var plain: Bool?
    var body: some View {
        let showPlain = plain ?? (text.map { ReaderQuoteParts.split($0).quoted != nil } ?? false)
        VStack(alignment: .leading, spacing: 12) {
            if let html, !html.isEmpty, !showPlain { SafeHTMLView(html: html).fixedSize(horizontal: false, vertical: true) }
            else if let text {
                let parts = ReaderQuoteParts.split(text)
                Text(original ? text : parts.current).font(OrcaTheme.reader(22)).lineSpacing(7).foregroundStyle(OrcaTheme.ink).textSelection(.enabled)
                if !original, let quote = parts.quoted {
                    DisclosureGroup("Show quoted history") { Text(quote).font(OrcaTheme.reader(20)).textSelection(.enabled) }
                }
                Button(original ? "Return to reading view" : "Show complete original text") { original.toggle() }.font(OrcaTheme.ui(12))
            } else { Text("Readable body unavailable").foregroundStyle(OrcaTheme.muted) }
            if let text, !text.isEmpty, let html, !html.isEmpty {
                Button(showPlain ? "Formatted message" : "Plain text") { plain = !showPlain }.font(OrcaTheme.ui(12))
            }
        }
    }
}

enum ReaderQuoteParts {
    static func split(_ body: String) -> (current: String, quoted: String?) {
        // Only a trailing marker followed entirely by quoted/blank lines folds.
        // Keep offsets into the original String so CRLF and whitespace survive.
        let pattern = #"(?im)^[ \t]*On .+wrote:[ \t]*\r?\n(?:[ \t]*>[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)+\z"#
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)),
              match.range.location > 0,
              let range = Range(match.range, in: body) else { return (body, nil) }
        return (String(body[..<range.lowerBound]), String(body[range]))
    }
}
