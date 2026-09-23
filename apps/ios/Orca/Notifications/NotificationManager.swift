import UIKit
import UserNotifications

struct NotificationPreferenceStore {
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func load(scope: String) -> NotificationSelection {
        let key = storageKey(scope: scope)
        if let data = defaults.data(forKey: key), let value = try? decoder.decode(NotificationSelection.self, from: data) {
            return value.normalized()
        }
        let initial: NotificationSelection
        if !defaults.bool(forKey: "notificationSelectionMigrationCompleted"),
           let legacy = defaults.string(forKey: "notificationMode") {
            initial = legacy == "off" ? .off : .inboxOnly
            defaults.set(true, forKey: "notificationSelectionMigrationCompleted")
            defaults.removeObject(forKey: "notificationMode")
        } else {
            initial = .inboxOnly
        }
        save(initial, scope: scope)
        return initial
    }

    func save(_ selection: NotificationSelection, scope: String) {
        if let data = try? encoder.encode(selection.normalized()) { defaults.set(data, forKey: storageKey(scope: scope)) }
    }

    private func storageKey(scope: String) -> String { "notificationSelection|\(scope)" }
}

@MainActor final class NotificationManager: NSObject, ObservableObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @Published private(set) var selection: NotificationSelection = .inboxOnly
    @Published private(set) var spaces = [NotificationSpace]()
    @Published private(set) var catalogLoading = false
    @Published private(set) var catalogErrorMessage: String?
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var statusText = "Not configured"
    @Published private(set) var errorMessage: String?
    weak var state: AppState?
    private let preferenceStore = NotificationPreferenceStore()
    private var activeScope: String?
    private var catalogScope: String?
    private var deviceToken: String?
    private var reconciliation: Task<Void, Never>?
    private var operationID = UUID()
    private var catalogOperationID = UUID()
    private var pendingNotification: [AnyHashable: Any]?
    let installationID: String

    override init() {
        if let saved = UserDefaults.standard.string(forKey: "installationID") { installationID = saved }
        else { let id = UUID().uuidString; installationID = id; UserDefaults.standard.set(id, forKey: "installationID") }
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    var inboxEnabled: Bool { selection.inbox }
    var selectedSpaceIDs: Set<String> { Set(selection.spaceIds) }
    var unavailableSelectedSpaceIDs: [String] {
        let available = Set(spaces.map(\.id))
        return selection.spaceIds.filter { !available.contains($0) }
    }

    func setInboxEnabled(_ enabled: Bool) {
        updateSelection(NotificationSelection(inbox: enabled, spaceIds: selection.spaceIds))
    }

    func setSpace(_ id: String, enabled: Bool) {
        var ids = selection.spaceIds
        if enabled {
            if !ids.contains(id) { ids.append(id) }
        } else {
            ids.removeAll { $0 == id }
        }
        updateSelection(NotificationSelection(inbox: selection.inbox, spaceIds: ids))
    }

    func refreshPermission() async { authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus }
    func requestPermission() async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshPermission()
            reconcile()
        } catch { errorMessage = error.localizedDescription; statusText = "Permission request failed" }
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        deviceToken = token.map { String(format: "%02x", $0) }.joined(); reconcile()
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        errorMessage = error.localizedDescription; statusText = "Registration failed — try again"
    }

    func reconcile() {
        guard let state, state.phase == .ready, let client = state.client else { return }
        activateScope(state.ownerScope)
        let previous = reconciliation
        operationID = UUID()
        let operation = operationID, scope = state.ownerScope, desiredSelection = selection
        reconciliation = Task { [weak self] in
            await previous?.value
            guard let self, isCurrent(operation, scope) else { return }
            if !desiredSelection.isEnabled {
                await removeRegistration(client: client, operation: operation, scope: scope)
                return
            }
            if !desiredSelection.spaceIds.isEmpty, catalogScope != scope {
                statusText = "Loading Spaces…"
                await loadCatalog()
                guard isCurrent(operation, scope) else { return }
                guard catalogScope == scope else { statusText = "Could not load Spaces — tap Retry"; return }
                return
            }
            if !unavailableIDs(in: desiredSelection).isEmpty {
                statusText = "Review unavailable Spaces"
                return
            }
            await refreshPermission()
            guard isCurrent(operation, scope) else { return }
            guard authorization == .authorized || authorization == .provisional else {
                statusText = authorization == .denied ? "Saved · denied in System Settings" : "Saved · permission not requested"
                return
            }
            guard let token = deviceToken else {
                UIApplication.shared.registerForRemoteNotifications(); statusText = "Registering with Apple…"; return
            }
            do {
#if DEBUG
                let environment = "sandbox"
#else
                let environment = "production"
#endif
                let result = try await client.registerDevice(installationId: installationID, token: token, environment: environment, selection: desiredSelection)
                guard isCurrent(operation, scope) else { return }
                statusText = result.push.configured ? "Active · \(selectionLabel(desiredSelection))" : (result.push.disabledReason ?? "Saved; delivery is unavailable")
                errorMessage = nil
            } catch {
                guard isCurrent(operation, scope) else { return }
                errorMessage = error.localizedDescription; statusText = "Could not register — tap Retry"
            }
        }
    }

    func loadCatalog() async {
        guard let state, state.phase == .ready, let client = state.client else { return }
        let scope = state.ownerScope
        activateScope(scope)
        catalogOperationID = UUID()
        let operation = catalogOperationID
        catalogLoading = true; catalogErrorMessage = nil
        do {
            let catalog = try await client.notificationCatalog()
            guard operation == catalogOperationID, activeScope == scope, state.ownerScope == scope, state.phase == .ready else { return }
            spaces = catalog.spaces
            catalogScope = scope
            catalogLoading = false
            if !unavailableIDs(in: selection).isEmpty { statusText = "Review unavailable Spaces" }
            if !selection.spaceIds.isEmpty { reconcile() }
        } catch {
            guard operation == catalogOperationID, activeScope == scope, state.ownerScope == scope, state.phase == .ready else { return }
            catalogLoading = false; catalogErrorMessage = error.localizedDescription
        }
    }

    func loadServerStatus() async {
        await reconciliation?.value
        guard let state, state.phase == .ready, let client = state.client else { return }
        activateScope(state.ownerScope)
        let scope = state.ownerScope, operation = operationID
        await refreshPermission()
        guard isCurrent(operation, scope) else { return }
        do {
            let result = try await client.pushStatus(installationId: installationID)
            guard isCurrent(operation, scope) else { return }
            if !selection.isEnabled { statusText = result.devices.isEmpty ? "Off" : "Turning off…" }
            else if !unavailableIDs(in: selection).isEmpty { statusText = "Review unavailable Spaces" }
            else if authorization != .authorized && authorization != .provisional {
                statusText = authorization == .denied ? "Saved · denied in System Settings" : "Saved · permission not requested"
            } else if let device = result.devices.first(where: { $0.installationId == installationID }) {
                statusText = device.notificationSelection.normalized() == selection.normalized() && result.deliveryEnabled
                    ? "Active · \(selectionLabel(selection))"
                    : "Saved · waiting to sync"
            } else { statusText = result.disabledReason ?? "Not registered — tap Retry" }
        } catch { guard isCurrent(operation, scope) else { return }; errorMessage = error.localizedDescription }
    }

    func unregister() async {
        let previous = reconciliation
        operationID = UUID()
        guard let state, let client = state.client else { return }
        let operation = operationID, scope = state.ownerScope
        let task = Task { [weak self] in
            await previous?.value
            guard let self, isCurrent(operation, scope) else { return }
            await removeRegistration(client: client, operation: operation, scope: scope)
        }
        reconciliation = task
        await task.value
    }

    private func updateSelection(_ value: NotificationSelection) {
        guard let state, state.phase == .ready else { return }
        activateScope(state.ownerScope)
        let normalized = value.normalized()
        guard normalized != selection else { return }
        selection = normalized
        preferenceStore.save(normalized, scope: state.ownerScope)
        statusText = normalized.isEnabled ? "Saved on this device" : "Turning off…"
        errorMessage = nil
        reconcile()
    }

    private func activateScope(_ scope: String) {
        guard activeScope != scope else { return }
        operationID = UUID(); catalogOperationID = UUID()
        activeScope = scope; catalogScope = nil
        selection = preferenceStore.load(scope: scope)
        spaces = []; catalogLoading = false; catalogErrorMessage = nil
        statusText = "Not configured"; errorMessage = nil
    }

    private func unavailableIDs(in value: NotificationSelection) -> [String] {
        guard catalogScope == activeScope else { return [] }
        let available = Set(spaces.map(\.id))
        return value.spaceIds.filter { !available.contains($0) }
    }

    private func selectionLabel(_ value: NotificationSelection) -> String {
        switch (value.inbox, value.spaceIds.count) {
        case (true, 0): return "Inbox"
        case (true, 1): return "Inbox + 1 Space"
        case (true, let count): return "Inbox + \(count) Spaces"
        case (false, 1): return "1 Space"
        case (false, let count): return "\(count) Spaces"
        }
    }

    private func removeRegistration(client: APIClient, operation: UUID, scope: String) async {
        do {
            try await client.unregisterDevice(installationId: installationID)
            guard isCurrent(operation, scope) else { return }; statusText = "Off"; errorMessage = nil
        } catch let APIClient.ClientError.http(code, _) where code == 404 {
            guard isCurrent(operation, scope) else { return }; statusText = "Off"; errorMessage = nil
        } catch {
            guard isCurrent(operation, scope) else { return }; errorMessage = error.localizedDescription; statusText = "Could not turn off — tap Retry"
        }
    }
    private func isCurrent(_ operation: UUID, _ scope: String) -> Bool {
        !Task.isCancelled && operation == operationID && scope == activeScope && scope == state?.ownerScope && state?.phase == .ready
    }
    func identityWillChange() {
        operationID = UUID(); catalogOperationID = UUID(); pendingNotification = nil
        activeScope = nil; catalogScope = nil; spaces = []
        selection = .inboxOnly; catalogLoading = false; catalogErrorMessage = nil
        statusText = "Not configured"; errorMessage = nil
    }
    func openPendingNotification() {
        guard state?.phase == .ready, let pendingNotification else { return }
        self.pendingNotification = nil; state?.routeNotification(pendingNotification)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run {
            if let state, state.phase == .ready { activateScope(state.ownerScope) }
            guard selection.isEnabled, state?.phase == .ready,
                  let account = notification.request.content.userInfo["accountId"] as? String,
                  state?.accounts.contains(where: { $0.id == account }) == true else { return [] }
            return [.banner, .list, .sound]
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run {
            pendingNotification = response.notification.request.content.userInfo
            openPendingNotification()
        }
    }
}
