import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState; @EnvironmentObject private var notifications: NotificationManager
    var body: some View { NavigationStack { Form { Section("Account") { if state.accounts.count > 1 { Picker("Mailbox", selection: $state.selectedAccountID) { ForEach(state.accounts) { Text($0.displayName + " · " + $0.email).tag(Optional($0.id)) } } } else if let account = state.selectedAccount { LabeledContent("Mailbox", value: account.email); LabeledContent("Provider", value: account.provider.capitalized) } }; Section("Notifications") { Button("Enable notifications") { Task { await notifications.requestPermission() } }; Text("Notification taps open the matching conversation. Human-focused alerts are the default.").font(.caption).foregroundStyle(.secondary) }; Section("Connection") { LabeledContent("Server", value: state.baseURLText); Button("Sign out", role: .destructive) { Task { await state.logout() } }; Button("Change server") { Task { await state.logout(); state.phase = .configuring } } }; Section { Text("Orca keeps access tokens in the iOS Keychain and local drafts protected on this device.").font(.caption).foregroundStyle(.secondary) } }.navigationTitle("Settings") } }
}

