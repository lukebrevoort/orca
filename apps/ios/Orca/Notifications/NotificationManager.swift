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
    @Published private(set) var importantInstallation: ImportantNotificationInstallation?
    @Published private(set) var importantLoading = false
    @Published private(set) var importantSaving = false
    @Published private(set) var importantUncertain = false
    @Published private(set) var importantError: String?
    @Published private(set) var importantStatus: String?
    private var importantGeneration = UUID()
    private var importantPending: ImportantNotificationCommand?
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
    func requestPermission(reconcileAfter: Bool = true) async {
        do {
            _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            await refreshPermission()
            if reconcileAfter { reconcile() }
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
            await loadImportantStatus()
            guard isCurrent(operation, scope) else { return }
            if let policy = importantInstallation?.policy {
                guard policy.enabled else { statusText = "Important notifications are off"; return }
                await registerImportantTransport(client: client, operation: operation, scope: scope)
                return
            }
            if importantWasAdopted { statusText = "Important choices could not be verified. Retry when connected."; return }
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

    var importantPermission: String { Self.permission(for: authorization) }
    nonisolated static func permission(for authorization: UNAuthorizationStatus) -> String {
        switch authorization {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        case .notDetermined: "default"
        @unknown default: "unavailable"
        }
    }
    var importantWasAdopted: Bool { importantInstallation?.policy != nil || UserDefaults.standard.bool(forKey: "important-notifications.adopted|\(activeScope ?? "")|\(installationID)") }
    private func retainAdoption(_ value: ImportantNotificationInstallation) {
        if value.policy != nil { UserDefaults.standard.set(true, forKey: "important-notifications.adopted|\(activeScope ?? "")|\(installationID)") }
    }
    private var importantPendingKey: String { "important-notifications.pending|\(activeScope ?? "")|\(installationID)" }
    private func retainImportantCommand(_ command: ImportantNotificationCommand?) {
        importantPending = command; importantUncertain = command != nil
        if let command, let data = try? JSONEncoder().encode(command) { UserDefaults.standard.set(data, forKey: importantPendingKey) }
        else { UserDefaults.standard.removeObject(forKey: importantPendingKey) }
    }
    func loadImportantStatus() async {
        guard let state, state.phase == .ready, let client = state.client else { return }
        activateScope(state.ownerScope)
        guard !importantLoading, !importantSaving else { return }
        let owner = state.ownerScope, generation = importantGeneration
        importantLoading = true
        defer { if generation == importantGeneration { importantLoading = false } }
        do {
            let value = try await client.importantNotificationStatus(installationId: installationID)
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration, state.phase == .ready else { return }
            importantInstallation = value; retainAdoption(value); importantError = nil
        } catch {
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
            importantError = "Important notification settings could not be loaded. Previous choices are unchanged."
            // Do not erase an adopted policy on a failed refresh or downgrade into legacy registration.
        }
    }
    func saveImportantNotifications(enabled: Bool, accountIds: [String]) async {
        guard let state, let client = state.client, state.phase == .ready, !importantSaving, !importantUncertain,
              let current = importantInstallation, !enabled || !accountIds.isEmpty,
              Set(accountIds).isSubset(of: Set(state.accounts.map(\.id))) else { return }
        await refreshPermission()
        let command = ImportantNotificationCommand(enabled: enabled, accountIds: accountIds.sorted(), permission: importantPermission, expectedRevision: current.revision)
        retainImportantCommand(command); importantSaving = true; importantError = nil; importantStatus = nil
        let owner = state.ownerScope, generation = importantGeneration
        do {
            let result = try await client.setImportantNotifications(installationId: installationID, command: command)
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
            acceptImportant(result, command: command)
        } catch {
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
            importantSaving = false; await reconcileImportantNotifications(); return
        }
        if generation == importantGeneration { importantSaving = false; reconcile() }
    }
    private func acceptImportant(_ result: ImportantNotificationOperation, command: ImportantNotificationCommand) {
        guard result.operationId == command.operationId, result.current.installationId == installationID,
              result.current.channel == "apns", result.current.cooldownSeconds == 900,
              ["current", "superseded"].contains(result.status), result.current.revision >= result.appliedRevision else {
            importantError = "Acknowledgement did not match this device. Check the save outcome."; return
        }
        importantInstallation = result.current; retainAdoption(result.current)
        importantStatus = result.status == "superseded" ? "Choices changed elsewhere. Current device settings are shown." : "Notification choices saved. Delivery status is separate."
        retainImportantCommand(nil)
    }
    func reconcileImportantNotifications(retryIfAbsent: Bool = false, reviewIfAbsent: Bool = false) async {
        guard let state, let client = state.client, let command = importantPending, !importantSaving else { return }
        importantSaving = true; let owner = state.ownerScope, generation = importantGeneration
        defer { if generation == importantGeneration { importantSaving = false; if !importantUncertain { reconcile() } } }
        do {
            let result = try await client.importantNotificationOperation(command.operationId)
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
            acceptImportant(result, command: command)
        } catch APIClient.ClientError.http(404, _) {
            guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
            if reviewIfAbsent {
                do {
                    let value = try await client.importantNotificationStatus(installationId: installationID)
                    guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
                    importantInstallation = value; retainAdoption(value); retainImportantCommand(nil)
                    importantError = nil; importantStatus = "Original operation was not recorded. Current device choices are shown."
                } catch { if owner == state.ownerScope, generation == importantGeneration { importantError = "Current settings could not be verified. Your original operation is retained." } }
            } else if retryIfAbsent {
                do {
                    let result = try await client.setImportantNotifications(installationId: installationID, command: command)
                    guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration else { return }
                    acceptImportant(result, command: command)
                } catch { importantError = "Original choices were not confirmed. Review current settings before trying another change." }
            } else { importantError = "This operation is not recorded. You may retry the same guarded choice." }
        } catch { if state.phase == .ready, owner == state.ownerScope, generation == importantGeneration { importantError = "Save outcome unknown. Reconnect and check again before changing choices." } }
    }
    private func registerImportantTransport(client: APIClient, operation: UUID, scope: String) async {
        await refreshPermission()
        guard isCurrent(operation, scope) else { return }
        if let current = importantInstallation, let policy = current.policy, current.permission != importantPermission, !importantUncertain {
            await saveImportantNotifications(enabled: policy.enabled, accountIds: policy.accountIds)
            return
        }
        guard importantPermission == "granted" else { statusText = "Important policy saved · iOS permission is \(importantPermission)"; return }
        guard let deviceToken else { UIApplication.shared.registerForRemoteNotifications(); statusText = "Registering with Apple…"; return }
#if DEBUG
        let environment = "sandbox"
#else
        let environment = "production"
#endif
        do {
            _ = try await client.registerDevice(installationId: installationID, token: deviceToken, environment: environment, selection: selection)
            guard isCurrent(operation, scope) else { return }
            await loadImportantStatus()
            guard isCurrent(operation, scope) else { return }
            statusText = importantInstallation?.delivery.available == true ? "Important policy · registration available; iOS controls delivery" : "Important policy saved · delivery unavailable"
        } catch { if isCurrent(operation, scope) { errorMessage = error.localizedDescription; statusText = "Important policy saved · registration failed" } }
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
            if importantWasAdopted {
                statusText = importantInstallation?.delivery.available == true ? "Important policy · registration available; iOS controls delivery" : "Important policy saved · delivery unavailable"
            }
            else if !selection.isEnabled { statusText = result.devices.isEmpty ? "Off" : "Turning off…" }
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
        operationID = UUID(); catalogOperationID = UUID(); importantGeneration = UUID()
        importantInstallation = nil; importantError = nil; importantStatus = nil; importantLoading = false; importantSaving = false
        importantPending = UserDefaults.standard.data(forKey: "important-notifications.pending|\(scope)|\(installationID)").flatMap { try? JSONDecoder().decode(ImportantNotificationCommand.self, from: $0) }
        importantUncertain = importantPending != nil
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
        importantGeneration = UUID(); importantInstallation = nil; importantPending = nil; importantUncertain = false
        importantLoading = false; importantSaving = false; importantError = nil; importantStatus = nil
        selection = .inboxOnly; catalogLoading = false; catalogErrorMessage = nil
        statusText = "Not configured"; errorMessage = nil
    }
    func openPendingNotification() {
        guard state?.phase == .ready, let pendingNotification else { return }
        self.pendingNotification = nil; state?.routeNotification(pendingNotification)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await presentationForNotification(notification.request.content.userInfo)
    }
    private func presentationForNotification(_ info: [AnyHashable: Any]) async -> UNNotificationPresentationOptions {
        guard let state, state.phase == .ready, let client = state.client,
              let account = info["accountId"] as? String, let thread = info["threadId"] as? String,
              state.accounts.contains(where: { $0.id == account }) else { return [] }
        activateScope(state.ownerScope)
        let owner = state.ownerScope, generation = importantGeneration
        if importantInstallation?.policy != nil {
            do {
                let current = try await client.importantNotificationStatus(installationId: installationID)
                guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration, current.policy?.enabled == true,
                      current.policy?.accountIds.contains(account) == true, current.permission == "granted", current.delivery.available else { return [] }
                let importance = try await client.importance(accountId: account, threadId: thread)
                guard state.phase == .ready, owner == state.ownerScope, generation == importantGeneration, importance.effective == .important else { return [] }
                return [.banner, .list, .sound] // Ordinary interruption; iOS Focus remains authoritative.
            } catch { return [] }
        }
        guard !importantWasAdopted else { return [] }
        return selection.isEnabled ? [.banner, .list, .sound] : []
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run {
            pendingNotification = response.notification.request.content.userInfo
            openPendingNotification()
        }
    }
}
