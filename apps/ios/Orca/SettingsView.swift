import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject private var notifications: NotificationManager
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    SettingsGroup(title: "Account", scope: "Mailbox") {
                        if state.accounts.count > 1 {
                            Picker("Mailbox", selection: $state.selectedAccountID) { ForEach(state.accounts) { Text($0.displayName + " · " + $0.email).tag(Optional($0.id)) } }
                                .tint(OrcaTheme.accent)
                        } else if let account = state.selectedAccount {
                            SettingsValue(label: "Mailbox", value: account.email)
                            SettingsRule()
                            SettingsValue(label: "Provider", value: account.provider.capitalized)
                        }
                    }

                    SettingsGroup(title: "Notifications", scope: "This device") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Notify me about")
                                .font(OrcaTheme.ui(12, weight: .semibold))
                                .foregroundStyle(OrcaTheme.ink)
                            Picker("Notify me about", selection: $notifications.mode) { Text("Human mail").tag("human"); Text("All mail").tag("all"); Text("Off").tag("off") }
                                .pickerStyle(.segmented)
                                .accessibilityIdentifier("settings.notificationMode")
                                .onChange(of: notifications.mode) { notifications.reconcile() }
                        }
                        SettingsRule()
                        SettingsValue(label: "Status", value: notifications.statusText)
                            .accessibilityIdentifier("settings.notificationStatus")
                        if notifications.authorization == .notDetermined {
                            SettingsRule()
                            Button("Allow notifications") { Task { await notifications.requestPermission() } }
                                .font(OrcaTheme.ui(13, weight: .semibold))
                                .foregroundStyle(OrcaTheme.accent)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                                .accessibilityIdentifier("settings.allow-notifications")
                        } else if notifications.authorization == .denied {
                            SettingsRule()
                            Link("Open System Settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                                .font(OrcaTheme.ui(13, weight: .semibold))
                                .foregroundStyle(OrcaTheme.accent)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        if notifications.errorMessage != nil {
                            SettingsRule()
                            Button("Retry") { notifications.reconcile() }
                                .font(OrcaTheme.ui(13, weight: .semibold))
                                .foregroundStyle(OrcaTheme.accent)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                                .accessibilityHint(notifications.errorMessage ?? "")
                        }
                    }

                    SettingsGroup(title: "Connection", scope: "Account") {
                        SettingsValue(label: "Server", value: state.baseURLText)
                        SettingsRule()
                        Button("Change server") { Task { await notifications.unregister(); if await state.logout() { notifications.identityWillChange(); state.phase = .configuring } } }
                            .font(OrcaTheme.ui(13, weight: .semibold))
                            .foregroundStyle(OrcaTheme.accent)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        SettingsRule()
                        Button("Sign out", role: .destructive) { Task { await notifications.unregister(); if await state.logout() { notifications.identityWillChange() } } }
                            .font(OrcaTheme.ui(13, weight: .semibold))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                            .foregroundStyle(OrcaTheme.danger)
                            .accessibilityIdentifier("settings.sign-out")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Label("Privacy on this device", systemImage: "lock.shield")
                            .font(OrcaTheme.ui(11, weight: .semibold))
                            .foregroundStyle(OrcaTheme.ink)
                        Text("Orca keeps access tokens in the iOS Keychain and local drafts protected on this device.")
                            .font(OrcaTheme.ui(11))
                            .foregroundStyle(OrcaTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.bottom, 22)
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
            }
            .background(OrcaTheme.paper.ignoresSafeArea())
            .accessibilityIdentifier("settings.root")
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .task { await notifications.refreshPermission(); await notifications.loadServerStatus() }
        }
    }
}

private struct SettingsGroup<Content: View>: View {
    var title: String
    var scope: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(OrcaTheme.reader(22))
                    .foregroundStyle(OrcaTheme.ink)
                Spacer()
                Text(scope)
                    .font(OrcaTheme.ui(9, weight: .bold))
                    .foregroundStyle(OrcaTheme.muted)
                    .textCase(.uppercase)
                    .tracking(0.7)
            }
            VStack(alignment: .leading, spacing: 14) { content }
                .padding(.vertical, 14)
                .overlay(alignment: .top) { SettingsRule() }
                .overlay(alignment: .bottom) { SettingsRule() }
        }
    }
}

private struct SettingsValue: View {
    var label: String
    var value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(label)
                .font(OrcaTheme.ui(12, weight: .semibold))
                .foregroundStyle(OrcaTheme.ink)
            Spacer(minLength: 16)
            Text(value)
                .font(OrcaTheme.ui(12))
                .foregroundStyle(OrcaTheme.muted)
                .multilineTextAlignment(.trailing)
        }
    }
}

private struct SettingsRule: View {
    var body: some View { Divider().overlay(OrcaTheme.border) }
}
