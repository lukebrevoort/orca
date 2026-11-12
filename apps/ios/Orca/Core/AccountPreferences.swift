import Foundation
import SwiftUI

struct AccountPreferences: Codable, Equatable {
    var signature: String
    var composeFormat: String
    var replyBehavior: String
    var notifyByDefault: Bool
}
@MainActor final class AccountPreferencesController: ObservableObject {
    @Published var edits: AccountPreferences?
    @Published private(set) var saved: AccountPreferences?
    @Published private(set) var loading = false
    @Published private(set) var saving = false
    @Published private(set) var error: String?
    @Published private(set) var status: String?
    @Published private(set) var uncertain = false
    private var scope = ""
    private var preferenceOwnerID: String?
    private var generation = UUID()
    private var loadTask: Task<Void, Never>?
    var dirty: Bool { edits != saved }
    func discard() { edits = saved; status = nil }
    func invalidate() { generation = UUID(); loadTask?.cancel(); loadTask = nil; scope = ""; preferenceOwnerID = nil; edits = nil; saved = nil; loading = false; saving = false; uncertain = false; error = nil; status = nil }
    func load(state: AppState) async {
        if scope != state.ownerScope { invalidate(); scope = state.ownerScope }
        if let loadTask { await loadTask.value; return }
        guard !loading, !saving, !dirty, let client = state.client else { return }
        guard let ownerID = state.userID, !ownerID.isEmpty else { error = "Account identity is unavailable. Reconnect before loading account choices."; return }
        preferenceOwnerID = ownerID
        let headers = ["x-orca-expected-user-id": ownerID]
        loading = true; error = nil; let request = generation, owner = scope, originalEdits = edits
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { if generation == request { loading = false; loadTask = nil } }
            do {
                let value: AccountPreferences = try await client.request("v1/preferences", headers: headers)
                guard !Task.isCancelled, generation == request, owner == state.ownerScope, state.phase == .ready else { return }
                saved = value; if edits == originalEdits { edits = value }
            } catch { if generation == request && owner == state.ownerScope { self.error = error.localizedDescription } }
        }
        loadTask = task
        await task.value
    }
    func checkCurrent(state: AppState) async {
        guard !saving, !loading, let client = state.client, scope == state.ownerScope, let ownerID = preferenceOwnerID else { return }
        let headers = ["x-orca-expected-user-id": ownerID]
        let owner = scope, request = generation; loading = true
        defer { if generation == request { loading = false } }
        do {
            let current: AccountPreferences = try await client.request("v1/preferences", headers: headers)
            guard owner == state.ownerScope, request == generation, state.phase == .ready else { return }
            saved = current; uncertain = false; error = nil; status = dirty ? "Current choices checked. Your edits are kept." : "Account choices saved."
        } catch { if owner == state.ownerScope, request == generation { self.error = error.localizedDescription } }
    }
    func save(state: AppState) async {
        guard !saving, !loading, !uncertain, dirty, let submitted = edits, let client = state.client, scope == state.ownerScope, let ownerID = preferenceOwnerID else { return }
        let headers = ["x-orca-expected-user-id": ownerID]
        saving = true; error = nil; status = nil; let request = generation, owner = scope
        defer { if generation == request { saving = false } }
        do {
            let value: AccountPreferences = try await client.request("v1/preferences", method: "PATCH", body: submitted, headers: headers)
            guard !Task.isCancelled, generation == request, owner == state.ownerScope, state.phase == .ready else { return }
            saved = value; uncertain = false
            if edits == submitted { edits = value; status = "Account choices saved." }
            else { status = "Earlier choices saved. Newer edits are still unsaved." }
        } catch {
            guard generation == request, owner == state.ownerScope else { return }
            // Read back before calling this failed or inviting a replay; preserve newer edits.
            do {
                let current: AccountPreferences = try await client.request("v1/preferences", headers: headers)
                guard generation == request, owner == state.ownerScope, state.phase == .ready else { return }
                saved = current
                if current == submitted { status = edits == submitted ? "Account choices saved." : "Earlier choices saved. Newer edits remain unsaved." }
                else { self.error = "Save was not confirmed. Your edits are kept; review and save again." }
            } catch { if generation == request && owner == state.ownerScope { uncertain = true; self.error = "Save outcome unknown. Your edits are kept. Reconnect and check before saving again." } }
        }
    }
}
