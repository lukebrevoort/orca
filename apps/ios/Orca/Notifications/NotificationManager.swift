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
    private var identityGeneration = UUID()
    let installationID: String

    override init() {
        mode = UserDefaults.standard.string(forKey: "notificationMode") ?? "human"
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
            if authorization == .authorized || authorization == .provisional { UIApplication.shared.registerForRemoteNotifications() }
            else { statusText = "Notifications are denied in System Settings" }
        } catch { errorMessage = error.localizedDescription; statusText = "Permission request failed" }
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) { deviceToken = token.map { String(format: "%02x", $0) }.joined(); reconcile() }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { errorMessage = error.localizedDescription; statusText = "Registration failed — try again" }
    func reconcile() {
        reconciliation?.cancel()
        let generation = identityGeneration, expectedScope = state?.ownerScope
        reconciliation = Task { [weak self] in
            guard let self, let state, state.phase == .ready, expectedScope == state.ownerScope, generation == identityGeneration else { return }
            await refreshPermission()
            if mode == "off" { await unregister(); return }
            guard authorization == .authorized || authorization == .provisional else { statusText = authorization == .denied ? "Denied in System Settings" : "Permission not requested"; return }
            guard let token = deviceToken else { UIApplication.shared.registerForRemoteNotifications(); statusText = "Registering with Apple…"; return }
            guard let client = state.client else { return }
            do {
#if DEBUG
                let environment = "sandbox"
#else
                let environment = "production"
#endif
                let result = try await client.registerDevice(installationId: installationID, token: token, environment: environment, mode: mode)
                guard expectedScope == state.ownerScope, generation == identityGeneration else { return }
                statusText = result.push.configured ? "Active · \(mode.capitalized) mail" : (result.push.disabledReason ?? "Saved; delivery is unavailable")
                errorMessage = nil
            } catch { guard expectedScope == state.ownerScope else { return }; errorMessage = error.localizedDescription; statusText = "Could not register — tap Retry" }
        }
    }
    func loadServerStatus() async {
        guard let client = state?.client else { return }
        do { let status = try await client.pushStatus(installationId: installationID); if let device = status.devices.first { mode = device.notificationMode }; statusText = status.deliveryEnabled ? "Active · \(mode.capitalized) mail" : (status.disabledReason ?? "Delivery is unavailable") }
        catch { errorMessage = error.localizedDescription }
    }
    func unregister() async {
        reconciliation?.cancel(); guard let client = state?.client else { return }
        do { try await client.unregisterDevice(installationId: installationID); statusText = "Off" }
        catch let APIClient.ClientError.http(code, _) where code == 404 { statusText = "Off" }
        catch { errorMessage = error.localizedDescription; statusText = "Could not turn off — tap Retry" }
    }
    func identityWillChange() { reconciliation?.cancel(); identityGeneration = UUID(); deviceToken = nil }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async { await MainActor.run { state?.routeNotification(response.notification.request.content.userInfo) } }
}
