import Foundation
import SwiftUI

struct NativeViewSelection: Identifiable, Codable, Equatable {
    var viewId: String?; var query: String?; var accountId: String
    var id: String { accountId + "|" + (viewId ?? "search|" + (query ?? "")) }
}

/// A submitted Save is immutable until its original idempotent command returns.
/// The account journal survives dismissal/termination; edits never replace it.
@MainActor final class NativeViewEditorController: ObservableObject {
    private struct Edits: Codable, Equatable {
        var name: String; var description: String; var subject: String; var replaceSearch: Bool
    }
    private struct Command: Codable { var body: MailActionJSON; var submitted: Edits }
    private struct Journal: Codable {
        var context: NativeViewSelection; var command: Command?; var adoptedViewId: String?; var edits: Edits
    }
    @Published private(set) var draft: MailActionJSON?
    @Published private(set) var preview: MailActionJSON?
    @Published var name = ""
    @Published var description = ""
    @Published var subject = ""
    @Published var replaceSearch = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var status: String?
    @Published private(set) var changed = false
    @Published private(set) var pendingTarget: String?
    private var baseline: Edits?
    private var scope = ""
    private var generation = UUID()
    private var presented = false
    private let defaults: UserDefaults
    private var state: AppState?
    private var selection: NativeViewSelection?
    private var journal: Journal?
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    private var edits: Edits { .init(name: name, description: description, subject: subject, replaceSearch: replaceSearch) }
    private var key: String { "native-view.pending.v1|\(scope)|\(selection?.accountId ?? "")" }
    private var matchingContext: Bool { journal?.context == selection || (selection?.viewId != nil && journal?.adoptedViewId == selection?.viewId && journal?.context.accountId == selection?.accountId) }
    private func current(_ request: UUID) -> Bool {
        guard let state, let selection else { return false }
        return presented && !Task.isCancelled && generation == request && scope == state.ownerScope && state.phase == .ready
            && state.selectedAccount?.id == selection.accountId && state.accounts.contains { $0.id == selection.accountId }
    }
    private func persist() {
        pendingTarget = journal?.command == nil ? nil : "Original Save: \(journal!.command!.submitted.name) (\(journal!.context.viewId ?? journal!.context.query ?? "new View"))."
        if let journal, let data = try? JSONEncoder().encode(journal) { defaults.set(data, forKey: key) }
        else { defaults.removeObject(forKey: key) }
    }
    private func restore(_ value: Edits) { name = value.name; description = value.description; subject = value.subject; replaceSearch = value.replaceSearch }
    func open(selection: NativeViewSelection, state: AppState) async {
        generation = UUID(); self.selection = selection; self.state = state; scope = state.ownerScope; presented = true
        draft = nil; preview = nil; status = nil; baseline = nil; changed = false
        journal = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Journal.self, from: $0) }
        persist(); await load()
    }
    func close() { edited(); presented = false; generation = UUID(); busy = false }
    /// Unacknowledged commands are never discarded. Only ordinary local edits can be discarded.
    func discardEdits() {
        guard journal?.command == nil, journal == nil || matchingContext else { return }
        journal = nil; persist(); changed = false
    }
    func edited() {
        guard draft != nil else { return }
        changed = edits != baseline; preview = nil
        if matchingContext { journal?.edits = edits; persist() }
    }
    func load() async {
        guard let state, let selection, !busy, let client = state.client else { return }
        let request = generation; guard current(request) else { return }
        busy = true; error = nil; defer { if request == generation { busy = false } }
        if matchingContext, let journal, let command = journal.command {
            draft = command.body["draft"]; baseline = command.submitted; restore(journal.edits); changed = true
            error = "Save outcome unknown. Retry the original Save before previewing or saving replacement edits."
            return
        }
        do {
            let prepared = try await prepare(client: client, selection: selection, adoptedId: matchingContext ? journal?.adoptedViewId : nil)
            guard current(request) else { return }
            install(prepared, selection: selection, keeping: matchingContext ? journal?.edits : nil)
        } catch { if current(request) { self.error = error.localizedDescription } }
    }
    private func prepare(client: APIClient, selection: NativeViewSelection, adoptedId: String?) async throws -> MailActionJSON {
        let body: MailActionJSON
        if let id = adoptedId ?? selection.viewId { body = .object(["kind": .string("saved_view"), "viewId": .string(id)]) }
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
        return try await client.request("v1/organization/views/prepare", method: "POST", body: body)
    }
    private func install(_ result: MailActionJSON, selection: NativeViewSelection, keeping: Edits?) {
        draft = result["draft"]; preview = nil
        let saved = Edits(name: result["draft"]["identity"]["name"].text ?? "", description: result["draft"]["identity"]["description"].text ?? "", subject: selection.query ?? "", replaceSearch: false)
        baseline = saved; restore(keeping ?? saved); changed = edits != saved
    }
    func review() async {
        guard let state, let selection, !busy, current(generation), let client = state.client, let draft else { return }
        guard journal == nil || matchingContext else { error = "Reopen the original View to finish its retained edits before editing another View."; return }
        guard journal?.command == nil else { error = "Resolve the original Save for this account before previewing a replacement. Preview never replays a write."; return }
        let request = generation, reviewedEdits = edits; busy = true; error = nil; defer { if request == generation { busy = false } }
        var input = draft.keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        input = input.setting("identity", to: draft["identity"].setting("name", to: .string(name.trimmingCharacters(in: .whitespacesAndNewlines))).setting("description", to: .string(description)))
        if selection.query != nil && replaceSearch && !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            input = input.setting("definition", to: draft["definition"].setting("thread", to: draft["definition"]["thread"].setting("subjectContains", to: .string(subject.trimmingCharacters(in: .whitespacesAndNewlines)))))
                .setting("unsupportedClauses", to: .array([]))
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": input, "page": .object(["limit": .number(25)])]))
            guard current(request) else { return }
            guard edits == reviewedEdits else { error = "Your edits changed while previewing. Preview them again before saving."; return }; preview = result
        } catch { if current(request) { self.error = error.localizedDescription } }
    }
    func save() async -> String? {
        guard let state, let selection, current(generation), !busy, let client = state.client else { return nil }
        let command: Command
        if let pending = journal?.command { command = pending }
        else {
            guard journal == nil || matchingContext else { error = "Finish the original View’s retained edits first."; return nil }
            guard let preview, preview["draft"]["saveEligibility"]["allowed"].flag else { return nil }
            command = .init(body: .object([
                "draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]),
                "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null
            ]), submitted: edits)
            journal = .init(context: selection, command: command, adoptedViewId: preview["draft"]["viewId"].text, edits: edits); persist()
        }
        let request = generation; busy = true; error = nil; defer { if request == generation { busy = false } }
        do {
            // This endpoint's idempotent replay is the existing reconciliation contract.
            // Never prepare a new command/key while this acknowledgement is uncertain.
            let result: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: command.body)
            guard current(request), let id = result["view"]["id"].text, !id.isEmpty else { return nil }
            let ownsContext = matchingContext, retained = journal?.edits ?? edits
            journal?.command = nil; journal?.adoptedViewId = id; persist()
            guard ownsContext else {
                status = "Original Save acknowledged for a different editor. Reopen that original View to continue its edits."
                // Keep its working identity/edits; another context may not replace it.
                error = "Finish the original View before saving a different View in this account."; return nil
            }
            if retained == command.submitted {
                journal = nil; persist(); baseline = edits; changed = false; status = "View saved."; return id
            }
            // Acknowledge only the submitted definition. Preserve newer edits on the
            // created identity; they need their own fresh preview and explicit Save.
            draft = nil; preview = nil
            status = "Earlier Save acknowledged. Newer edits are kept on that View; preview and save them separately."
            let prepared = try await prepare(client: client, selection: selection, adoptedId: id)
            guard current(request) else { return nil }
            install(prepared, selection: selection, keeping: retained); return nil
        } catch {
            if current(request) { self.error = journal?.command == nil ? "View saved; reconnect to load its current definition. Your newer edits are kept." : "Save outcome unknown. Retry the original Save; replacement edits are kept. \(error.localizedDescription)" }
            return nil
        }
    }
}
