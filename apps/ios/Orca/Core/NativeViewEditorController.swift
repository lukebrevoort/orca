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
        var context: NativeViewSelection; var command: Command?; var adoptedViewId: String?; var edits: Edits; var appliedViewId: String?
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
    @Published private(set) var appliedTarget: String?
    private var baseline: Edits?
    private var scope = ""
    private var ownerID = "", origin = ""
    private var ownerClient: APIClient?
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
        return presented && !Task.isCancelled && generation == request && scope == state.ownerScope && ownerID == state.userID && state.client === ownerClient && origin == canonicalOrigin(state.validatedBaseURL(state.baseURLText)) && state.phase == .ready
            && state.selectedAccount?.id == selection.accountId && state.accounts.contains { $0.id == selection.accountId }
    }
    private func canonicalOrigin(_ url: URL?) -> String? {
        guard let url else { return nil }; var parts = URLComponents()
        parts.scheme = url.scheme?.lowercased(); parts.host = url.host?.lowercased()
        parts.port = url.port == (parts.scheme == "https" ? 443 : 80) ? nil : url.port
        return parts.string
    }
    private func currentClient(_ request: UUID) async -> Bool {
        guard current(request), let client = ownerClient else { return false }
        let actualOrigin = await client.serverOrigin()
        return current(request) && actualOrigin == origin
    }
    var canFinishPresentation: Bool { current(generation) }
    private func persist() {
        appliedTarget = journal?.appliedViewId
        pendingTarget = journal?.command == nil ? nil : "Original Save: \(journal!.command!.submitted.name) (\(journal!.context.viewId ?? journal!.context.query ?? "new View"))."
        if let journal, let data = try? JSONEncoder().encode(journal) { defaults.set(data, forKey: key) }
        else { defaults.removeObject(forKey: key) }
    }
    private func restore(_ value: Edits) { name = value.name; description = value.description; subject = value.subject; replaceSearch = value.replaceSearch }
    func open(selection: NativeViewSelection, state: AppState) async {
        generation = UUID(); self.selection = selection; self.state = state; scope = state.ownerScope; presented = true
        draft = nil; preview = nil; status = nil; baseline = nil; changed = false; journal = nil; error = nil; pendingTarget = nil; appliedTarget = nil; busy = false; ownerID = ""; origin = ""; ownerClient = nil
        let request = generation, capturedScope = scope
        guard let client = state.client, let owner = state.userID, !owner.isEmpty else { error = "Verified account identity is unavailable. Reconnect to edit Views."; return }
        let capturedOrigin = await client.serverOrigin()
        guard generation == request, capturedScope == state.ownerScope, owner == state.userID, state.client === client,
              canonicalOrigin(state.validatedBaseURL(state.baseURLText)) == capturedOrigin else { return }
        ownerID = owner; origin = capturedOrigin; ownerClient = client
        guard current(request) else { return }
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
            error = journal.appliedViewId.map { "Original Save applied as \($0). Reload its current object; no replacement will be created." } ?? "Save outcome unknown. Check or retry the original Save before previewing replacement edits."
            return
        }
        do {
            let prepared = try await prepare(client: client, selection: selection, adoptedId: matchingContext ? journal?.adoptedViewId : nil)
            guard await currentClient(request), validPrepared(prepared, context: selection, adoptedId: matchingContext ? journal?.adoptedViewId : nil, state: state) else { if current(request) { error = "Current View scope could not be verified." }; return }
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
    private func validPrepared(_ value: MailActionJSON, context: NativeViewSelection, adoptedId: String?, state: AppState) -> Bool {
        guard value["workspaceId"].text == ownerID, let workspaceRevision = value["workspaceRevision"].integer, workspaceRevision > 0,
              case .array(let accounts) = value["draft"]["effectiveAccountIds"], !accounts.isEmpty else { return false }
        let ids = accounts.compactMap(\.text)
        guard ids.count == accounts.count, Set(ids).count == ids.count,
              ids.allSatisfy({ id in state.accounts.contains { $0.id == id } }) else { return false }
        if let id = adoptedId ?? context.viewId {
            return value["draft"]["mode"].text == "update" && value["draft"]["viewId"].text == id && (value["draft"]["viewRevision"].integer ?? 0) > 0
        }
        return value["draft"]["mode"].text == "create" && value["draft"]["viewId"].text == nil
            && ids == [context.accountId]
    }
    private func install(_ result: MailActionJSON, selection: NativeViewSelection, keeping: Edits?) {
        draft = result["draft"]; preview = nil
        let saved = Edits(name: result["draft"]["identity"]["name"].text ?? "", description: result["draft"]["identity"]["description"].text ?? "", subject: result["draft"]["mode"].text == "update" ? result["draft"]["definition"]["thread"]["subjectContains"].text ?? selection.query ?? "" : selection.query ?? "", replaceSearch: false)
        baseline = saved; restore(keeping ?? saved); changed = edits != saved
    }
    func review() async {
        guard let state, let selection, !busy, current(generation), let client = state.client, let draft else { return }
        guard journal == nil || matchingContext else { error = "Reopen the original View to finish its retained edits before editing another View."; return }
        guard journal?.command == nil else { error = journal?.appliedViewId.map { "Original Save applied as \($0). Reload its current View before previewing; no replacement will be created." } ?? "Resolve the original Save for this account before previewing a replacement. Preview never replays a write."; return }
        let request = generation, reviewedEdits = edits; busy = true; error = nil; defer { if request == generation { busy = false } }
        var input = draft.keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
        input = input.setting("identity", to: draft["identity"].setting("name", to: .string(name.trimmingCharacters(in: .whitespacesAndNewlines))).setting("description", to: .string(description)))
        if selection.query != nil && replaceSearch && !subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            input = input.setting("definition", to: draft["definition"].setting("thread", to: draft["definition"]["thread"].setting("subjectContains", to: .string(subject.trimmingCharacters(in: .whitespacesAndNewlines)))))
                .setting("unsupportedClauses", to: .array([]))
        }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": input, "page": .object(["limit": .number(25)])]))
            guard await currentClient(request), validPrepared(result, context: selection, adoptedId: matchingContext ? journal?.adoptedViewId : nil, state: state) else { if current(request) { error = "Preview scope could not be verified." }; return }
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
            guard validPrepared(preview, context: selection, adoptedId: matchingContext ? journal?.adoptedViewId : nil, state: state) else { self.preview = nil; error = "View scope changed. Load and preview it again before saving."; return nil }
            command = .init(body: .object([
                "draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]),
                "retryKey": .string(UUID().uuidString), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null
            ]), submitted: edits)
            journal = .init(context: selection, command: command, adoptedViewId: preview["draft"]["viewId"].text, edits: edits); persist()
        }
        let request = generation; busy = true; error = nil; defer { if request == generation { busy = false } }
        guard await currentClient(request) else { return nil }
        do {
            let acknowledgement: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: command.body)
            guard await currentClient(request) else { return nil }
            if let applied = validatedAcknowledgement(acknowledgement, command: command.body) {
                return try await completeApplied(id: applied.id, workspaceRevision: applied.workspace, viewRevision: applied.view, command: command, client: client, state: state, request: request)
            }
            return await resolve(command, client: client, state: state, request: request)
        } catch {
            guard await currentClient(request) else { return nil }
            // HTTP failure itself is never proof. Only the strict status protocol
            // can distinguish a durable rejection from an earlier applied Save.
            if case let APIClient.ClientError.http(code, _) = error, [400, 404, 409].contains(code) {
                return await resolve(command, client: client, state: state, request: request)
            }
            self.error = "Save outcome unknown. The exact original Save and newer edits are kept. Check its outcome or retry safely."
            return nil
        }
    }
    func checkSaveOutcome() async -> String? {
        guard let state, let client = state.client, let command = journal?.command, !busy, current(generation) else { return nil }
        let request = generation; busy = true; error = nil; defer { if request == generation { busy = false } }
        guard await currentClient(request) else { return nil }
        return await resolve(command, client: client, state: state, request: request)
    }
    private func validatedAcknowledgement(_ value: MailActionJSON, command: MailActionJSON) -> (id: String, workspace: Int, view: Int)? {
        // /commit reloads the CURRENT View/workspace. These may be newer than
        // the original receipt; a valid exact-request200 is independent of status.
        guard value["workspaceId"].text == ownerID, value["view"]["workspaceId"].text == ownerID,
              let id = value["view"]["id"].text, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id.utf16.count <= 200,
              value["navigation"]["destination"].text == "view:" + id,
              let w = value["workspaceRevision"].integer, let v = value["view"]["revision"].integer,
              let expectedW = command["expectedRevisions"]["workspace"].integer, expectedW > 0,
              w <= 9_007_199_254_740_991, v <= 9_007_199_254_740_991, w >= expectedW + 1 else { return nil }
        if let expectedV = command["expectedRevisions"]["view"].integer {
            guard command["draft"]["mode"].text == "update", id == command["draft"]["viewId"].text, v >= expectedV + 1 else { return nil }
        } else { guard command["draft"]["mode"].text == "create", v >= 1 else { return nil } }
        return (id, w, v)
    }
    private func completeApplied(id: String, workspaceRevision: Int, viewRevision: Int, command: Command,
                                 client: APIClient, state: AppState, request: UUID) async throws -> String? {
        guard let original = journal, original.command?.body["retryKey"].text == command.body["retryKey"].text else { return nil }
        journal?.adoptedViewId = id; journal?.appliedViewId = id; persist()
        let prepared = try await prepare(client: client, selection: original.context, adoptedId: id)
        guard await currentClient(request) else { return nil }
        guard validPrepared(prepared, context: original.context, adoptedId: id, state: state),
              (prepared["workspaceRevision"].integer ?? 0) >= workspaceRevision,
              (prepared["draft"]["viewRevision"].integer ?? 0) >= viewRevision else {
            error = "Original Save is applied, but its current object could not be verified. No replacement was created."; return nil
        }
        let retained = journal?.edits ?? original.edits, ownsContext = matchingContext
        journal?.command = nil; persist()
        guard ownsContext else { status = "Original View saved as \(id). Reopen its editor to continue retained edits."; return nil }
        if retained == command.submitted {
            install(prepared, selection: original.context, keeping: nil)
            journal = nil; persist(); baseline = edits; changed = false; status = "View saved."; return id
        }
        // Rebase only edits made AFTER the submitted command. Untouched simple
        // fields and advanced predicates come from the freshly authorized object.
        let freshSubject = prepared["draft"]["definition"]["thread"]["subjectContains"].text ?? original.context.query ?? ""
        let filterChanged = retained.subject != command.submitted.subject || retained.replaceSearch != command.submitted.replaceSearch
        let rebased = Edits(name: retained.name == command.submitted.name ? prepared["draft"]["identity"]["name"].text ?? retained.name : retained.name,
                            description: retained.description == command.submitted.description ? prepared["draft"]["identity"]["description"].text ?? retained.description : retained.description,
                            subject: filterChanged ? retained.subject : freshSubject, replaceSearch: filterChanged ? retained.replaceSearch : false)
        journal?.edits = rebased; persist()
        install(prepared, selection: original.context, keeping: rebased)
        status = "Earlier Save acknowledged. Newer edits are kept on that View; preview and save them separately."; return nil
    }
    private func resolve(_ command: Command, client: APIClient, state: AppState, request: UUID) async -> String? {
        do {
            let proof: ViewCommitStatus = try await client.request("v1/organization/views/commit-status", method: "POST", body: command.body)
            guard await currentClient(request) else { return nil }
            guard proof.binds(command.body, owner: ownerID), let original = journal,
                  original.command?.body["retryKey"].text == command.body["retryKey"].text else {
                error = "Save proof did not match the original owner, key and revisions. Original Save is kept."; return nil
            }
            switch proof.outcome {
            case .unknown:
                error = "Save outcome remains unresolved. The original command is kept; you can check again or retry it safely."; return nil
            case .applied(let id, let workspaceRevision, let viewRevision):
                return try await completeApplied(id: id, workspaceRevision: workspaceRevision, viewRevision: viewRevision, command: command, client: client, state: state, request: request)
            case .notApplied(_, let workspaceRevision, let viewRevision):
                let prepared = try await prepare(client: client, selection: original.context, adoptedId: original.adoptedViewId)
                guard await currentClient(request) else { return nil }
                guard validPrepared(prepared, context: original.context, adoptedId: original.adoptedViewId, state: state),
                      (prepared["workspaceRevision"].integer ?? 0) >= workspaceRevision,
                      viewRevision == nil || (prepared["draft"]["viewRevision"].integer ?? 0) >= viewRevision! else {
                    error = "Original Save was not applied, but fresh scope could not be verified. The command and edits are kept."; return nil
                }
                let retained = journal?.edits ?? original.edits, ownsContext = matchingContext
                // The server fence is only for this exact /commit command in
                // this preserved workspace lifetime. Fresh prepare precedes retirement.
                journal?.command = nil; persist()
                guard ownsContext else { status = "Original Save was not applied. Reopen its editor to continue retained edits."; return nil }
                install(prepared, selection: original.context, keeping: retained)
                error = nil; status = "Original Save was not applied. Current View loaded; preview and save your kept edits again."; return nil
            }
        } catch {
            if await currentClient(request) {
                self.error = journal?.appliedViewId.map { "Original Save applied as \($0), but that View is unavailable. No replacement was created. Reconnect and check again." }
                    ?? "Save status could not be verified. Original command and newer edits are kept."
            }
            return nil
        }
    }
}
