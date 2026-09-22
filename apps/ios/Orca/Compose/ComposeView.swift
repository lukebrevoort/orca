import SwiftUI

struct ComposeView: View {
    @EnvironmentObject var state: AppState; @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) private var scenePhase
    var context: ThreadDetail?; var kind = "new"; private var seedServer: MessageDraft?
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var messageBody = ""
    @State private var local: LocalDraft?
    @State private var status = "Saved locally"
    @State private var sending = false
    @State private var saveTask: Task<Void, Never>?
    @State private var showingImporter = false
    @State private var draftAccountID: String?
    @State private var draftOwnerScope: String?
    @State private var completed = false
    init(context: ThreadDetail? = nil, kind: String = "new", localDraft: LocalDraft? = nil, serverDraft: MessageDraft? = nil) {
        self.context = context; self.kind = kind; seedServer = serverDraft
        let content = localDraft?.content ?? serverDraft.map { DraftContent(to: $0.to, cc: $0.cc, bcc: $0.bcc, subject: $0.subject, body: $0.body, context: $0.context, attachments: $0.attachments) }
        _to = State(initialValue: localDraft?.recipientText?.to ?? content?.to.map(\.email).joined(separator: ", ") ?? "")
        _cc = State(initialValue: localDraft?.recipientText?.cc ?? content?.cc.map(\.email).joined(separator: ", ") ?? "")
        _bcc = State(initialValue: localDraft?.recipientText?.bcc ?? content?.bcc.map(\.email).joined(separator: ", ") ?? "")
        _subject = State(initialValue: content?.subject ?? ""); _messageBody = State(initialValue: content?.body.text ?? ""); _local = State(initialValue: localDraft)
        _draftAccountID = State(initialValue: localDraft?.accountId ?? serverDraft?.accountId); _draftOwnerScope = State(initialValue: localDraft?.ownerScope)
    }
    var body: some View { Form { Section("Recipients") { TextField("To", text: $to).textContentType(.emailAddress).textInputAutocapitalization(.never).keyboardType(.emailAddress).accessibilityIdentifier("compose.to"); DisclosureGroup("Cc and Bcc") { TextField("Cc", text: $cc); TextField("Bcc", text: $bcc) } }.disabled(deliveryFrozen); Section { TextField("Subject", text: $subject).accessibilityIdentifier("compose.subject"); TextEditor(text: $messageBody).frame(minHeight: 240).accessibilityLabel("Message body").accessibilityIdentifier("compose.body"); Button { showingImporter = true } label: { Label("Attach file", systemImage: "paperclip") }.disabled(deliveryFrozen); if let local { ForEach(local.content.attachments) { Text($0.filename).font(.caption) } } }.disabled(deliveryFrozen); Section { HStack { Label(status, systemImage: status.contains("failed") ? "exclamationmark.triangle" : "checkmark.circle").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("compose.save-status"); Spacer(); Button(deliveryFrozen ? "Check delivery" : "Send") { Task { await send() } }.disabled(sending || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || deliveryFrozen && local?.idempotencyKey == nil).accessibilityIdentifier("compose.send") } } }.accessibilityIdentifier("compose.form")
        .navigationTitle(kind == "new" ? "New message" : kind.replacingOccurrences(of: "_", with: " ").capitalized).navigationBarTitleDisplayMode(.inline)
        .task { if draftAccountID == nil { draftAccountID = state.selectedAccount?.id }; if draftOwnerScope == nil { draftOwnerScope = state.ownerScope }; seed(); _ = await saveLocal() }.onChange(of: snapshot) { saveTask?.cancel(); saveTask = Task { try? await Task.sleep(for: .milliseconds(350)); guard !Task.isCancelled, !sending, !completed else { return }; _ = await saveLocal() } }
        .onChange(of: scenePhase) { if scenePhase == .inactive || scenePhase == .background { flushForTransition() } }
        .onDisappear { flushForTransition() }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in if case let .success(urls) = result { Task { await attach(urls) } } }
    }
    var snapshot: String { [to, cc, bcc, subject, messageBody].joined(separator: "\u{1f}") }
    var deliveryFrozen: Bool { sending || (local.map { ["sending", "ambiguous"].contains($0.deliveryState) } ?? false) }
    func seed() { guard to.isEmpty, subject.isEmpty, let context, let last = context.messages.last else { return }; subject = kind == "forward" ? "Fwd: \(context.thread.subject)" : (context.thread.subject.lowercased().hasPrefix("re:") ? context.thread.subject : "Re: \(context.thread.subject)"); if kind != "forward" { let mine = context.account.email.lowercased(); let contacts = ([last.from] + (kind == "reply_all" ? last.to + last.cc : [])).filter { $0.email.lowercased() != mine }; to = Array(Set(contacts.map(\.email))).joined(separator: ", ") } else { messageBody = "\n\n---------- Forwarded message ----------\nFrom: \(last.from.name ?? last.from.email) <\(last.from.email)>\nDate: \(last.receivedAt)\nSubject: \(last.subject)\n\n\(last.bodyText ?? last.snippet)" } }
    func content() -> DraftContent { var result = DraftContent(to: validRecipients(to), cc: validRecipients(cc), bcc: validRecipients(bcc), subject: subject, body: .init(text: messageBody, html: nil), context: local?.content.context ?? seedServer?.context, attachments: local?.content.attachments ?? seedServer?.attachments ?? []); if let context, let last = context.messages.last { result.context = DraftContext(kind: kind, threadId: context.thread.id, messageId: last.id, providerMessageId: last.providerMessageId, providerThreadId: context.thread.providerThreadId, inReplyTo: last.internetMessageId, references: last.references) }; return result }
    func validRecipients(_ value: String) -> [Recipient] { value.split(separator: ",", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { Self.isEmail($0) }.map { Recipient(name: nil, email: $0) } }
    func recipientsAreValid(_ value: String, allowingEmpty: Bool) -> Bool { if allowingEmpty && value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }; let values = value.split(separator: ",", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }; return !values.isEmpty && values.allSatisfy(Self.isEmail) }
    static func isEmail(_ value: String) -> Bool { value.range(of: #"^[^\s@,]+@[^\s@,]+\.[^\s@,]+$"#, options: .regularExpression) != nil }
    func saveLocal() async -> Bool { guard !completed, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return false }; var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID); if draft.serverID == nil, let seedServer { draft.serverID = seedServer.id; draft.serverRevision = seedServer.revision; draft.deliveryState = seedServer.deliveryStatus }; draft.content = content(); draft.recipientText = .init(to: to, cc: cc, bcc: bcc); do { try await state.draftStore.save(draft); local = draft; status = "Saved locally"; return true } catch { status = "Local save failed — sending is paused"; return false } }
    func attach(_ urls: [URL]) async { guard !sending, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return }; var attachments = local?.content.attachments ?? []; for url in urls { let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= 25 * 1024 * 1024 else { status = "Attachment could not be added or exceeds 25 MB"; continue }; attachments.append(.init(id: UUID().uuidString, filename: url.lastPathComponent, mimeType: "application/octet-stream", size: data.count, contentBase64: data.base64EncodedString())) }; var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID); draft.content = content(); draft.content.attachments = attachments; do { try await state.draftStore.save(draft); local = draft; status = "Attachment saved locally" } catch { status = "Attachment save failed" } }
    func flushForTransition() { guard !sending, !completed else { return }; saveTask?.cancel(); let taskID = UIApplication.shared.beginBackgroundTask(withName: "Save Orca draft"); Task { _ = await saveLocal(); if taskID != .invalid { UIApplication.shared.endBackgroundTask(taskID) } } }
    func send() async {
        guard !sending else { return }; sending = true; saveTask?.cancel(); defer { sending = false }
        guard !state.demoMode, let client = state.client, let ownerScope = draftOwnerScope, ownerScope == state.ownerScope, let accountID = draftAccountID, let account = state.accounts.first(where: { $0.id == accountID }) else { status = "This draft’s account is unavailable in the current session"; return }
        if let current = local, ["sending", "ambiguous"].contains(current.deliveryState) {
            guard let id = current.serverID, let revision = current.serverRevision, let key = current.idempotencyKey else { status = "Delivery is uncertain. This draft cannot be retried automatically."; return }
            do { let result = try await client.sendDraft(id, accountId: account.id, revision: revision, idempotencyKey: key); if result.status == "sent" { completed = true; try await state.draftStore.remove(current.id); dismiss() } else { status = "Delivery remains uncertain — no duplicate was sent" } } catch { status = "Could not confirm delivery — no duplicate was sent" }
            return
        }
        guard recipientsAreValid(to, allowingEmpty: false), recipientsAreValid(cc, allowingEmpty: true), recipientsAreValid(bcc, allowingEmpty: true) else { status = "Fix invalid recipient addresses before sending"; return }
        guard await saveLocal(), var current = local else { return }
        do {
            if current.serverID == nil { let server = try await client.createDraft(accountId: account.id, content: current.content); current.serverID = server.id; current.serverRevision = server.revision; try await state.draftStore.save(current) }
            else if let id = current.serverID, let revision = current.serverRevision { let server = try await client.updateDraft(id, accountId: account.id, revision: revision, content: current.content); current.serverRevision = server.revision; try await state.draftStore.save(current) }
        } catch { status = "Could not save to server — local draft is safe"; return }
        do {
            current = try await state.draftStore.prepareSend(current.id); local = current
            guard let id = current.serverID, let revision = current.serverRevision, let key = current.idempotencyKey else { return }
            let result = try await client.sendDraft(id, accountId: account.id, revision: revision, idempotencyKey: key)
            if result.status == "sent" { completed = true; try await state.draftStore.remove(current.id); status = "Sent"; dismiss() }
            else if result.status == "ambiguous" || result.status == "sending" { try await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — check before retrying" }
            else { status = result.error?.message ?? "Send failed; draft is safe" }
        } catch { try? await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — draft and delivery key are safe" }
    }
}
