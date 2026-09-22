import UIKit
import UserNotifications

@MainActor final class NotificationManager: NSObject, ObservableObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @Published var mode: String { didSet { UserDefaults.standard.set(mode, forKey: "notificationMode") } }
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var statusText = "Not configured"
    @Published private(set) var errorMessage: String?
    weak var state: AppState?
    private var deviceToken: String?
    private var reconciliation: Task<Void, Never>?
    private var operationID = UUID()
    private var pendingNotification: [AnyHashable: Any]?
    let installationID: String

    override init() {
        let savedMode = UserDefaults.standard.string(forKey: "notificationMode") ?? "human"
        mode = ["human", "all", "off"].contains(savedMode) ? savedMode : "human"
        if let saved = UserDefaults.standard.string(forKey: "installationID") { installationID = saved }
        else { let id = UUID().uuidString; installationID = id; UserDefaults.standard.set(id, forKey: "installationID") }
        super.init()
        UNUserNotificationCenter.current().delegate = self
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
        let previous = reconciliation
        operationID = UUID()
        guard let state, state.phase == .ready, let client = state.client else { return }
        let operation = operationID, scope = state.ownerScope, desiredMode = mode
        reconciliation = Task { [weak self] in
            await previous?.value
            guard let self, isCurrent(operation, scope) else { return }
            await refreshPermission()
            guard isCurrent(operation, scope) else { return }
            if desiredMode == "off" {
                await removeRegistration(client: client, operation: operation, scope: scope)
                return
            }
            guard authorization == .authorized || authorization == .provisional else {
                statusText = authorization == .denied ? "Denied in System Settings" : "Permission not requested"
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
                let result = try await client.registerDevice(installationId: installationID, token: token, environment: environment, mode: desiredMode)
                guard isCurrent(operation, scope) else { return }
                statusText = result.push.configured ? "Active · \(desiredMode.capitalized) mail" : (result.push.disabledReason ?? "Saved; delivery is unavailable")
                errorMessage = nil
            } catch {
                guard isCurrent(operation, scope) else { return }
                errorMessage = error.localizedDescription; statusText = "Could not register — tap Retry"
            }
        }
    }
    func loadServerStatus() async {
        await reconciliation?.value
        guard let state, let client = state.client else { return }
        let scope = state.ownerScope, operation = operationID
        await refreshPermission()
        guard isCurrent(operation, scope) else { return }
        do {
            let result = try await client.pushStatus(installationId: installationID)
            guard isCurrent(operation, scope) else { return }
            if mode == "off" { statusText = result.devices.isEmpty ? "Off" : "Turning off…" }
            else if authorization != .authorized && authorization != .provisional {
                statusText = authorization == .denied ? "Denied in System Settings" : "Permission not requested"
            } else { statusText = result.deliveryEnabled ? "Active · \(mode.capitalized) mail" : (result.disabledReason ?? "Not registered — tap Retry") }
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
        !Task.isCancelled && operation == operationID && scope == state?.ownerScope && state?.phase == .ready
    }
    func identityWillChange() {
        operationID = UUID(); pendingNotification = nil
        statusText = "Not configured"; errorMessage = nil
    }
    func openPendingNotification() {
        guard state?.phase == .ready, let pendingNotification else { return }
        self.pendingNotification = nil; state?.routeNotification(pendingNotification)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await MainActor.run {
            pendingNotification = response.notification.request.content.userInfo
            openPendingNotification()
        }
    }
}
