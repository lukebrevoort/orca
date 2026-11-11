import Foundation

/// Test-only CAS plan, used by the actual Move journey's pre-registered cleanup.
/// No GET-current revision is ever substituted for an owned acknowledgement.
struct RoutingCompensationScope {
    let accountID: String; let threadID: String; let revision: Int; let explicitID: String?; let ordinal: Int
    let allowedDestinationIDs: Set<String>
    struct Target: Codable, Equatable { let scope: String; let threadId: String }
    struct Command: Codable {
        let expectedRevision: Int; let target: Target; let destinationId: String?
        enum CodingKeys: String, CodingKey { case expectedRevision, target, destinationId }
        init(expectedRevision: Int, target: Target, destinationId: String?) { self.expectedRevision = expectedRevision; self.target = target; self.destinationId = destinationId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            expectedRevision = try c.decode(Int.self, forKey: .expectedRevision); target = try c.decode(Target.self, forKey: .target)
            destinationId = try c.decode(String?.self, forKey: .destinationId)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(expectedRevision, forKey: .expectedRevision); try c.encode(target, forKey: .target); try c.encode(destinationId, forKey: .destinationId)
        }
    }
    private struct Selection: Decodable {
        let target: Target; let explicitDestinationId: String?
        enum CodingKeys: String, CodingKey { case target, explicitDestinationId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            target = try c.decode(Target.self, forKey: .target); explicitDestinationId = try c.decode(String?.self, forKey: .explicitDestinationId)
        }
    }
    private struct State: Decodable { let accountId: String; let revision: Int; let selection: Selection }
    private struct Receipt: Decodable { let state: State; let undo: Command }
    private struct Entry: Decodable {
        let ordinal: Int; let receivedAt: Int64; let responseAt: Int64; let accountId: String; let command: Command; let status: Int; let receipt: Receipt?
    }
    private struct Witness: Decodable { let accountId: String; let ordinal: Int; let truncated: Bool; let receipts: [Entry] }
    enum Failure: Error { case witnessNotOwnedOrComplete }
    func plan(_ data: Data) throws -> Command? {
        let witness = try JSONDecoder().decode(Witness.self, from: data)
        guard revision > 0, revision < 9_007_199_254_740_991, ordinal >= 0, witness.accountId == accountID, !witness.truncated, witness.ordinal >= ordinal, witness.receipts.count <= 128 else { throw Failure.witnessNotOwnedOrComplete }
        let entries = witness.receipts.filter { $0.ordinal > ordinal }
        guard entries.count == witness.ordinal - ordinal else { throw Failure.witnessNotOwnedOrComplete }
        if entries.isEmpty { return nil } // UI must separately prove original state unchanged.
        let target = Target(scope: "conversation", threadId: threadID)
        var nextRevision = revision, nextOrdinal = ordinal, previousExplicit = explicitID
        for entry in entries {
            guard let receipt = entry.receipt, let chosen = entry.command.destinationId,
                  entry.ordinal == nextOrdinal + 1, entry.receivedAt <= entry.responseAt,
                  entry.status == 200, entry.accountId == accountID, entry.command.target == target,
                  entry.command.expectedRevision == nextRevision, allowedDestinationIDs.contains(chosen),
                  receipt.state.accountId == accountID, receipt.state.selection.target == target,
                  receipt.state.selection.explicitDestinationId == chosen,
                  receipt.state.revision == nextRevision + 1, receipt.undo.expectedRevision == receipt.state.revision,
                  receipt.undo.target == target, receipt.undo.destinationId == previousExplicit else { throw Failure.witnessNotOwnedOrComplete }
            nextRevision = receipt.state.revision; nextOrdinal = entry.ordinal; previousExplicit = chosen
        }
        return Command(expectedRevision: nextRevision, target: target, destinationId: explicitID)
    }
}
