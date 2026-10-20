import Foundation

struct LocalDraft: Codable, Identifiable, Hashable {
    struct RecipientText: Codable, Hashable { var to: String; var cc: String; var bcc: String }
    var id: UUID; var ownerScope: String; var accountId: String; var serverID: String?; var serverRevision: Int?; var content: DraftContent
    var idempotencyKey: String?; var deliveryState: String; var modifiedAt: Date; var recipientText: RecipientText? = nil
    // Optional only for decoding pre-versioned files and brand-new, unsaved
    // drafts. Every record exposed by DraftStore has a durable revision.
    var storageRevision: UUID? = nil
    init(ownerScope: String, accountId: String, content: DraftContent = .init()) { id = UUID(); self.ownerScope = ownerScope; self.accountId = accountId; self.content = content; deliveryState = "local"; modifiedAt = .now }
}

enum DraftDeliveryTransition: Equatable {
    case prepare
    case uncertain
    case rejected
    case confirmedPreReservation(serverRevision: Int?)
}

enum DraftDeliveryRecovery {
    enum RecoveryError: LocalizedError {
        case missingServerDraft
        var errorDescription: String? { "This draft has no server record to check. No delivery was started." }
    }
    /// A server draft opened on a different device has no local delivery key.
    /// Inspect it with GET; never invent a replacement command to check status.
    static func check(_ draft: LocalDraft, client: APIClient) async throws -> DeliveryResult {
        guard let id = draft.serverID else { throw RecoveryError.missingServerDraft }
        if let revision = draft.serverRevision, let key = draft.idempotencyKey {
            return try await client.sendDraft(id, accountId: draft.accountId, revision: revision, idempotencyKey: key)
        }
        let remote = try await client.draft(id, accountId: draft.accountId)
        return DeliveryResult(draftId: remote.id, status: remote.deliveryStatus, providerMessageId: remote.providerMessageId, providerThreadId: remote.providerThreadId, error: nil)
    }
}

