import SwiftUI

enum NativeSettingsSection: String, CaseIterable, Identifiable {
    case account = "Account", reading = "Appearance & reading", inbox = "Inbox & attention", writing = "Writing"
    case notifications = "Notifications", connected = "Connected accounts", agents = "Agent connections", privacy = "Privacy & data"
    var id: String { rawValue }
}
struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @EnvironmentObject private var notifications: NotificationManager
    @EnvironmentObject private var preferences: AccountPreferencesController
    @AppStorage("orca.appearance") private var appearance = "system"
    @State private var section: NativeSettingsSection = .account
    @State private var pendingAccount: String?
    @State private var confirmingAccount = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Picker("Settings section", selection: $section) {
                        ForEach(NativeSettingsSection.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.menu).accessibilityIdentifier("settings.section")

                    sectionContent
                    if let error = preferences.error { Text(error).foregroundStyle(OrcaTheme.danger) }
                    if preferences.uncertain { Button("Check current account choices") { Task { await preferences.checkCurrent(state: state) } } }
                }.padding(20)
            }
            .safeAreaInset(edge: .bottom) {
                if preferences.dirty || preferences.saving || preferences.status != nil {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(preferences.status ?? (preferences.saving ? "Saving account choices…" : "Unsaved account choices — save or discard before opening another workspace")).font(.subheadline)
                        HStack {
                            Button("Save account choices") { Task { await preferences.save(state: state) } }.disabled(!preferences.dirty || preferences.loading || preferences.saving || preferences.uncertain)
                                .accessibilityIdentifier("settings.save")
                            Button("Discard edits") { preferences.discard() }.disabled(preferences.saving).accessibilityIdentifier("settings.discard")
                        }
                    }.padding().frame(maxWidth: .infinity, alignment: .leading).background(OrcaTheme.surface)
                }
            }
            .background(OrcaTheme.paper).navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NavigationLink(destination: MailSearchView()) { Image(systemName: "magnifyingglass").frame(width: 44, height: 44) }.accessibilityLabel("Search All Mail").disabled(preferences.dirty || preferences.saving)
                    NavigationLink(destination: ComposeView()) { Image(systemName: "square.and.pencil").frame(width: 44, height: 44) }.accessibilityLabel("Compose").disabled(preferences.dirty || preferences.saving)
                }
            }
            .task { await preferences.load(state: state) }
            .confirmationDialog("Leave unsaved account choices?", isPresented: $confirmingAccount, titleVisibility: .visible) {
                Button("Stay", role: .cancel) { pendingAccount = nil }
                Button("Discard edits and switch", role: .destructive) { if !preferences.saving { preferences.discard(); state.selectedAccountID = pendingAccount; pendingAccount = nil } }.disabled(preferences.saving)
            } message: { Text("Your choices are not saved. Stay to save or continue editing.") }
        }
    }
    @ViewBuilder private var sectionContent: some View {
        switch section {
        case .account: accountSection
        case .reading: readingSection
        case .inbox: inboxSection
        case .writing: writingSection
        case .connected: connectedSection
        case .agents: agentsSection
        case .privacy: privacySection
        case .notifications: VStack(alignment: .leading, spacing: 24) { ImportantNotificationSettings(); LegacyNotificationSettings() }
        }
    }
    @ViewBuilder private var accountSection: some View {
        SettingsGroup(title: "Account", scope: "Connected mailbox") {
            Picker("Mailbox", selection: Binding(get: { state.selectedAccountID }, set: { value in
                if preferences.dirty || preferences.saving { pendingAccount = value; confirmingAccount = true }
                else { state.selectedAccountID = value }
            })) { ForEach(state.accounts) { Text($0.displayName + " · " + $0.email).tag(Optional($0.id)) } }
            if let account = state.selectedAccount {
                SettingsValue(label: "Provider", value: account.provider.capitalized)
                SettingsValue(label: "Reading", value: account.capabilities.read ? "Available" : "Unavailable")
                SettingsValue(label: "Sending", value: account.capabilities.send ? "Granted" : "Not granted")
                SettingsValue(label: "Provider drafts", value: account.capabilities.draft ? "Granted" : "Not granted")
            }
            Text("Profile identity comes from your connected provider. Writing choices below belong to your Orca account across connected mailboxes.").font(.subheadline)
        }
        Button("Writing choices") { section = .writing }
        NavigationLink("Visible views") { MailboxVisibilitySettings() }.frame(minHeight: 44).accessibilityIdentifier("settings.visible-views")

    }
    @ViewBuilder private var readingSection: some View {
        SettingsGroup(title: "Appearance & reading", scope: "This device") {
            Picker("Appearance", selection: $appearance) {
                Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark")
            }
            Text("Reader and controls follow iOS Dynamic Type. Use Text Size in Control Center or Accessibility settings. Reduce Motion follows your system choice. Images remain blocked until you choose Load images for that message.").font(.subheadline)
            Link("Open iOS settings", destination: URL(string: UIApplication.openSettingsURLString)!)
        }

    }
    @ViewBuilder private var inboxSection: some View {
        SettingsGroup(title: "Inbox & attention", scope: "This device") {
            Text("Important is your conversation choice or inherited exact-sender preferences. Inbox and Focus describe mail placement and reading lenses separately. All Mail always remains available.").font(.subheadline)
            NavigationLink("Visible views") { MailboxVisibilitySettings() }.frame(minHeight: 44).accessibilityIdentifier("settings.visible-views")
            Text("Later reminders, Summary and advanced Organization are available in Orca on the web. Summary is not proof that a message needs a reply. Reading never means replied.").font(.subheadline)
        }

    }
    @ViewBuilder private var writingSection: some View {
        SettingsGroup(title: "Writing", scope: "Orca account · Save required") {
            if preferences.loading { ProgressView("Loading saved choices…") }
            if preferences.edits != nil {
                TextField("Signature", text: preference(\.signature, fallback: ""), axis: .vertical).accessibilityIdentifier("settings.signature")
                Picker("Reply default", selection: preference(\.replyBehavior, fallback: "reply")) {
                    Text("Reply").tag("reply"); Text("Reply all").tag("reply_all")
                }
                Picker("Web compose format", selection: preference(\.composeFormat, fallback: "plain")) {
                    Text("Plain").tag("plain"); Text("Rich").tag("rich")
                }
                Text("Native creates plain-text drafts. Existing rich drafts remain protected until you explicitly choose conversion. Signature and reply defaults apply only to new writing.").font(.caption)
                Toggle("Notify by default for manual reminders", isOn: preference(\.notifyByDefault, fallback: false))
                Text("Manual reminders are a web return-time feature. This preference does not enable Important notifications or establish delivery.").font(.caption)
            } else if !preferences.loading { Button("Load account choices") { Task { await preferences.load(state: state) } } }
        }

    }
    @ViewBuilder private var connectedSection: some View {
        SettingsGroup(title: "Connected accounts", scope: "Provider permission") {
            ForEach(state.accounts) { account in
                VStack(alignment: .leading, spacing: 8) {
                    Text(account.email).font(.headline).textSelection(.enabled)
                    Text(account.provider == "gmail" ? "Gmail sync is supported. Sending and provider drafts need their separate grant." : "Outlook connection exists; mail sync, draft transport and sending are unavailable.")
                    Text("Read: \(account.capabilities.read ? "granted" : "missing") · Send: \(account.capabilities.send ? "granted" : "missing")")
                }
            }
            Button("Refresh account access") { Task { do { try await state.refreshAccountCapabilities() } catch { state.errorMessage = error.localizedDescription } } }
            Text("Manage connections, Gmail labels and Calendar permissions in Orca on the web. Returning here does not imply consent or sync completed.").font(.subheadline)
        }

    }
    @ViewBuilder private var agentsSection: some View {
        SettingsGroup(title: "Agent connections", scope: "Orca account") {
            Text("Agent connection management is available in Orca on the web. This app does not list or revoke agent grants.").font(.subheadline)
        }

    }
    @ViewBuilder private var privacySection: some View {
        SettingsGroup(title: "Privacy & data", scope: "This device") {
            Text("Access tokens are stored in iOS Keychain. Local drafts use protected device storage. Remote images require explicit message consent. External links open only when activated.")
            SettingsValue(label: "Server", value: state.baseURLText)
            Text("Sign out revokes this device session. It does not claim to remove other devices or provider grants.").font(.subheadline)
            Button("Sign out", role: .destructive) { Task { await notifications.unregister(); if await state.logout() { notifications.identityWillChange() } } }.accessibilityIdentifier("settings.sign-out").disabled(preferences.dirty || preferences.saving)
#if DEBUG
            Button("Change server") { Task { await notifications.unregister(); if await state.logout() { notifications.identityWillChange(); state.phase = .configuring } } }.disabled(preferences.dirty || preferences.saving)
#endif
        }

    }
    private func preference<T>(_ key: WritableKeyPath<AccountPreferences, T>, fallback: T) -> Binding<T> {
        Binding(get: { preferences.edits?[keyPath: key] ?? fallback }, set: { preferences.edits?[keyPath: key] = $0 })
    }
}
private struct ImportantNotificationSettings: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var notifications: NotificationManager
    @State private var accounts = Set<String>()
    @State private var enabled = true
    @State private var reviewing = false
    @State private var confirming = false
    var body: some View {
        SettingsGroup(title: "Important notifications", scope: "This device · selected accounts") {
            Text("Only fresh unread incoming Important mail. Marking older mail Important does not replay a backlog. Additional messages in the same conversation/account/device are suppressed for 15 minutes, rather than batched.").font(.subheadline)
            Text("iOS permission, current registration and OS Focus control delivery. No Time Sensitive override or app quiet-hours scheduler. Manual reminders are separate.").font(.subheadline)
            if notifications.importantLoading { ProgressView("Checking current policy…") }
            if let current = notifications.importantInstallation {
                SettingsValue(label: "Policy", value: current.policy == nil ? "Previous choices · not adopted" : "Important only").accessibilityIdentifier("notifications.installation." + notifications.installationID)
                SettingsValue(label: "Permission", value: notifications.importantPermission)
                SettingsValue(label: "Delivery", value: current.delivery.available && notifications.importantPermission == "granted" ? "Registration available · iOS controls display" : "Unavailable · " + (current.delivery.reason ?? "unknown"))
                if reviewing {
                    Toggle("Enable Important notifications", isOn: $enabled).accessibilityIdentifier("notifications.enabled")
                    ForEach(state.accounts) { account in
                        Toggle(account.email, isOn: Binding(get: { accounts.contains(account.id) }, set: { value in if value { accounts.insert(account.id) } else { accounts.remove(account.id) } })).accessibilityIdentifier("notifications.account." + account.id)
                    }
                    if notifications.authorization == .notDetermined {
                        Button("Request iOS permission") { Task { await notifications.requestPermission(reconcileAfter: false) } }
                    } else if notifications.authorization == .denied {
                        Link("Open iOS settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                    }
                    Button(current.policy == nil ? "Review adoption" : "Review notification changes") { confirming = true }
                        .disabled((enabled && accounts.isEmpty) || notifications.importantSaving || notifications.importantUncertain)
                        .accessibilityIdentifier("notifications.review-important")
                    Button("Cancel changes") { reviewing = false }.disabled(notifications.importantSaving)
                } else {
                    Button(current.policy == nil ? "Choose Important-only notifications…" : "Edit Important notifications…") {
                        accounts = Set(current.policy?.accountIds ?? []); enabled = current.policy?.enabled ?? true; reviewing = true
                    }.disabled(notifications.importantUncertain).accessibilityIdentifier("notifications.edit-important")
                }
            } else if !notifications.importantLoading {
                Text("Important-only adoption is unavailable until the server returns current device settings. Previous choices remain unchanged.").font(.subheadline)
                Button("Check availability") { Task { await notifications.loadImportantStatus() } }
            }
            if notifications.importantSaving { ProgressView("Saving device choices…") }
            if notifications.importantUncertain {
                Text("Save outcome unknown. Check the original operation before changing choices.")
                Button("Check notification save") { Task { await notifications.reconcileImportantNotifications() } }
                Button("Retry original notification choice") { Task { await notifications.reconcileImportantNotifications(retryIfAbsent: true) } }
                Button("Review current notification choices") { Task { await notifications.reconcileImportantNotifications(reviewIfAbsent: true) } }
            }
            if let status = notifications.importantStatus { Text(status).accessibilityIdentifier("notifications.important-status") }
            if let error = notifications.importantError { Text(error).foregroundStyle(OrcaTheme.danger) }
        }
        .confirmationDialog("Confirm Important-only choices?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Cancel", role: .cancel) { }
            Button("Confirm device choices") { Task { await notifications.saveImportantNotifications(enabled: enabled, accountIds: Array(accounts)); if !notifications.importantUncertain { reviewing = false } } }
        } message: { Text("\(enabled ? "Enable" : "Disable") for \(accounts.count) selected accounts on this device. Adoption/re-enabling/adding accounts starts with future arrivals; previous Inbox/Space choices are retained. Permission and actual delivery remain separate.") }
        .task { await notifications.refreshPermission(); await notifications.loadImportantStatus() }
        .onChange(of: state.ownerScope) { reviewing = false; accounts = [] }
    }
}

