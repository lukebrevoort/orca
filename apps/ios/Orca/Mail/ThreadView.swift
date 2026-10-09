import SwiftUI

struct ThreadView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @EnvironmentObject var state: AppState; let accountId: String; let threadId: String; @State private var detail: ThreadDetail?; @State private var error: String?; @State private var shareURL: URL?
    @State private var expanded: Set<String> = []
    @State private var showEarlier = false
    @State private var entryID: String?
    @State private var unreadEntryID: String?
    @State private var messageFrames: [String: CGRect] = [:]
    private var visibleMessageIDs: Set<String> { Set(messageFrames.filter { ReaderNavigationVisibility.isVisible($0.value, viewportHeight: viewportHeight) }.map(\.key)) }
    @State private var viewportHeight: CGFloat = 0
    @State private var headerOffset: CGFloat = 0
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
                    if firstIndex > 0 {
                        HStack(spacing: 12) {
                            Rectangle().fill(OrcaTheme.border).frame(height: 1).accessibilityHidden(true)
                            Button { showEarlier.toggle() } label: {
                                HStack(spacing: 8) {
                                    Text("\(firstIndex) earlier messages")
                                    Image(systemName: showEarlier ? "chevron.up" : "chevron.down")
                                }.font(OrcaTheme.ui(12)).frame(minHeight: 44).padding(.horizontal, 8).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(OrcaTheme.ink)
                            .accessibilityLabel("\(showEarlier ? "Hide" : "Show") \(firstIndex) earlier messages")
                            .accessibilityValue(showEarlier ? "Expanded" : "Collapsed")
                            Rectangle().fill(OrcaTheme.border).frame(height: 1).accessibilityHidden(true)
                        }
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
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: ReaderMessageFramesKey.self, value: [item.id: geometry.frame(in: .named("threadViewport"))])
                            })
                        }
                    }
                }.padding(24)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ReaderHeaderOffsetKey.self, value: geometry.frame(in: .named("threadViewport")).minY)
                })
            } else if let error {
                ContentUnavailableView("Conversation unavailable", systemImage: "exclamationmark.bubble", description: Text(error))
                Button("Try again") { Task { await load() } }
            } else { ProgressView("Getting conversation").padding(.top, 80) }
        }.background(OrcaTheme.paper)
        .coordinateSpace(name: "threadViewport")
        .background(GeometryReader { geometry in
            Color.clear.preference(key: ReaderViewportHeightKey.self, value: geometry.size.height)
        })
        .onPreferenceChange(ReaderViewportHeightKey.self) { viewportHeight = $0 }
        .onPreferenceChange(ReaderHeaderOffsetKey.self) { headerOffset = $0 }
        .onPreferenceChange(ReaderMessageFramesKey.self) { frames in
            messageFrames = frames
        }
        .overlay(alignment: .bottomTrailing) {
            if let detail, viewportHeight > 0 {
                let messages = detail.messages.sorted { $0.receivedAt == $1.receivedAt ? $0.id < $1.id : $0.receivedAt < $1.receivedAt }
                let unread = messages.first(where: { $0.id == unreadEntryID }) ?? messages.first(where: \.unread)
                let showUnread = unread.map { !visibleMessageIDs.contains($0.id) && (headerOffset < -40 || showEarlier) } ?? false
                HStack(spacing: 8) {
                    if let unread, showUnread {
                        Button("Jump to unread") { jump(unread.id, proxy: proxy) }
                            .accessibilityIdentifier("thread.jump-unread")
                    }
                    if let newest = messages.last, !visibleMessageIDs.contains(newest.id), !(showUnread && newest.id == unread?.id) {
                        Button("Jump to latest") { jump(newest.id, proxy: proxy) }
                            .accessibilityIdentifier("thread.jump-latest")
                    }
                }
                .font(OrcaTheme.ui(12)).buttonStyle(ReaderJumpButtonStyle())
                .padding(12)
            }
        }
        }
        .navigationTitle("Conversation").navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let detail {
                    Menu {
                        Button("Expand all") { expanded = Set(detail.messages.map(\.id)); showEarlier = true }
                        Button("Collapse all") { expanded = Set(entryID.map { [$0] } ?? []); showEarlier = false }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
                    }.accessibilityLabel("Conversation actions").accessibilityIdentifier("thread.actions")
                        .foregroundStyle(OrcaTheme.ink)
                }
            }
        }
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
            unreadEntryID = ordered.first(where: \.unread)?.id
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


private struct ReaderJumpButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.padding(.horizontal, 14).frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(OrcaTheme.ink)
            .background(configuration.isPressed ? OrcaTheme.paper : OrcaTheme.surface, in: Capsule())
            .overlay(Capsule().stroke(OrcaTheme.border))
    }
}
private struct ReaderMessageFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}
private struct ReaderViewportHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
private struct ReaderHeaderOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
enum ReaderNavigationVisibility {
    static func isVisible(_ frame: CGRect, viewportHeight: CGFloat) -> Bool {
        viewportHeight > 0 && frame.height > 0 && frame.maxY > 0 && frame.minY < viewportHeight
    }
}
