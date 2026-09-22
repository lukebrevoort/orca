import UIKit
import UserNotifications

@MainActor final class NotificationManager: NSObject, ObservableObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var state: AppState?
    func requestPermission() async { let center = UNUserNotificationCenter.current(); center.delegate = self; if (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true { UIApplication.shared.registerForRemoteNotifications() } }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { Task { await register(deviceToken.map { String(format: "%02x", $0) }.joined()) } }
    func register(_ token: String) async {
        guard let state, let client = state.client else { return }; let installation = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        struct Device: Encodable { var token: String; var environment: String; var notificationMode: String }
#if DEBUG
        let environment = "sandbox"
#else
        let environment = "production"
#endif
        let _: EmptyResponse? = try? await client.request("v1/mobile/devices/\(installation)", method: "PUT", body: Device(token: token, environment: environment, notificationMode: "human"))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async { await MainActor.run { state?.routeNotification(response.notification.request.content.userInfo) } }
}
