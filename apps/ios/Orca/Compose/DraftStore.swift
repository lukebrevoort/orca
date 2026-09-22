import Foundation

struct LocalDraft: Codable, Identifiable, Hashable {
    struct RecipientText: Codable, Hashable { var to: String; var cc: String; var bcc: String }
    var id: UUID; var ownerScope: String; var accountId: String; var serverID: String?; var serverRevision: Int?; var content: DraftContent
    var idempotencyKey: String?; var deliveryState: String; var modifiedAt: Date; var recipientText: RecipientText? = nil
    init(ownerScope: String, accountId: String, content: DraftContent = .init()) { id = UUID(); self.ownerScope = ownerScope; self.accountId = accountId; self.content = content; deliveryState = "local"; modifiedAt = .now }
}

actor DraftStore {
    enum StoreError: LocalizedError { case recoveryRequired; var errorDescription: String? { "Local drafts could not be read. The original file was preserved; export or recover it before saving." } }
    private var drafts = [LocalDraft](); private let fileURL: URL; private var recoveryError: Error?
    init(directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Orca")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        fileURL = root.appending(path: "drafts.json")
        if FileManager.default.fileExists(atPath: fileURL.path) { do { drafts = try JSONDecoder().decode([LocalDraft].self, from: Data(contentsOf: fileURL)) } catch { recoveryError = error } }
    }
    func all(ownerScope: String, accountId: String) -> [LocalDraft] { drafts.filter { $0.ownerScope == ownerScope && $0.accountId == accountId }.sorted { $0.modifiedAt > $1.modifiedAt } }
    func recoveryMessage() -> String? { recoveryError == nil ? nil : StoreError.recoveryRequired.localizedDescription }
    func save(_ draft: LocalDraft) throws { try requireHealthy(); var copy = draft; copy.modifiedAt = .now; var candidate = drafts; if let index = candidate.firstIndex(where: { $0.id == copy.id }) { candidate[index] = copy } else { candidate.append(copy) }; try persist(candidate); drafts = candidate }
    func remove(_ id: UUID) throws { try requireHealthy(); let candidate = drafts.filter { $0.id != id }; try persist(candidate); drafts = candidate }
    func prepareSend(_ id: UUID) throws -> LocalDraft { try requireHealthy(); guard let index = drafts.firstIndex(where: { $0.id == id }) else { throw CocoaError(.fileNoSuchFile) }; var candidate = drafts; if candidate[index].idempotencyKey == nil { candidate[index].idempotencyKey = UUID().uuidString }; candidate[index].deliveryState = "sending"; try persist(candidate); drafts = candidate; return candidate[index] }
    func markAmbiguous(_ id: UUID) throws { try requireHealthy(); guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }; var candidate = drafts; candidate[index].deliveryState = "ambiguous"; try persist(candidate); drafts = candidate }
    private func requireHealthy() throws { if recoveryError != nil { throw StoreError.recoveryRequired } }
    private func persist(_ value: [LocalDraft]) throws { try JSONEncoder().encode(value).write(to: fileURL, options: [.atomic, .completeFileProtection]) }
}
