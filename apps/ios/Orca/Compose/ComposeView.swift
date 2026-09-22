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
    @State private var staleConflict = false
    init(context: ThreadDetail? = nil, kind: String = "new", localDraft: LocalDraft? = nil, serverDraft: MessageDraft? = nil) {
        self.context = context; self.kind = kind; seedServer = serverDraft
        let content = localDraft?.content ?? serverDraft.map { DraftContent(to: $0.to, cc: $0.cc, bcc: $0.bcc, subject: $0.subject, body: $0.body, context: $0.context, attachments: $0.attachments) }
        _to = State(initialValue: localDraft?.recipientText?.to ?? content?.to.map(\.email).joined(separator: ", ") ?? "")
        _cc = State(initialValue: localDraft?.recipientText?.cc ?? content?.cc.map(\.email).joined(separator: ", ") ?? "")
        _bcc = State(initialValue: localDraft?.recipientText?.bcc ?? content?.bcc.map(\.email).joined(separator: ", ") ?? "")
        _subject = State(initialValue: content?.subject ?? ""); _messageBody = State(initialValue: content?.body.text ?? ""); _local = State(initialValue: localDraft)
        _draftAccountID = State(initialValue: localDraft?.accountId ?? serverDraft?.accountId); _draftOwnerScope = State(initialValue: localDraft?.ownerScope)
    }
    var body: some View { Form { Section("Recipients") { TextField("To", text: $to).textContentType(.emailAddress).textInputAutocapitalization(.never).keyboardType(.emailAddress).accessibilityIdentifier("compose.to"); DisclosureGroup("Cc and Bcc") { TextField("Cc", text: $cc); TextField("Bcc", text: $bcc) } }.disabled(deliveryFrozen); Section { TextField("Subject", text: $subject).accessibilityIdentifier("compose.subject"); TextEditor(text: $messageBody).frame(minHeight: 240).accessibilityLabel("Message body").accessibilityIdentifier("compose.body"); Button { showingImporter = true } label: { Label("Attach file", systemImage: "paperclip") }.disabled(deliveryFrozen); if let local { ForEach(local.content.attachments) { Text($0.filename).font(.caption) } } }.disabled(deliveryFrozen); Section { HStack { Label(status, systemImage: status.contains("failed") ? "exclamationmark.triangle" : "checkmark.circle").font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("compose.save-status"); Spacer(); Button(deliveryFrozen ? "Check delivery" : "Send") { Task { await send() } }.disabled(sending || staleConflict || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || deliveryFrozen && local?.idempotencyKey == nil).accessibilityIdentifier("compose.send") }; if staleConflict { Button("Keep both drafts") { Task { await keepBothDrafts() } }.accessibilityHint("Keeps the changed server draft and saves this version as a new draft") } } }.accessibilityIdentifier("compose.form")
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
    static func acceptsAttachment(existingSize: Int, candidateSize: Int) -> Bool { candidateSize > 0 && existingSize >= 0 && candidateSize <= 25 * 1024 * 1024 - existingSize }
    static func canKeepBoth(remoteDeliveryStatus: String, localDeliveryState: String, hasDeliveryKey: Bool) -> Bool { remoteDeliveryStatus == "draft" && !hasDeliveryKey && ["local", "draft"].contains(localDeliveryState) }
    func saveLocal() async -> Bool { guard !completed, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return false }; var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID); if draft.serverID == nil, let seedServer { draft.serverID = seedServer.id; draft.serverRevision = seedServer.revision; draft.deliveryState = seedServer.deliveryStatus }; draft.content = content(); draft.recipientText = .init(to: to, cc: cc, bcc: bcc); do { try await state.draftStore.save(draft); local = draft; status = "Saved locally"; return true } catch { status = "Local save failed — sending is paused"; return false } }
    func attach(_ urls: [URL]) async { guard !sending, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return }; var attachments = local?.content.attachments ?? []; var total = attachments.reduce(0) { $0 + $1.size }; var rejected = false; for url in urls { let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, Self.acceptsAttachment(existingSize: total, candidateSize: size), let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count == size else { rejected = true; continue }; attachments.append(.init(id: UUID().uuidString, filename: url.lastPathComponent, mimeType: "application/octet-stream", size: data.count, contentBase64: data.base64EncodedString())); total += data.count }; var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID); draft.content = content(); draft.content.attachments = attachments; do { try await state.draftStore.save(draft); local = draft; status = rejected ? "Some files were not added; attachments must total 25 MB or less" : "Attachment saved locally" } catch { status = "Attachment save failed" } }
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
        } catch let APIClient.ClientError.http(code, body) where code == 409 && body?.code == "stale_draft" { await inspectStaleConflict(client: client, accountID: account.id, ownerScope: ownerScope); return }
        catch { status = "Could not save to server — local draft is safe"; return }
        do {
            current = try await state.draftStore.prepareSend(current.id); local = current
            guard let id = current.serverID, let revision = current.serverRevision, let key = current.idempotencyKey else { return }
            let result = try await client.sendDraft(id, accountId: account.id, revision: revision, idempotencyKey: key)
            if result.status == "sent" { completed = true; try await state.draftStore.remove(current.id); status = "Sent"; dismiss() }
            else if result.status == "ambiguous" || result.status == "sending" { try await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — check before retrying" }
            else { status = result.error?.message ?? "Send failed; draft is safe" }
        } catch { try? await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — draft and delivery key are safe" }
    }
    func inspectStaleConflict(client: APIClient, accountID: String, ownerScope: String) async {
        guard let draft = local, let serverID = draft.serverID else { status = "This draft changed elsewhere. Your local version is safe."; return }
        do {
            let remote = try await client.draft(serverID, accountId: accountID)
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            if Self.canKeepBoth(remoteDeliveryStatus: remote.deliveryStatus, localDeliveryState: draft.deliveryState, hasDeliveryKey: draft.idempotencyKey != nil) { staleConflict = true; status = "This draft changed elsewhere. Keep both versions, or leave this local copy unchanged." }
            else { staleConflict = false; status = "This draft’s delivery is \(remote.deliveryStatus). It cannot be detached safely." }
        } catch { guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client else { return }; staleConflict = false; status = "This draft changed elsewhere. Delivery status could not be verified, so no copy was detached." }
    }
    func keepBothDrafts() async {
        guard staleConflict, !deliveryFrozen, var draft = local, draft.idempotencyKey == nil, let serverID = draft.serverID, let accountID = draftAccountID, draft.accountId == accountID, let ownerScope = draftOwnerScope, ownerScope == state.ownerScope, let client = state.client else { return }
        do {
            let remote = try await client.draft(serverID, accountId: accountID)
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            guard Self.canKeepBoth(remoteDeliveryStatus: remote.deliveryStatus, localDeliveryState: draft.deliveryState, hasDeliveryKey: draft.idempotencyKey != nil) else { staleConflict = false; status = "This draft’s delivery is \(remote.deliveryStatus). It cannot be detached safely."; return }
        } catch { guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client else { return }; staleConflict = false; status = "Delivery status could not be verified, so no copy was detached."; return }
        draft.serverID = nil; draft.serverRevision = nil; draft.idempotencyKey = nil; draft.deliveryState = "local"
        do { try await state.draftStore.save(draft); local = draft; staleConflict = false; status = "Both drafts kept. This version will send as a new draft." }
        catch { status = "Could not preserve both drafts — no server copy was changed" }
    }
}
