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
                        Toggle(isOn: Binding(get: { notifications.inboxEnabled }, set: { notifications.setInboxEnabled($0) })) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Inbox").font(OrcaTheme.ui(12, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                                Text("Notify for new messages delivered to Inbox.").font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
                            }
                        }
                        .tint(OrcaTheme.accent)
                        .accessibilityIdentifier("settings.notifications.inbox")
                        SettingsRule()
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Spaces")
                                .font(OrcaTheme.ui(12, weight: .semibold))
                                .foregroundStyle(OrcaTheme.ink)
                            Text("Choose any Spaces that should also notify you. Inbox and Spaces are independent.")
                                .font(OrcaTheme.ui(10))
                                .foregroundStyle(OrcaTheme.muted)
                                .fixedSize(horizontal: false, vertical: true)
                            if notifications.catalogLoading {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack(spacing: 8) { ProgressView(); Text("Loading Spaces…") }
                                        .font(OrcaTheme.ui(11))
                                        .foregroundStyle(OrcaTheme.muted)
                                        .accessibilityElement(children: .combine)
                                    ForEach(notifications.unavailableSelectedSpaceIDs, id: \.self) { id in
                                        NotificationSpaceToggle(
                                            name: "Saved Space",
                                            detail: "Available to turn off while Spaces load",
                                            isOn: Binding(get: { notifications.selectedSpaceIDs.contains(id) }, set: { notifications.setSpace(id, enabled: $0) })
                                        )
                                        .accessibilityIdentifier("settings.notifications.space.\(id)")
                                    }
                                }
                            } else if let catalogError = notifications.catalogErrorMessage {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Spaces could not be loaded. Your saved choices are unchanged.")
                                        .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                                    ForEach(notifications.unavailableSelectedSpaceIDs, id: \.self) { id in
                                        NotificationSpaceToggle(
                                            name: "Saved Space",
                                            detail: "Catalog unavailable · turn off to remove",
                                            isOn: Binding(get: { notifications.selectedSpaceIDs.contains(id) }, set: { notifications.setSpace(id, enabled: $0) })
                                        )
                                        .accessibilityIdentifier("settings.notifications.space.\(id)")
                                    }
                                    Button("Retry loading Spaces") { Task { await notifications.loadCatalog() } }
                                        .font(OrcaTheme.ui(12, weight: .semibold)).foregroundStyle(OrcaTheme.accent)
                                        .accessibilityHint(catalogError)
                                }
                            } else if notifications.spaces.isEmpty && notifications.unavailableSelectedSpaceIDs.isEmpty {
                                Text("No Spaces are available for notifications yet.")
                                    .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                            } else {
                                ForEach(notifications.spaces) { space in
                                    NotificationSpaceToggle(
                                        name: space.name,
                                        detail: space.kindLabel,
                                        isOn: Binding(
                                            get: { notifications.selectedSpaceIDs.contains(space.id) },
                                            set: { notifications.setSpace(space.id, enabled: $0) }
                                        )
                                    )
                                    .accessibilityIdentifier("settings.notifications.space.\(space.id)")
                                }
                                ForEach(notifications.unavailableSelectedSpaceIDs, id: \.self) { id in
                                    NotificationSpaceToggle(
                                        name: "Unavailable Space",
                                        detail: "No longer available · turn off to remove",
                                        isOn: Binding(get: { notifications.selectedSpaceIDs.contains(id) }, set: { notifications.setSpace(id, enabled: $0) })
                                    )
                                    .accessibilityIdentifier("settings.notifications.space.\(id)")
                                }
                            }
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
            .task { await notifications.refreshPermission(); await notifications.loadCatalog(); await notifications.loadServerStatus() }
        }
    }
}

private struct NotificationSpaceToggle: View {
    var name: String
    var detail: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(OrcaTheme.ui(12, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                Text(detail).font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
            }
        }
        .tint(OrcaTheme.accent)
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
