import Foundation
import SwiftUI

struct NativeViewSelection: Identifiable {
    var viewId: String?; var query: String?; var accountId: String
    var id: String { viewId ?? "search|" + (query ?? "") }
}

@MainActor final class NativeViewEditorController: ObservableObject {
    @Published private(set) var draft: MailActionJSON?
    @Published private(set) var preview: MailActionJSON?
    @Published var name = ""
    @Published var description = ""
    @Published var subject = ""
    @Published var replaceSearch = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var changed = false
    private var baseline = [String]()
    private var scope = ""
    private var presented = true
    private var retryKey = UUID().uuidString
    private let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private var state: AppState?
    private var selection: NativeViewSelection?
    private var current: Bool { guard let state, let selection else { return false }; return presented && !Task.isCancelled && scope == state.ownerScope && state.phase == .ready && state.accounts.contains { $0.id == selection.accountId } }
    func open(selection: NativeViewSelection, state: AppState) async { self.selection = selection; self.state = state; await load() }
    func close() { presented = false }
    func edited() { guard draft != nil else { return }; changed = [name, description, subject, String(replaceSearch)] != baseline; preview = nil; retryKey = UUID().uuidString }
    func load() async {
        guard let state, let selection else { return }
        scope = state.ownerScope; presented = true; busy = true; error = nil; defer { busy = false }
        guard let client = state.client else { return }
        let body: MailActionJSON
        if let id = selection.viewId { body = .object(["kind": .string("saved_view"), "viewId": .string(id)]) }
        else {
            let query = selection.query?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            body = .object([
                "kind": .string("typed_definition"), "skipInbox": .bool(false),
                "source": .object(["kind": .string("search"), "label": .string("Native All Mail search")]),
                "identity": .object(["name": .string(String(("Search · " + query).prefix(120)))]),
                "definition": .object(["revision": .number(1), "accountIds": .array([.string(selection.accountId)])]),
                "unsupportedClauses": query.isEmpty ? .array([]) : .array([.object(["id": .string("search.query"), "label": .string("General text search"), "reason": .string("General sender, subject and snippet search cannot be represented as a saved-view predicate.")])])
            ])
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: body)
            guard current else { return }
            name = result["draft"]["identity"]["name"].text ?? ""; description = result["draft"]["identity"]["description"].text ?? ""
            subject = selection.query ?? ""; baseline = [name, description, subject, "false"]; draft = result["draft"]; changed = false
        } catch { if current { self.error = error.localizedDescription } }
    }
    func review() async {
        guard let state, let selection, current, !busy, let client = state.client, let draft else { return }
        busy = true; error = nil; defer { busy = false }
        var input = draft.keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        input = input.setting("identity", to: draft["identity"].setting("name", to: .string(name.trimmingCharacters(in: .whitespacesAndNewlines))).setting("description", to: .string(description)))
        if selection.query != nil && replaceSearch && !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            input = input.setting("definition", to: draft["definition"].setting("thread", to: draft["definition"]["thread"].setting("subjectContains", to: .string(subject.trimmingCharacters(in: .whitespacesAndNewlines)))))
                .setting("unsupportedClauses", to: .array([]))
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": input, "page": .object(["limit": .number(25)])]))
            guard current else { return }; preview = result
        } catch { if current { self.error = error.localizedDescription } }
    }
    func save() async -> String? {
        guard let state, current, !busy, let client = state.client, let preview, preview["draft"]["saveEligibility"]["allowed"].flag else { return nil }
        busy = true; error = nil; defer { busy = false }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object([
                "draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]),
                "retryKey": .string(retryKey), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null
            ]))
            guard current else { return nil }
            changed = false; return result["view"]["id"].text
        } catch { if current { self.error = error.localizedDescription }; return nil }
    }
}
