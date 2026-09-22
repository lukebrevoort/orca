import Foundation

struct LocalDraft: Codable, Identifiable, Hashable {
    var id: UUID; var ownerScope: String; var accountId: String; var serverID: String?; var serverRevision: Int?; var content: DraftContent
    var idempotencyKey: String?; var deliveryState: String; var modifiedAt: Date
    init(ownerScope: String, accountId: String, content: DraftContent = .init()) { id = UUID(); self.ownerScope = ownerScope; self.accountId = accountId; self.content = content; deliveryState = "local"; modifiedAt = .now }
}

actor DraftStore {
    private var drafts = [LocalDraft](); private let fileURL: URL
    init(directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "Orca")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        fileURL = root.appending(path: "drafts.json"); if let data = try? Data(contentsOf: fileURL), let decoded = try? JSONDecoder().decode([LocalDraft].self, from: data) { drafts = decoded }
    }
    func all(ownerScope: String, accountId: String) -> [LocalDraft] { drafts.filter { $0.ownerScope == ownerScope && $0.accountId == accountId }.sorted { $0.modifiedAt > $1.modifiedAt } }
    func save(_ draft: LocalDraft) throws { var copy = draft; copy.modifiedAt = .now; var candidate = drafts; if let index = candidate.firstIndex(where: { $0.id == copy.id }) { candidate[index] = copy } else { candidate.append(copy) }; try persist(candidate); drafts = candidate }
    func remove(_ id: UUID) throws { let candidate = drafts.filter { $0.id != id }; try persist(candidate); drafts = candidate }
    func prepareSend(_ id: UUID) throws -> LocalDraft { guard let index = drafts.firstIndex(where: { $0.id == id }) else { throw CocoaError(.fileNoSuchFile) }; if drafts[index].idempotencyKey == nil { drafts[index].idempotencyKey = UUID().uuidString }; drafts[index].deliveryState = "sending"; try persist(); return drafts[index] }
    func markAmbiguous(_ id: UUID) throws { guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }; drafts[index].deliveryState = "ambiguous"; try persist() }
    private func persist(_ value: [LocalDraft]? = nil) throws { try JSONEncoder().encode(value ?? drafts).write(to: fileURL, options: [.atomic, .completeFileProtection]) }
}
