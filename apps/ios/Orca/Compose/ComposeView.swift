import SwiftUI

struct ComposeSendPermissionGate: Equatable {
    var blocksNormalSend: Bool
    var guidance: String?
}

struct ComposeOperationReservation {
    enum Operation: Equatable { case attachments, delivery, reconciliation }
    private(set) var active: Operation?
    var isBusy: Bool { active != nil }
    mutating func reserve(_ operation: Operation) -> Bool {
        guard active == nil else { return false }
        active = operation; return true
    }
    mutating func release(_ operation: Operation) {
        if active == operation { active = nil }
    }
}

@MainActor enum ComposeSaveSequencing {
    static func enqueue(after previous: Task<Void, Never>?, debounce: Bool,
                        canSave: @escaping @MainActor () -> Bool,
                        save: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        previous?.cancel()
        return Task { @MainActor in
            if debounce { try? await Task.sleep(for: .milliseconds(350)) }
            // Even a cancelled queue entry must drain its predecessor. Otherwise
            // Send could await this entry while an older disk write is still live.
            await previous?.value
            guard !Task.isCancelled, canSave() else { return }
            await save()
        }
    }
}

@MainActor enum ComposeReconciliationCheckpoint {
    enum Failure: Error { case localSave(Error) }
    static func loadRemote(afterCheckpointing draft: LocalDraft, store: DraftStore,
                           reservation: DraftStore.Reservation? = nil,
                           didCheckpoint: (LocalDraft) -> Void = { _ in },
                           load: () async throws -> MessageDraft) async throws -> MessageDraft {
        // Retain the contested server identity until verification succeeds. The
        // visible words must already be durable if this network call stalls.
        do { didCheckpoint(try await store.save(draft, reservation: reservation)) }
        catch { throw Failure.localSave(error) }
        return try await load()
    }
}

struct ComposeView: View {
    @EnvironmentObject var state: AppState; @Environment(\.dismiss) var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var context: ThreadDetail?; var kind = "new"; private var seedServer: MessageDraft?
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var messageBody = ""
    @State private var local: LocalDraft?
    @State private var status = "Saved locally"
    @State private var draftOperation = ComposeOperationReservation()
    @State private var storageReservation: DraftStore.Reservation?
    @State private var lastOwnedOperation: UUID?
    @State private var saveTask: Task<Void, Never>?
    @State private var showingImporter = false
    @State private var draftAccountID: String?
    @State private var draftOwnerScope: String?
    @State private var preparing = true
    @State private var completed = false
    @State private var staleConflict = false
    @State private var refreshingPermissions = false
    init(context: ThreadDetail? = nil, kind: String = "new", localDraft: LocalDraft? = nil, serverDraft: MessageDraft? = nil) {
        self.context = context; self.kind = localDraft?.content.context?.kind ?? serverDraft?.context?.kind ?? kind; seedServer = serverDraft
        let content = localDraft?.content ?? serverDraft.map { DraftContent(to: $0.to, cc: $0.cc, bcc: $0.bcc, subject: $0.subject, body: $0.body, context: $0.context, attachments: $0.attachments) }
        _to = State(initialValue: localDraft?.recipientText?.to ?? content?.to.map(\.email).joined(separator: ", ") ?? "")
        _cc = State(initialValue: localDraft?.recipientText?.cc ?? content?.cc.map(\.email).joined(separator: ", ") ?? "")
        _bcc = State(initialValue: localDraft?.recipientText?.bcc ?? content?.bcc.map(\.email).joined(separator: ", ") ?? "")
        _subject = State(initialValue: content?.subject ?? ""); _messageBody = State(initialValue: content?.body.text ?? ""); _local = State(initialValue: localDraft)
        _draftAccountID = State(initialValue: localDraft?.accountId ?? serverDraft?.accountId); _draftOwnerScope = State(initialValue: localDraft?.ownerScope)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(spacing: 0) {
                    recipientField("To", text: $to)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.emailAddress)
                    Divider().overlay(OrcaTheme.border)
                    DisclosureGroup {
                        VStack(spacing: 0) {
                            recipientField("Cc", text: $cc)
                            Divider().overlay(OrcaTheme.border)
                            recipientField("Bcc", text: $bcc)
                        }
                    } label: {
                        Text("Cc and Bcc")
                            .font(OrcaTheme.ui(12, weight: .semibold))
                            .foregroundStyle(OrcaTheme.muted)
                            .textCase(.uppercase)
                            .tracking(0.7)
                            .padding(.vertical, 13)
                    }
                    .tint(OrcaTheme.muted)
                }
                .disabled(deliveryFrozen || editingAttachments)

