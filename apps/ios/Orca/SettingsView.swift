import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
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

                    SettingsGroup(title: "Mailbox views", scope: "This device") {
                        NavigationLink {
                            MailboxVisibilitySettings()
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Visible views").font(OrcaTheme.ui(13, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                                    Text("Choose what appears in your mailbox menu.").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").foregroundStyle(OrcaTheme.muted)
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityIdentifier("settings.visible-views")
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
                                        SettingsChoiceToggle(
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
                                        SettingsChoiceToggle(
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
                                    SettingsChoiceToggle(
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
                                    SettingsChoiceToggle(
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
#if DEBUG
                        SettingsRule()
                        Button("Change server") { Task { await notifications.unregister(); if await state.logout() { notifications.identityWillChange(); state.phase = .configuring } } }
                            .font(OrcaTheme.ui(13, weight: .semibold))
                            .foregroundStyle(OrcaTheme.accent)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
#endif
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

private struct SettingsChoiceToggle: View {
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var title: String
    var scope: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))) {
                Text(title)
                    .font(OrcaTheme.reader(dynamicTypeSize.isAccessibilitySize ? 16 : 22))
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(OrcaTheme.ink)
                if !dynamicTypeSize.isAccessibilitySize { Spacer() }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var label: String
    var value: String
    var body: some View {
        (dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 16))) {
            Text(label)
                .font(OrcaTheme.ui(12, weight: .semibold))
                .foregroundStyle(OrcaTheme.ink)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 16) }
            Text(value)
                .font(OrcaTheme.ui(12))
                .foregroundStyle(OrcaTheme.muted)
                .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct SettingsRule: View {
    var body: some View { Divider().overlay(OrcaTheme.border) }
}

private struct MailboxVisibilitySettings: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Show the views you want to browse. These choices don’t change your notifications.")
                    .font(OrcaTheme.ui(13)).foregroundStyle(OrcaTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsGroup(title: "Mailboxes", scope: "This device") {
                    SettingsValue(label: "Inbox", value: "Always shown")
                    SettingsRule()
                    choice(id: "focus", name: "Focus", detail: "Mail that needs your attention")
                    choice(id: "all", name: "All Mail", detail: "Browse all your mail")
                }
                SettingsGroup(title: "Saved views", scope: "From your workspace") {
                    if mailboxes.loading {
                        HStack(spacing: 8) { ProgressView(); Text("Loading saved views…").font(OrcaTheme.ui(12)) }
                    }
                    if let error = mailboxes.error {
                        Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                        Button("Retry loading views") { Task { await mailboxes.load(state: state) } }
                            .frame(minHeight: 44).accessibilityIdentifier("settings.views.retry")
                    }
                    ForEach(mailboxes.views) { view in
                        choice(id: view.selectionID, name: view.name, detail: view.description.isEmpty ? "Show in the mailbox menu" : view.description)
                    }
                    if !mailboxes.loading && mailboxes.error == nil && mailboxes.views.isEmpty {
                        Text("No saved views yet. Create a view in Orca on desktop, then refresh here.")
                            .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                    }
                    ForEach(mailboxes.unavailableIDs, id: \.self) { id in
                        choice(id: id, name: "Unavailable saved view", detail: "Your choice is saved. Turn off to remove it.")
                    }
                }
            }.padding(20)
        }
        .background(OrcaTheme.paper)
        .navigationTitle("Visible views").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await mailboxes.load(state: state) } } label: { Image(systemName: "arrow.clockwise").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityLabel("Refresh saved views").disabled(mailboxes.loading)
            }
        }
        .task { await mailboxes.load(state: state) }
    }
    private func choice(id: String, name: String, detail: String) -> some View {
        SettingsChoiceToggle(name: name, detail: detail, isOn: Binding(get: { mailboxes.enabledIDs.contains(id) }, set: { mailboxes.setEnabled(id, $0) }))
            .accessibilityIdentifier("settings.views.\(id)")
    }
}