actor DraftStore {
    /// An in-memory lease shared by every composer using this store. Hold it
    /// across network awaits so a second editor cannot start another operation
    /// or overwrite the identity/content that operation is using.
    struct Reservation: Sendable, Equatable {
        let id: UUID
        let draftID: UUID
    }
    enum StoreError: LocalizedError, Equatable {
        case recoveryRequired, staleDraft, identityChanged, copyNotAllowed, operationInProgress, invalidReservation
        var errorDescription: String? {
            switch self {
            case .recoveryRequired: "Local drafts could not be loaded safely. The original file was preserved; export or recover it before saving."
            case .staleDraft: "This draft changed or was removed. Reopen the saved draft before continuing."
            case .identityChanged: "A saved draft's identity or delivery state cannot be replaced by an ordinary save."
            case .copyNotAllowed: "Delivery must be verified before an editable copy can be created."
            case .operationInProgress: "Another operation is already using this draft. Wait for it to finish before continuing."
            case .invalidReservation: "This draft operation is no longer active. Reopen the saved draft before continuing."
            }
        }
    }
    private var drafts = [LocalDraft](); private let fileURL: URL; private var recoveryError: Error?
    private var reservations = [UUID: Reservation]()
    // A visible editor may have typing that has not reached autosave yet.
    // Runtime-only registrations protect that writing during list refreshes.
    private var editors = [UUID: UUID]()
    init(directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Orca")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        fileURL = root.appending(path: "drafts.json")
        if FileManager.default.fileExists(atPath: fileURL.path) {
            do {
                var loaded = try JSONDecoder().decode([LocalDraft].self, from: Data(contentsOf: fileURL))
                if loaded.contains(where: { $0.storageRevision == nil }) {
                    for index in loaded.indices where loaded[index].storageRevision == nil { loaded[index].storageRevision = UUID() }
                    // Commit migration before any caller can capture an
                    // unversioned snapshot. A failed write preserves the file
                    // and leaves the store in recovery mode.
                    try JSONEncoder().encode(loaded).write(to: fileURL, options: [.atomic, .completeFileProtection])
                }
                drafts = loaded
            } catch { recoveryError = error }
        }
    }
    func all(ownerScope: String, accountId: String) -> [LocalDraft] { drafts.filter { $0.ownerScope == ownerScope && $0.accountId == accountId }.sorted { $0.modifiedAt > $1.modifiedAt } }
    func current(_ id: UUID, ownerScope: String, accountId: String) -> LocalDraft? {
        drafts.first { $0.id == id && $0.ownerScope == ownerScope && $0.accountId == accountId }
    }
    func beginEditing(_ id: UUID, ownerScope: String, accountId: String, editorID: UUID) -> LocalDraft? {
        guard let draft = current(id, ownerScope: ownerScope, accountId: accountId) else { return nil }
        editors[editorID] = id
        return draft
    }
    func endEditing(_ editorID: UUID) { editors.removeValue(forKey: editorID) }
    /// Only call with the full, freshly fetched server draft. List summaries
    /// omit writing fields and cannot establish that a local shadow is unchanged.
    @discardableResult func reconcileSent(_ remote: MessageDraft, ownerScope: String, accountId: String, reservation: Reservation? = nil, editorID: UUID? = nil) throws -> [LocalDraft] {
        try requireHealthy()
        if let reservation {
            try requireReservation(for: reservation.draftID, reservation: reservation)
            guard let owned = current(reservation.draftID, ownerScope: ownerScope, accountId: accountId),
                  owned.serverID == remote.id, remote.accountId == accountId else { throw StoreError.invalidReservation }
            if let editorID, editors[editorID] != reservation.draftID { throw StoreError.invalidReservation }
        } else if editorID != nil { throw StoreError.invalidReservation }
        guard remote.deliveryStatus == "sent", remote.accountId == accountId else {
            return all(ownerScope: ownerScope, accountId: accountId)
        }
        // A lease freezes future edits, but another editor may still hold
        // pre-lease typing. Bypass only the requesting editor's registration.
        let openDraftIDs = Set(editors.compactMap { id, draftID in
            id == editorID && draftID == reservation?.draftID ? nil : draftID
        })
        var removed = Set<UUID>()
        let candidate = drafts.compactMap { draft -> LocalDraft? in
            guard draft.ownerScope == ownerScope, draft.accountId == accountId, draft.serverID == remote.id,
                  reservation?.draftID == draft.id || reservations[draft.id] == nil, !openDraftIDs.contains(draft.id),
                  draft.serverRevision.map({ remote.revision >= $0 }) ?? false else { return draft }
            if Self.hasSameWriting(draft, as: remote) {
                removed.insert(draft.id)
                return nil
            }
            // These words were not sent. Preserve their identity and the
            // original delivery key, and require an explicit copy to edit/send.
            guard draft.deliveryState != "sent" || draft.serverRevision != remote.revision else { return draft }
            var preserved = draft
            // Retain the newest verified revision so a late older response
            // cannot subsequently retire preserved writing on a false match.
            preserved.serverRevision = remote.revision
            preserved.deliveryState = "sent"; preserved.storageRevision = UUID()
            return preserved
        }
        if candidate != drafts {
            try persist(candidate); drafts = candidate
            editors = editors.filter { !removed.contains($0.value) }
        }
        return all(ownerScope: ownerScope, accountId: accountId)
    }
    func recoveryMessage() -> String? { recoveryError == nil ? nil : StoreError.recoveryRequired.localizedDescription }
    func reserve(_ snapshot: LocalDraft) throws -> Reservation {
        try requireHealthy()
        guard let current = drafts.first(where: { $0.id == snapshot.id }) else { throw StoreError.staleDraft }
        try requireCurrent(snapshot, current: current)
        guard reservations[snapshot.id] == nil else { throw StoreError.operationInProgress }
        let reservation = Reservation(id: UUID(), draftID: snapshot.id)
        reservations[snapshot.id] = reservation
        return reservation
    }
    func release(_ reservation: Reservation) {
        guard reservations[reservation.draftID] == reservation else { return }
        reservations.removeValue(forKey: reservation.draftID)
    }
    func isReserved(_ id: UUID) -> Bool { reservations[id] != nil }
    @discardableResult func save(_ draft: LocalDraft, reservation: Reservation? = nil) throws -> LocalDraft {
        try requireHealthy()
        // Check before the identical-save shortcut: even a harmless-looking
        // reopened composer must not adopt an in-flight operation's snapshot.
        try requireReservation(for: draft.id, reservation: reservation)
        var candidate = drafts
        var copy = draft
        if let index = drafts.firstIndex(where: { $0.id == draft.id }) {
            let current = drafts[index]
            guard draft.storageRevision != nil else { throw StoreError.staleDraft }
            // A Back flush or reopened composer's initial autosave may carry
            // exactly the persisted value. It must not invalidate another
            // editor's snapshot merely by refreshing storage metadata. A stale
            // but identical versioned snapshot can adopt the current revision.
            var value = draft
            value.modifiedAt = current.modifiedAt; value.storageRevision = current.storageRevision
            if value == current { return current }
            try requireCurrent(draft, current: current)
            guard current.deliveryState != "sent" else { throw StoreError.identityChanged }
            guard (current.serverID == nil || draft.serverID == current.serverID),
                  draft.idempotencyKey == current.idempotencyKey,
                  draft.deliveryState == current.deliveryState else { throw StoreError.identityChanged }
            if let revision = current.serverRevision {
                guard let proposedRevision = draft.serverRevision, proposedRevision >= revision else { throw StoreError.identityChanged }
            }
            copy.storageRevision = UUID(); copy.modifiedAt = .now
            candidate[index] = copy
        } else {
            // A previously persisted snapshot must never recreate a row after
            // Send, deletion, or an explicit copy retired its local identity.
            guard draft.storageRevision == nil else { throw StoreError.staleDraft }
            copy.storageRevision = UUID(); copy.modifiedAt = .now
            candidate.append(copy)
        }
        try persist(candidate); drafts = candidate
        return copy
    }
    func makeEditableCopy(_ draft: LocalDraft, verifiedRemote remote: MessageDraft, reservation: Reservation? = nil) throws -> LocalDraft {
        try requireHealthy()
        try requireReservation(for: draft.id, reservation: reservation)
        guard let index = drafts.firstIndex(where: { $0.id == draft.id }) else { throw StoreError.staleDraft }
        let current = drafts[index]
        try requireCurrent(draft, current: current)
        guard draft.serverID == current.serverID, draft.serverRevision == current.serverRevision,
              draft.idempotencyKey == current.idempotencyKey, draft.deliveryState == current.deliveryState else { throw StoreError.identityChanged }
        guard remote.id == current.serverID, remote.accountId == current.accountId,
              current.serverRevision.map({ remote.revision >= $0 }) ?? false else { throw StoreError.copyNotAllowed }
        let unreserved = remote.deliveryStatus == "draft" && ["local", "draft"].contains(current.deliveryState) && current.idempotencyKey == nil
        let rejected = remote.deliveryStatus == "rejected" && current.deliveryState == "rejected"
        let sent = remote.deliveryStatus == "sent" && current.deliveryState == "sent"
        guard unreserved || rejected || sent else { throw StoreError.copyNotAllowed }
        var copy = draft
        copy.id = UUID(); copy.storageRevision = UUID(); copy.modifiedAt = .now
        copy.serverID = nil; copy.serverRevision = nil; copy.idempotencyKey = nil; copy.deliveryState = "local"
        // Replacing the old row and persisting the new identity is one write.
        // Stale composers retain the retired ID/revision and cannot restore it.
        var candidate = drafts; candidate[index] = copy
        try persist(candidate); drafts = candidate
        editors = editors.mapValues { $0 == draft.id ? copy.id : $0 }
        return copy
    }
    func remove(_ id: UUID, reservation: Reservation? = nil) throws {
        try requireHealthy()
        try requireReservation(for: id, reservation: reservation)
        let candidate = drafts.filter { $0.id != id }
        try persist(candidate); drafts = candidate
        editors = editors.filter { $0.value != id }
    }
    func transition(_ id: UUID, _ transition: DraftDeliveryTransition, reservation: Reservation? = nil) throws -> LocalDraft? {
        try requireHealthy()
        try requireReservation(for: id, reservation: reservation)
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return nil }
        guard drafts[index].deliveryState != "sent" else { throw StoreError.identityChanged }
        var candidate = drafts
        switch transition {
        case .prepare:
            if candidate[index].idempotencyKey == nil { candidate[index].idempotencyKey = UUID().uuidString }
            candidate[index].deliveryState = "sending"
        case .uncertain:
            candidate[index].deliveryState = "ambiguous"
        case .rejected:
            candidate[index].deliveryState = "rejected"
        case let .confirmedPreReservation(serverRevision):
            candidate[index].idempotencyKey = nil
            candidate[index].deliveryState = "local"
            if let serverRevision { candidate[index].serverRevision = serverRevision }
        }
        candidate[index].modifiedAt = .now; candidate[index].storageRevision = UUID()
        try persist(candidate); drafts = candidate
        return candidate[index]
    }
    func prepareSend(_ id: UUID, reservation: Reservation? = nil) throws -> LocalDraft { guard let draft = try transition(id, .prepare, reservation: reservation) else { throw CocoaError(.fileNoSuchFile) }; return draft }
    @discardableResult func markAmbiguous(_ id: UUID, reservation: Reservation? = nil) throws -> LocalDraft? { try transition(id, .uncertain, reservation: reservation) }
    func markRejected(_ id: UUID, reservation: Reservation? = nil) throws -> LocalDraft? { try transition(id, .rejected, reservation: reservation) }
    private static func normalizedAddresses(_ recipients: [Recipient]) -> [String] {
        recipients.map { $0.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    }
    private static func rawRecipientsMatch(_ text: String, recipients: [Recipient]) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let addresses = trimmed.isEmpty ? [] : text.split(separator: ",", omittingEmptySubsequences: false).map {
            String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        // Never filter invalid/unfinished tokens: doing so would discard typing.
        return addresses == normalizedAddresses(recipients)
    }
    private static func hasSameWriting(_ draft: LocalDraft, as remote: MessageDraft) -> Bool {
        let local = draft.content
        guard normalizedAddresses(local.to) == normalizedAddresses(remote.to),
              normalizedAddresses(local.cc) == normalizedAddresses(remote.cc),
              normalizedAddresses(local.bcc) == normalizedAddresses(remote.bcc),
              local.subject == remote.subject, local.body == remote.body,
              local.context == remote.context, local.attachments == remote.attachments else { return false }
        guard let raw = draft.recipientText else { return true }
        return rawRecipientsMatch(raw.to, recipients: local.to)
            && rawRecipientsMatch(raw.cc, recipients: local.cc)
            && rawRecipientsMatch(raw.bcc, recipients: local.bcc)
    }
    private func requireHealthy() throws { if recoveryError != nil { throw StoreError.recoveryRequired } }
    private func requireReservation(for id: UUID, reservation: Reservation?) throws {
        if let reservation {
            // Reject expired and cross-draft tokens even after the lease was
            // released. A stale completion never becomes an ordinary mutation.
            guard reservation.draftID == id, reservations[id] == reservation else { throw StoreError.invalidReservation }
        } else if reservations[id] != nil {
            throw StoreError.operationInProgress
        }
    }
    private func requireCurrent(_ draft: LocalDraft, current: LocalDraft) throws {
        guard let revision = draft.storageRevision, revision == current.storageRevision else { throw StoreError.staleDraft }
        guard draft.ownerScope == current.ownerScope, draft.accountId == current.accountId else { throw StoreError.identityChanged }
    }
    private func persist(_ value: [LocalDraft]) throws { try JSONEncoder().encode(value).write(to: fileURL, options: [.atomic, .completeFileProtection]) }
}