private struct LegacyNotificationSettings: View {
    @EnvironmentObject private var notifications: NotificationManager
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Previous notification choices").font(.headline)
            Text("These existing choices use Inbox and Spaces. Important-only requires separate explicit adoption when supported; it is not enabled by an importance correction. Delivery also depends on iOS permission, registration and OS Focus.").font(.subheadline)
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

        }.disabled(notifications.importantWasAdopted)
        .task { await notifications.refreshPermission(); await notifications.loadCatalog(); await notifications.loadServerStatus() }
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
    @State private var removal: SavedMailboxView?
    @State private var confirmRemoval = false
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("Show the views you want to browse. These choices don’t change your notifications.")
                    .font(OrcaTheme.ui(13)).foregroundStyle(OrcaTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsGroup(title: "Mailboxes", scope: "This device") {
                    SettingsValue(label: "Important & All Mail", value: "Always available")
                    SettingsValue(label: "Inbox", value: "Placement; always in Mailboxes")
                    SettingsRule()
                    choice(id: "focus", name: "Inbox focus", detail: "Focus and Notify mail in Inbox; separate from importance")
                    Text("All Mail cannot be hidden. Your previous optional visibility choices are retained.").font(.caption)
                }
                ForEach(mailboxes.groups.filter { ["spaces", "collections", "pins"].contains($0.id) }) { group in
                    SettingsGroup(title: group.title, scope: "Browse · this device") {
                        let presentation = mailboxes.browser.settingsSection(group.id)
                        if presentation.loading {
                            HStack(spacing: 8) { ProgressView(); Text("Loading choices…").font(OrcaTheme.ui(12)) }
                        }
                        if let message = presentation.message {
                            Text(message).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
                            Button("Retry loading choices") { Task { await mailboxes.load(state: state) } }
                                .frame(minHeight: 44).accessibilityIdentifier("settings." + group.id + ".retry")
                        }
                        ForEach(group.options) { item in
                            SettingsChoiceToggle(name: item.name, detail: "Show in Mailboxes; does not change notifications", isOn: Binding(get: { !mailboxes.hiddenIDs.contains(item.id) }, set: { mailboxes.setHidden(item.id, !$0) }))
                                .accessibilityIdentifier("settings.mailbox." + item.id)
                        }
                        if group.options.isEmpty && presentation.canShowEmpty { Text("No visible choices. Hidden choices can be restored below.").font(.caption) }
                    }
                }
                if !mailboxes.hiddenOptions.isEmpty {
                    SettingsGroup(title: "Hidden", scope: "This device") {
                        ForEach(mailboxes.hiddenOptions) { item in
                            Button("Restore “\(item.name)”") { mailboxes.restore(item.id) }
                                .frame(minHeight: 44).accessibilityIdentifier("settings.restore." + item.id)
                        }
                    }
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
                        NavigationLink("Edit “\(view.name)”") { if let account = state.selectedAccount { NativeViewEditor(selection: .init(viewId: view.id, accountId: account.id)) } }
                        HStack {
                            Button("Move up") { Task { await mailboxes.reorder(view, offset: -1, state: state) } }.disabled(mailboxes.views.first?.id == view.id)
                            Button("Move down") { Task { await mailboxes.reorder(view, offset: 1, state: state) } }.disabled(mailboxes.views.last?.id == view.id)
                            Button("Remove view", role: .destructive) { removal = view; confirmRemoval = true }
                        }.font(.subheadline).disabled(mailboxes.changing || mailboxes.loading || mailboxes.workspaceRevision == nil)

                    }
                    if !mailboxes.loading && mailboxes.error == nil && mailboxes.views.isEmpty {
                        Text("No saved views yet. Use a sender’s context menu to preview and save a view, then refresh here.")
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
        .confirmationDialog("Remove this saved view?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Cancel", role: .cancel) { removal = nil }
            Button("Remove view", role: .destructive) { if let removal { Task { await mailboxes.remove(removal, state: state) } } }
        } message: { Text("Only the saved view is removed. Mail stays in All Mail and notification permission is unchanged.") }
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
