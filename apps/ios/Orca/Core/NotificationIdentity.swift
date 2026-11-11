import Foundation
import SwiftUI

/// Durable installation identity is a server/origin + authenticated Orca user tuple.
/// It never depends on provider email, selected mailbox, access token or session rotation.
struct NotificationInstallationStore {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    var legacyID: String? { defaults.string(forKey: "installationID") }
    func saved(scope: String) -> String? { defaults.string(forKey: "notificationInstallationID.v1|" + scope) }
    func save(_ id: String, scope: String) { defaults.set(id, forKey: "notificationInstallationID.v1|" + scope) }
}

@MainActor final class NotificationInstallationIdentity: ObservableObject {
    @Published private(set) var installationID: String?
    @Published private(set) var status = "Checking authenticated device owner…"
    private let store: NotificationInstallationStore
    private var scope: String?
    private var generation = UUID()
    private var resolution: Task<String?, Never>?
    init(store: NotificationInstallationStore = .init()) { self.store = store }
    func savedInstallation(scope: String) -> String? { store.saved(scope: scope) }
    func invalidate() {
        generation = UUID(); resolution?.cancel(); resolution = nil; installationID = nil; scope = nil
        status = "Checking authenticated device owner…"
    }
    func resolve(state: AppState) async -> String? {
        guard state.phase == .ready, let userID = state.userID, let client = state.client,
              state.validatedBaseURL(state.baseURLText) != nil else {
            invalidate(); status = "Device owner is unavailable. Reconnect before changing notifications."; return nil
        }
        let owner = state.ownerScope
        if scope != owner { invalidate(); scope = owner }
        if let installationID { return installationID }
        if let resolution { return await resolution.value }
        let request = generation
        status = "Checking authenticated device owner…"
        let task = Task { @MainActor [weak self] () -> String? in
            guard let self else { return nil }
            func current() -> Bool {
                !Task.isCancelled && request == generation && scope == owner && state.ownerScope == owner
                    && state.userID == userID && state.phase == .ready && state.client === client
            }
            do {
                let server = await client.serverOrigin()
                guard current(), owner == server + "|" + userID else {
                    if current() { status = "Server identity changed. Reconnect before changing notifications." }; return nil
                }
                // Cached identity is insufficient to resolve a new notification owner.
                let session: AuthSession = try await client.request("v1/auth/session")
                guard current() else { return nil }
                guard session.isAuthenticated, session.user?.id == userID else {
                    status = "Device owner could not be authenticated. Reconnect before changing notifications."; return nil
                }
                if let saved = store.saved(scope: owner) {
                    installationID = saved; status = "Device owner confirmed"; return saved
                }
                var id: String?
                if let legacy = store.legacyID {
                    // A foreign, missing or offline legacy status never grants ownership.
                    // This endpoint lists registrations for the current authenticated user.
                    let status = try await client.pushStatus(installationId: legacy)
                    guard current() else { return nil }
                    if status.devices.contains(where: { $0.installationId == legacy }) { id = legacy }
                }
                guard current() else { return nil }
                let resolved = id ?? UUID().uuidString.lowercased()
                store.save(resolved, scope: owner)
                installationID = resolved; status = "Device owner confirmed"; return resolved
            } catch {
                guard current() else { return nil }
                status = "Device ownership could not be checked. Previous choices are kept; registration and adoption are paused."
                return nil
            }
        }
        resolution = task
        let result = await task.value
        if request == generation { resolution = nil }
        return result
    }
}