                Divider().overlay(OrcaTheme.border)

                TextField("Subject", text: $subject, prompt: Text("Subject").foregroundStyle(OrcaTheme.muted))
                    .font(OrcaTheme.reader(28))
                    .foregroundStyle(OrcaTheme.ink)
                    .padding(.vertical, 20)
                    .accessibilityIdentifier("compose.subject")
                    .disabled(deliveryFrozen || editingAttachments)

                Divider().overlay(OrcaTheme.border)

                TextEditor(text: $messageBody)
                    .font(OrcaTheme.reader(20))
                    .foregroundStyle(OrcaTheme.ink)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 360, alignment: .topLeading)
                    .padding(.vertical, 14)
                    .accessibilityLabel("Message body")
                    .accessibilityIdentifier("compose.body")
                    .disabled(deliveryFrozen || editingAttachments)

                VStack(alignment: .leading, spacing: 10) {
                    Button { showingImporter = true } label: {
                        Label("Attach file", systemImage: "paperclip")
                            .font(OrcaTheme.ui(13, weight: .semibold))
                            .foregroundStyle(OrcaTheme.ink)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .disabled(deliveryFrozen || editingAttachments || local == nil)
                    if let local {
                        ForEach(local.content.attachments) { attachment in
                            HStack(spacing: 12) {
                                Label(attachment.filename, systemImage: "doc")
                                    .font(OrcaTheme.ui(12))
                                    .foregroundStyle(OrcaTheme.muted)
                                Spacer(minLength: 0)
                                Button { Task { await removeAttachment(attachment.id) } } label: {
                                    Image(systemName: "xmark.circle").frame(width: 44, height: 44)
                                }
                                .foregroundStyle(OrcaTheme.ink)
                                .accessibilityLabel("Remove \(attachment.filename)")
                                .accessibilityIdentifier("compose.attachment.remove.\(attachment.id)")
                                .disabled(deliveryFrozen || editingAttachments)
                            }
                        }
                    }
                }
                .padding(.vertical, 16)
            }
            .padding(.horizontal, 22)
        }
        .background(OrcaTheme.paper.ignoresSafeArea())
        .accessibilityIdentifier("compose.form")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider().overlay(OrcaTheme.border)
                if let guidance = sendPermissionGate.guidance {
                    Label(guidance, systemImage: "lock.fill")
                        .font(OrcaTheme.ui(12, weight: .medium))
                        .foregroundStyle(OrcaTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 18)
                        .padding(.top, 12)
                        .accessibilityIdentifier("compose.send-permission")
                    if composeAccount?.provider.lowercased() == "gmail" {
                        Button(refreshingPermissions ? "Checking sending access…" : "Refresh sending access") {
                            Task { await refreshSendingAccess() }
                        }
                        .font(OrcaTheme.ui(12, weight: .semibold))
                        .foregroundStyle(OrcaTheme.accent)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 18)
                        .disabled(refreshingPermissions || sending)
                        .accessibilityIdentifier("compose.refresh-permission")
                    }
                }
                Group {
                    if dynamicTypeSize.isAccessibilitySize { composeActionsVertical }
                    else { composeActionsHorizontal }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
            }
            .background(OrcaTheme.surface)
        }
        .navigationTitle(kind == "new" ? "New message" : kind.replacingOccurrences(of: "_", with: " ").capitalized).navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task {
            if draftAccountID == nil { draftAccountID = state.selectedAccount?.id }
            if draftOwnerScope == nil { draftOwnerScope = state.ownerScope }
            if preparing {
                if let opened = local {
                    guard let current = await state.draftStore.current(opened.id, ownerScope: opened.ownerScope, accountId: opened.accountId) else {
                        completed = true; preparing = false; dismiss(); return
                    }
                    adopt(current)
                }
                seed(); preparing = false
            }
            if heldByAnotherComposer { status = "This draft is being updated in another window" }
            else if !draftOperation.isBusy { await queueLocalSave(debounce: false).value }
            try? await state.refreshAccountCapabilities()
        }
        .onChange(of: snapshot) { _ = queueLocalSave(debounce: true) }
        .onChange(of: state.activeDraftOperations) { previous, current in
            guard let id = local?.id, !completed, !draftOperation.isBusy, storageReservation == nil,
                  Self.shouldReloadAfterSharedOperation(draftID: id, previous: previous,
                      current: current, lastOwnedOperation: lastOwnedOperation) else { return }
            preparing = true
            Task { await reloadAfterSharedOperation() }
        }
        .onChange(of: scenePhase) { if scenePhase == .inactive || scenePhase == .background { flushForTransition() } }
        .onDisappear { flushForTransition() }
        .fileImporter(isPresented: $showingImporter, allowedContentTypes: [.data], allowsMultipleSelection: true) { result in if case let .success(urls) = result { Task { await attach(urls) } } }
    }
    private var saveStatus: some View {
        Label(status, systemImage: status.contains("failed") ? "exclamationmark.triangle" : "checkmark.circle")
            .font(OrcaTheme.ui(11, weight: .medium))
            .foregroundStyle(OrcaTheme.muted)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(status)
            .accessibilityIdentifier("compose.save-status")
    }
    private var keepBothButton: some View {
        Button("Keep both drafts") { Task { await keepBothDrafts() } }
            .font(OrcaTheme.ui(12, weight: .semibold))
            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, minHeight: 44)
            .contentShape(Rectangle())
            .accessibilityHint("Keeps the changed server draft and saves this version as a new draft")
            .accessibilityIdentifier("compose.keep-both")
            .disabled(draftOperation.isBusy)
    }
    private var sendButton: some View {
        Button(primaryActionTitle) { Task { if rejectedDelivery { await editRejectedCopy() } else { await send() } } }
            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil)
            .buttonStyle(OrcaPrimaryButtonStyle())
            .disabled(preparing || local == nil || sending || editingAttachments || staleConflict || (!deliveryRecoveryAction && (sendPermissionGate.blocksNormalSend || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) || (deliveryRecoveryAction && local?.serverID == nil))
            .accessibilityIdentifier("compose.send")
    }
    private var composeActionsHorizontal: some View {
        HStack(spacing: 14) {
            saveStatus
            Spacer(minLength: 8)
            if staleConflict { keepBothButton }
            sendButton
        }
    }
    private var composeActionsVertical: some View {
        VStack(alignment: .leading, spacing: 8) {
            saveStatus
            if staleConflict { keepBothButton }
            sendButton
        }
    }
    private func recipientField(_ label: String, text: Binding<String>) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 14) {
            Text(label)
                .font(OrcaTheme.ui(12, weight: .semibold))
                .foregroundStyle(OrcaTheme.muted)
                .frame(width: 34, alignment: .leading)
            TextField(label, text: text, prompt: Text(label).foregroundStyle(OrcaTheme.muted))
                .accessibilityIdentifier("compose.\(label.lowercased())")
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .font(OrcaTheme.ui(14))
                .foregroundStyle(OrcaTheme.ink)
        }
        .padding(.vertical, 13)
    }
    var snapshot: String { [to, cc, bcc, subject, messageBody].joined(separator: "\u{1f}") }
    var heldByAnotherComposer: Bool { local.map { state.activeDraftOperations[$0.id] != nil && state.activeDraftOperations[$0.id] != storageReservation?.id } ?? false }
    var sending: Bool { draftOperation.active == .delivery || draftOperation.active == .reconciliation || heldByAnotherComposer }
    var editingAttachments: Bool { draftOperation.active == .attachments }
    var rejectedDelivery: Bool { local?.deliveryState == "rejected" }
    var deliveryRecoveryAction: Bool { local.map { ["sending", "ambiguous", "rejected"].contains($0.deliveryState) } ?? false }
    var deliveryFrozen: Bool { preparing || sending || (local.map { ["sending", "ambiguous", "rejected"].contains($0.deliveryState) } ?? false) }
    var primaryActionTitle: String { rejectedDelivery ? "Edit a new copy" : (deliveryFrozen ? "Check delivery" : "Send") }
    var composeAccount: MailAccount? { guard let draftAccountID else { return state.selectedAccount }; return state.accounts.first(where: { $0.id == draftAccountID }) }
    var sendPermissionGate: ComposeSendPermissionGate { Self.sendPermissionGate(account: composeAccount, deliveryState: local?.deliveryState) }
    static func sendPermissionGate(account: MailAccount?, deliveryState: String?) -> ComposeSendPermissionGate {
        guard let account, !account.capabilities.send else { return .init(blocksNormalSend: false, guidance: nil) }
        let recoveryAction = ["sending", "ambiguous", "rejected"].contains(deliveryState ?? "")
        let guidance = account.provider.lowercased() == "gmail"
            ? "This Gmail connection is read-only. In Orca on the web, open Settings → Gmail → Enable drafts and sending, then return here and refresh sending access. Your draft remains editable."
            : "Sending is not supported for this provider yet. Your draft remains editable in Orca."
        return .init(blocksNormalSend: !recoveryAction, guidance: guidance)
    }
    func seed() { guard to.isEmpty, subject.isEmpty, let context, let last = context.messages.last else { return }; subject = kind == "forward" ? "Fwd: \(context.thread.subject)" : (context.thread.subject.lowercased().hasPrefix("re:") ? context.thread.subject : "Re: \(context.thread.subject)"); if kind != "forward" { let recipients = Self.replyRecipients(accountEmail: context.account.email, message: last, kind: kind); to = recipients.to.map(\.email).joined(separator: ", "); cc = recipients.cc.map(\.email).joined(separator: ", ") } else { messageBody = "\n\n---------- Forwarded message ----------\nFrom: \(last.from.name ?? last.from.email) <\(last.from.email)>\nDate: \(last.receivedAt)\nSubject: \(last.subject)\n\n\(last.bodyText ?? last.snippet)" } }
    static func replyRecipients(accountEmail: String, message: ThreadMessage, kind: String) -> (to: [MailContact], cc: [MailContact]) {
        var owned = Set([accountEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()])
        if message.labels.contains(where: { $0.uppercased() == "SENT" }) { owned.insert(message.from.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
        func dedupe(_ contacts: [MailContact], excluding: Set<String> = []) -> [MailContact] {
            var seen = excluding
            return contacts.filter { contact in
                let email = contact.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                guard !email.isEmpty, !owned.contains(email), !seen.contains(email) else { return false }
                seen.insert(email); return true
            }
        }
        let sender = dedupe([message.from])
        let to = kind == "reply"
            ? (sender.isEmpty ? dedupe(message.to + message.cc) : sender)
            : dedupe(sender + message.to)
        let cc = kind == "reply_all" ? dedupe(message.cc, excluding: Set(to.map { $0.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })) : []
        return (to, cc)
    }
    func content() -> DraftContent { var result = DraftContent(to: validRecipients(to), cc: validRecipients(cc), bcc: validRecipients(bcc), subject: subject, body: Self.bodyForSaving(text: messageBody, original: local?.content.body ?? seedServer?.body), context: local?.content.context ?? seedServer?.context, attachments: local?.content.attachments ?? seedServer?.attachments ?? []); if let context, let last = context.messages.last { result.context = DraftContext(kind: kind, threadId: context.thread.id, messageId: last.id, providerMessageId: last.providerMessageId, providerThreadId: context.thread.providerThreadId, inReplyTo: last.internetMessageId, references: last.references) }; return result }
    static func bodyForSaving(text: String, original: DraftBody?) -> DraftBody {
        // The plain-text editor cannot update HTML. Preserve the rich body when
        // merely opening/autosaving, but never send stale HTML after a text edit.
        DraftBody(text: text, html: original?.text == text ? original?.html : nil)
    }
    func validRecipients(_ value: String) -> [Recipient] { value.split(separator: ",", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { Self.isEmail($0) }.map { Recipient(name: nil, email: $0) } }
    func recipientsAreValid(_ value: String, allowingEmpty: Bool) -> Bool { if allowingEmpty && value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }; let values = value.split(separator: ",", omittingEmptySubsequences: false).map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }; return !values.isEmpty && values.allSatisfy(Self.isEmail) }
    static func isEmail(_ value: String) -> Bool { value.range(of: #"^[^\s@,]+@[^\s@,]+\.[^\s@,]+$"#, options: .regularExpression) != nil }
    static func acceptsAttachment(existingSize: Int, candidateSize: Int, existingCount: Int = 0) -> Bool { existingCount >= 0 && existingCount < 25 && candidateSize > 0 && existingSize >= 0 && candidateSize <= 25 * 1024 * 1024 - existingSize }
    static func canKeepBoth(remoteDeliveryStatus: String, localDeliveryState: String, hasDeliveryKey: Bool) -> Bool { remoteDeliveryStatus == "draft" && !hasDeliveryKey && ["local", "draft"].contains(localDeliveryState) }
    static func canEditRejectedCopy(remoteDeliveryStatus: String, localDeliveryState: String) -> Bool { remoteDeliveryStatus == "rejected" && localDeliveryState == "rejected" }
    @discardableResult func queueLocalSave(debounce: Bool) -> Task<Void, Never> {
        let task = ComposeSaveSequencing.enqueue(after: saveTask, debounce: debounce,
            canSave: { !preparing && !heldByAnotherComposer && !draftOperation.isBusy && !completed }, save: { _ = await saveLocal() })
        saveTask = task; return task
    }
    static func shouldReloadAfterSharedOperation(draftID: UUID, previous: [UUID: UUID],
                                                current: [UUID: UUID], lastOwnedOperation: UUID?) -> Bool {
        // Only an observer was frozen by this operation. Its owner may still
        // have unsaved visible edits after validation or a disk-write failure.
        guard let finished = previous[draftID], current[draftID] == nil else { return false }
        return finished != lastOwnedOperation
    }
    func beginSharedOperation() async -> DraftStore.Reservation? {
        guard let draft = local else { return nil }
        do {
            let reservation = try await state.draftStore.reserve(draft)
            storageReservation = reservation; lastOwnedOperation = reservation.id
            state.activeDraftOperations[draft.id] = reservation.id
            return reservation
        } catch {
            status = error.localizedDescription
            return nil
        }
    }
    func endSharedOperation(_ reservation: DraftStore.Reservation) {
        storageReservation = nil
        Task { @MainActor in
            await state.draftStore.release(reservation)
            if state.activeDraftOperations[reservation.draftID] == reservation.id {
                state.activeDraftOperations.removeValue(forKey: reservation.draftID)
            }
        }
    }
    func reloadAfterSharedOperation() async {
        guard let previous = local, !completed, !draftOperation.isBusy, storageReservation == nil else { preparing = false; return }
        preparing = true
        let current = await state.draftStore.current(previous.id, ownerScope: previous.ownerScope, accountId: previous.accountId)
        guard local?.id == previous.id, !completed else { preparing = false; return }
        guard state.activeDraftOperations[previous.id] == nil else { preparing = false; return }
        guard let current else { completed = true; preparing = false; dismiss(); return }
        adopt(current); preparing = false
        status = current.deliveryState == "rejected" ? "Delivery was rejected. Edit a new copy to try again." : "Saved locally"
    }
    func adopt(_ draft: LocalDraft) {
        local = draft
        to = draft.recipientText?.to ?? draft.content.to.map(\.email).joined(separator: ", ")
        cc = draft.recipientText?.cc ?? draft.content.cc.map(\.email).joined(separator: ", ")
        bcc = draft.recipientText?.bcc ?? draft.content.bcc.map(\.email).joined(separator: ", ")
        subject = draft.content.subject; messageBody = draft.content.body.text
    }
    func saveLocal() async -> Bool { guard !completed, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return false }; var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID); if local == nil, let seedServer { draft.serverID = seedServer.id; draft.serverRevision = seedServer.revision; draft.deliveryState = seedServer.deliveryStatus }; draft.content = content(); draft.recipientText = .init(to: to, cc: cc, bcc: bcc); do { draft = try await state.draftStore.save(draft, reservation: storageReservation); local = draft; status = draft.deliveryState == "rejected" ? "Delivery was rejected. Edit a new copy to try again." : "Saved locally"; return true } catch { status = "Local save failed — sending is paused"; return false } }
    func attach(_ urls: [URL]) async {
        guard local != nil, !deliveryFrozen, !editingAttachments, let accountID = draftAccountID, let ownerScope = draftOwnerScope else { return }
        guard draftOperation.reserve(.attachments) else { return }; defer { draftOperation.release(.attachments) }
        let pendingSave = saveTask; pendingSave?.cancel(); await pendingSave?.value
        guard !Task.isCancelled, !completed, ownerScope == state.ownerScope else { return }
        guard let sharedOperation = await beginSharedOperation() else { return }
        defer { endSharedOperation(sharedOperation) }
        var attachments = local?.content.attachments ?? seedServer?.attachments ?? []
        var total = attachments.reduce(0) { $0 + $1.size }; var rejected = false
        for url in urls {
            let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  Self.acceptsAttachment(existingSize: total, candidateSize: size, existingCount: attachments.count),
                  let data = try? Data(contentsOf: url, options: .mappedIfSafe), data.count == size else { rejected = true; continue }
            attachments.append(.init(id: UUID().uuidString, filename: url.lastPathComponent, mimeType: "application/octet-stream", size: data.count, contentBase64: data.base64EncodedString())); total += data.count
        }
        var draft = local ?? LocalDraft(ownerScope: ownerScope, accountId: accountID)
        draft.content = content(); draft.content.attachments = attachments; draft.recipientText = .init(to: to, cc: cc, bcc: bcc)
        do { draft = try await state.draftStore.save(draft, reservation: storageReservation); local = draft; status = rejected ? "Some files were not added; use up to 25 files totaling 25 MB or less" : "Attachment saved locally" }
        catch { status = "Attachment save failed" }
    }
    func removeAttachment(_ id: String) async {
        guard !deliveryFrozen, !editingAttachments else { return }
        // Reserve the edit before suspension so another remove or Send cannot
        // race it. Drain an in-flight autosave before taking the draft snapshot.
        guard draftOperation.reserve(.attachments) else { return }; defer { draftOperation.release(.attachments) }
        let pendingSave = saveTask; pendingSave?.cancel(); await pendingSave?.value
        guard !Task.isCancelled, !completed, draftOwnerScope == state.ownerScope, var draft = local else { return }
        guard let sharedOperation = await beginSharedOperation() else { return }
        defer { endSharedOperation(sharedOperation) }
        draft.content = content(); draft.content.attachments.removeAll { $0.id == id }
        draft.recipientText = .init(to: to, cc: cc, bcc: bcc)
        do { draft = try await state.draftStore.save(draft, reservation: storageReservation); local = draft; status = "Attachment removed; draft saved locally" }
        catch { status = "Attachment removal failed; the saved draft is unchanged" }
    }
    func refreshSendingAccess() async {
        guard !refreshingPermissions else { return }
        refreshingPermissions = true; defer { refreshingPermissions = false }
        let scope = draftOwnerScope, accountID = draftAccountID
        do {
            guard try await state.refreshAccountCapabilities(), scope == state.ownerScope, accountID == draftAccountID else { return }
            status = composeAccount?.capabilities.send == true
                ? "Sending access is ready. Your draft is unchanged."
                : "Sending is still read-only. Enable drafts and sending on the web, then refresh here."
        } catch {
            guard scope == state.ownerScope, accountID == draftAccountID else { return }
            status = "Could not refresh sending access. Your draft is safe; try again when connected."
        }
    }
    func flushForTransition() {
        guard !preparing, !sending, !editingAttachments, !completed else { return }
        let pendingSave = saveTask; pendingSave?.cancel()
        let taskID = UIApplication.shared.beginBackgroundTask(withName: "Save Orca draft")
        saveTask = Task {
            await pendingSave?.value
            if !Task.isCancelled, !draftOperation.isBusy, !completed { _ = await saveLocal() }
            if taskID != .invalid { UIApplication.shared.endBackgroundTask(taskID) }
        }
    }
    func send() async {
        guard !preparing, !heldByAnotherComposer, local != nil, draftOperation.reserve(.delivery) else { return }; defer { draftOperation.release(.delivery) }
        let pendingSave = saveTask; pendingSave?.cancel(); await pendingSave?.value
        guard !Task.isCancelled, !completed else { return }
        guard !state.demoMode, let client = state.client, let ownerScope = draftOwnerScope, ownerScope == state.ownerScope, let accountID = draftAccountID, let account = state.accounts.first(where: { $0.id == accountID }) else { status = "This draft’s account is unavailable in the current session"; return }
        guard let sharedOperation = await beginSharedOperation() else { return }
        defer { endSharedOperation(sharedOperation) }
        if let current = local, ["sending", "ambiguous"].contains(current.deliveryState) {
            do {
                let result = try await DraftDeliveryRecovery.check(current, client: client)
                guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, state.client === client, local?.id == current.id else { return }
                if result.status == "sent" { completed = true; try await state.draftStore.remove(current.id, reservation: storageReservation); dismiss() }
                else if result.status == "rejected" { if let rejected = try await state.draftStore.markRejected(current.id, reservation: storageReservation) { local = rejected; status = result.error?.message ?? "Delivery was rejected. Edit a new copy to try again." } }
                else { status = "Delivery remains uncertain — no duplicate was sent" }
            } catch {
                if APIClient.sendFailurePhase(for: error) == .confirmedPreReservation {
                    await recoverPreReservationFailure(error, draft: current, client: client, accountID: account.id, ownerScope: ownerScope)
                } else { status = "Could not confirm delivery — no duplicate was sent" }
            }
            return
        }
        guard recipientsAreValid(to, allowingEmpty: false), recipientsAreValid(cc, allowingEmpty: true), recipientsAreValid(bcc, allowingEmpty: true) else { status = "Fix invalid recipient addresses before sending"; return }
        guard account.capabilities.send else { status = sendPermissionGate.guidance ?? "Sending is unavailable; your draft stays editable."; return }
        guard await saveLocal(), var current = local else { return }
        do {
            if current.serverID == nil { let server = try await client.createDraft(accountId: account.id, content: current.content); current.serverID = server.id; current.serverRevision = server.revision; current = try await state.draftStore.save(current, reservation: storageReservation); local = current }
            else if let id = current.serverID, let revision = current.serverRevision { let server = try await client.updateDraft(id, accountId: account.id, revision: revision, content: current.content); current.serverRevision = server.revision; current = try await state.draftStore.save(current, reservation: storageReservation); local = current }
        } catch let APIClient.ClientError.http(code, body) where code == 409 && body?.code == "stale_draft" { await inspectStaleConflict(client: client, accountID: account.id, ownerScope: ownerScope); return }
        catch { status = "Could not save to server: \(error.localizedDescription) Your local draft is safe."; return }
        do {
            current = try await state.draftStore.prepareSend(current.id, reservation: storageReservation); local = current
            guard let id = current.serverID, let revision = current.serverRevision, let key = current.idempotencyKey else { return }
            let result = try await client.sendDraft(id, accountId: account.id, revision: revision, idempotencyKey: key)
            if result.status == "sent" { completed = true; try await state.draftStore.remove(current.id, reservation: storageReservation); status = "Sent"; dismiss() }
            else if result.status == "ambiguous" || result.status == "sending" { if let ambiguous = try await state.draftStore.markAmbiguous(current.id, reservation: storageReservation) { local = ambiguous }; status = "Delivery uncertain — check before retrying" }
            else if result.status == "rejected" { if let rejected = try await state.draftStore.markRejected(current.id, reservation: storageReservation) { local = rejected; status = result.error?.message ?? "Delivery was rejected. Edit a new copy to try again." } }
            else { status = result.error?.message ?? "Send failed; draft is safe" }
        } catch {
            if APIClient.sendFailurePhase(for: error) == .confirmedPreReservation {
                await recoverPreReservationFailure(error, draft: current, client: client, accountID: account.id, ownerScope: ownerScope)
            } else {
                if let ambiguous = try? await state.draftStore.transition(current.id, .uncertain, reservation: storageReservation) { local = ambiguous }
                status = "Delivery uncertain — draft and delivery key are safe"
            }
        }
    }
    func recoverPreReservationFailure(_ error: Error, draft: LocalDraft, client: APIClient, accountID: String, ownerScope: String) async {
        func identityIsCurrent() -> Bool {
            !Task.isCancelled && ownerScope == state.ownerScope && draftAccountID == accountID && state.client === client && local?.id == draft.id
        }
        guard identityIsCurrent(), case let APIClient.ClientError.http(_, body) = error else { return }
        if body?.code == "stale_draft" {
            guard let serverID = draft.serverID else {
                if let recovered = try? await state.draftStore.transition(draft.id, .confirmedPreReservation(serverRevision: body?.currentRevision), reservation: storageReservation) { local = recovered }
                staleConflict = true; status = "This draft changed elsewhere. Your local version is editable and was not sent."
                return
            }
            do {
                let remote = try await client.draft(serverID, accountId: accountID)
                guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
                if remote.deliveryStatus == "draft", let recovered = try await state.draftStore.transition(draft.id, .confirmedPreReservation(serverRevision: nil), reservation: storageReservation) {
                    guard identityIsCurrent() else { return }
                    local = recovered; staleConflict = true; status = "This draft changed elsewhere. Keep both versions, or leave this local copy unchanged."
                } else { await applyVerifiedDeliveryStatus(remote.deliveryStatus, draft: draft, message: "The draft changed while delivery was checked") }
            } catch {
                guard identityIsCurrent() else { return }
                if let ambiguous = try? await state.draftStore.transition(draft.id, .uncertain, reservation: storageReservation) { guard identityIsCurrent() else { return }; local = ambiguous }
                staleConflict = false; status = "Delivery could not be verified. The original delivery key is preserved; check again before editing or retrying."
            }
            return
        }
        if let recovered = try? await state.draftStore.transition(draft.id, .confirmedPreReservation(serverRevision: draft.serverRevision), reservation: storageReservation) { guard identityIsCurrent() else { return }; local = recovered }
        staleConflict = false
        status = body?.code == "missing_capability"
            ? (sendPermissionGate.guidance ?? "Sending is unavailable; your draft stays editable.")
            : "\(body?.message ?? "Send was rejected before delivery started"). Your draft stays editable."
    }
    func applyVerifiedDeliveryStatus(_ remoteStatus: String, draft: LocalDraft, message: String) async {
        switch remoteStatus {
        case "sent":
            completed = true; try? await state.draftStore.remove(draft.id, reservation: storageReservation); dismiss()
        case "rejected":
            if let rejected = try? await state.draftStore.transition(draft.id, .rejected, reservation: storageReservation) { local = rejected }; staleConflict = false; status = "Delivery was rejected. Edit a new copy to try again."
        default:
            if let ambiguous = try? await state.draftStore.transition(draft.id, .uncertain, reservation: storageReservation) { local = ambiguous }; staleConflict = false; status = "\(message). Delivery is \(remoteStatus); no new send was started."
        }
    }
    func inspectStaleConflict(client: APIClient, accountID: String, ownerScope: String) async {
        guard let draft = local, let serverID = draft.serverID else { status = "This draft changed elsewhere. Your local version is safe."; return }
        do {
            let remote = try await client.draft(serverID, accountId: accountID)
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            if remote.deliveryStatus == "rejected" { if let rejected = try await state.draftStore.markRejected(draft.id, reservation: storageReservation) { local = rejected; staleConflict = false; status = "Delivery was rejected. Edit a new copy to try again." }; return }
            if Self.canKeepBoth(remoteDeliveryStatus: remote.deliveryStatus, localDeliveryState: draft.deliveryState, hasDeliveryKey: draft.idempotencyKey != nil) { staleConflict = true; status = "This draft changed elsewhere. Keep both versions, or leave this local copy unchanged." }
            else { staleConflict = false; status = "This draft’s delivery is \(remote.deliveryStatus). It cannot be detached safely." }
        } catch { guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client else { return }; staleConflict = false; status = "This draft changed elsewhere. Delivery status could not be verified, so no copy was detached." }
    }
    func keepBothDrafts() async {
        guard staleConflict, !deliveryFrozen, draftOperation.reserve(.reconciliation) else { return }
        defer { draftOperation.release(.reconciliation) }
        let pendingSave = saveTask; pendingSave?.cancel(); await pendingSave?.value
        guard !Task.isCancelled, !completed, var draft = local, draft.idempotencyKey == nil, let serverID = draft.serverID, let accountID = draftAccountID, draft.accountId == accountID, let ownerScope = draftOwnerScope, ownerScope == state.ownerScope, let client = state.client else { return }
        guard let sharedOperation = await beginSharedOperation() else { return }
        defer { endSharedOperation(sharedOperation) }
        draft.content = content(); draft.recipientText = .init(to: to, cc: cc, bcc: bcc)
        var verifiedRemote: MessageDraft?
        do {
            let remote = try await ComposeReconciliationCheckpoint.loadRemote(afterCheckpointing: draft, store: state.draftStore, reservation: storageReservation,
                didCheckpoint: { saved in draft = saved; local = saved }) {
                try await client.draft(serverID, accountId: accountID)
            }
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            if remote.deliveryStatus == "rejected" { if let rejected = try await state.draftStore.markRejected(draft.id, reservation: storageReservation) { local = rejected; staleConflict = false; status = "Delivery was rejected. Edit a new copy to try again." }; return }
            guard Self.canKeepBoth(remoteDeliveryStatus: remote.deliveryStatus, localDeliveryState: draft.deliveryState, hasDeliveryKey: draft.idempotencyKey != nil) else { staleConflict = false; status = "This draft’s delivery is \(remote.deliveryStatus). It cannot be detached safely."; return }
            verifiedRemote = remote
        } catch is ComposeReconciliationCheckpoint.Failure {
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, state.client === client else { return }
            status = "Could not save your latest edits. Keep this draft open and try again. No server copy was changed."
            return
        } catch { guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client else { return }; staleConflict = false; status = "Delivery status could not be verified, so no copy was detached."; return }
        guard let verifiedRemote else { return }
        do { local = try await state.draftStore.makeEditableCopy(draft, verifiedRemote: verifiedRemote, reservation: storageReservation); staleConflict = false; status = "Both drafts kept. This version will send as a new draft." }
        catch { status = "Could not preserve both drafts — no server copy was changed" }
    }
    func editRejectedCopy() async {
        guard !heldByAnotherComposer, rejectedDelivery, draftOperation.reserve(.reconciliation) else { return }
        defer { draftOperation.release(.reconciliation) }
        let pendingSave = saveTask; pendingSave?.cancel(); await pendingSave?.value
        guard !Task.isCancelled, !completed, var draft = local, rejectedDelivery, let serverID = draft.serverID, let accountID = draftAccountID, draft.accountId == accountID, let ownerScope = draftOwnerScope, ownerScope == state.ownerScope, let client = state.client else { return }
        guard let sharedOperation = await beginSharedOperation() else { return }
        defer { endSharedOperation(sharedOperation) }
        do {
            let remote = try await client.draft(serverID, accountId: accountID)
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            guard Self.canEditRejectedCopy(remoteDeliveryStatus: remote.deliveryStatus, localDeliveryState: draft.deliveryState) else { status = "Delivery is \(remote.deliveryStatus). A new copy was not created."; return }
            let copy = try await state.draftStore.makeEditableCopy(draft, verifiedRemote: remote, reservation: storageReservation)
            guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client, local?.id == draft.id else { return }
            local = copy; status = "New editable copy created. The rejected server record was preserved."
        } catch { guard !Task.isCancelled, ownerScope == state.ownerScope, draftAccountID == accountID, let activeClient = state.client, activeClient === client else { return }; status = "Rejection could not be verified, so no new copy was created." }
    }
}
