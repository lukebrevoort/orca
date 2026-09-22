import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject private var notifications: NotificationManager
    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if state.accounts.count > 1 { Picker("Mailbox", selection: $state.selectedAccountID) { ForEach(state.accounts) { Text($0.displayName + " · " + $0.email).tag(Optional($0.id)) } } }
                    else if let account = state.selectedAccount { LabeledContent("Mailbox", value: account.email); LabeledContent("Provider", value: account.provider.capitalized) }
                }
                Section("Notifications") {
                    Picker("Notify me about", selection: $notifications.mode) { Text("Human mail").tag("human"); Text("All mail").tag("all"); Text("Off").tag("off") }
                        .accessibilityIdentifier("settings.notificationMode").onChange(of: notifications.mode) { notifications.reconcile() }
                    LabeledContent("Status", value: notifications.statusText).accessibilityIdentifier("settings.notificationStatus")
                    if notifications.authorization == .notDetermined { Button("Allow notifications") { Task { await notifications.requestPermission() } } }
                    else if notifications.authorization == .denied { Link("Open System Settings", destination: URL(string: UIApplication.openSettingsURLString)!) }
                    if notifications.errorMessage != nil { Button("Retry") { notifications.reconcile() }.accessibilityHint(notifications.errorMessage ?? "") }
                }
                Section("Connection") {
                    LabeledContent("Server", value: state.baseURLText)
                    Button("Sign out", role: .destructive) { Task { await notifications.unregister(); notifications.identityWillChange(); await state.logout() } }.accessibilityIdentifier("settings.sign-out")
                    Button("Change server") { Task { await notifications.unregister(); notifications.identityWillChange(); await state.logout(); state.phase = .configuring } }
                }
                Section { Text("Orca keeps access tokens in the iOS Keychain and local drafts protected on this device.").font(.caption).foregroundStyle(.secondary) }
            }.accessibilityIdentifier("settings.root")
            .navigationTitle("Settings")
            .task { await notifications.refreshPermission(); await notifications.loadServerStatus() }
        }
    }
}
