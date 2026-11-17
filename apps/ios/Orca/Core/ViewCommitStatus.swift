import Foundation

/// Mirrors the strict BRE-478 shared response, including revision fences.
struct ViewCommitStatus: Decodable {
    enum Outcome { case applied(String, Int, Int), notApplied(String, Int, Int?), unknown(String) }
    let workspaceId: String
    let retryKey: String
    let expectedWorkspace: Int
    let expectedView: Int?
    let outcome: Outcome
    init(from decoder: Decoder) throws {
        let value = try MailActionJSON(from: decoder)
        func invalid() -> DecodingError { .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid View commit status proof")) }
        guard case .object(let object) = value,
              let outcomeName = object["outcome"]?.text else { throw invalid() }
        let common: Set<String> = ["operation", "workspaceId", "retryKey", "expectedRevisions", "outcome"]
        let fields: Set<String>
        switch outcomeName {
        case "applied": fields = ["viewId", "committedWorkspaceRevision", "committedViewRevision"]
        case "not_applied": fields = ["reason", "observedWorkspaceRevision", "observedViewRevision"]
        case "unknown": fields = ["reason"]
        default: throw invalid()
        }
        guard Set(object.keys) == common.union(fields), value["operation"].text == "view_commit",
              case .object(let revisions) = value["expectedRevisions"], Set(revisions.keys) == ["workspace", "view"],
              let workspace = Self.identifier(value["workspaceId"]), let key = Self.identifier(value["retryKey"]),
              let expectedW = Self.revision(value["expectedRevisions"]["workspace"]) else { throw invalid() }
        let expectedV: Int?
        if case .null = value["expectedRevisions"]["view"] { expectedV = nil }
        else { guard let revision = Self.revision(value["expectedRevisions"]["view"]) else { throw invalid() }; expectedV = revision }
        workspaceId = workspace; retryKey = key; expectedWorkspace = expectedW; expectedView = expectedV
        switch outcomeName {
        case "applied":
            guard let id = Self.identifier(value["viewId"]), let w = Self.revision(value["committedWorkspaceRevision"]),
                  let v = Self.revision(value["committedViewRevision"]), w == expectedW + 1, v == (expectedV.map { $0 + 1 } ?? 1) else { throw invalid() }
            outcome = .applied(id, w, v)
        case "not_applied":
            guard let reason = value["reason"].text, ["workspace_advanced", "unchanged_view"].contains(reason),
                  let w = Self.revision(value["observedWorkspaceRevision"]) else { throw invalid() }
            let v: Int?
            if case .null = value["observedViewRevision"] { v = nil }
            else { guard let revision = Self.revision(value["observedViewRevision"]) else { throw invalid() }; v = revision }
            guard reason == "workspace_advanced" ? w > expectedW : expectedV != nil && v == expectedV && w >= expectedW else { throw invalid() }
            outcome = .notApplied(reason, w, v)
        default:
            guard let reason = value["reason"].text,
                  ["eligible_or_unresolved", "future_revision", "command_mismatch", "incompatible_reservation", "invalid_receipt", "workspace_unavailable"].contains(reason) else { throw invalid() }
            outcome = .unknown(reason)
        }
    }
    private static func identifier(_ value: MailActionJSON) -> String? {
        guard let text = value.text else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
        return !trimmed.isEmpty && trimmed.utf16.count <= 200 ? trimmed : nil
    }
    private static func revision(_ value: MailActionJSON) -> Int? {
        guard let number = value.integer, number > 0, number <= 9_007_199_254_740_991 else { return nil }; return number
    }
    func binds(_ command: MailActionJSON, owner: String) -> Bool {
        let originalView: Int?
        if case .null = command["expectedRevisions"]["view"] { originalView = nil }
        else { guard let value = Self.revision(command["expectedRevisions"]["view"]) else { return false }; originalView = value }
        guard workspaceId == owner, retryKey == command["retryKey"].text,
              expectedWorkspace == command["expectedRevisions"]["workspace"].integer, expectedView == originalView else { return false }
        if case .applied(let id, _, _) = outcome, originalView != nil { return id == command["draft"]["viewId"].text }
        return true
    }
}
