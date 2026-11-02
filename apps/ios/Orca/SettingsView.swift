import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @EnvironmentObject private var notifications: NotificationManager
    @StateObject private var feedback = FeedbackQueueModel()
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

                    SettingsGroup(title: "Help improve Orca", scope: "Your feedback") {
                        NavigationLink {
                            FeedbackSettingsView(model: feedback)
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Feedback").font(OrcaTheme.ui(13, weight: .semibold)).foregroundStyle(OrcaTheme.ink)
                                    Text("Share an idea or problem and see your queue.").font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "chevron.right").foregroundStyle(OrcaTheme.muted)
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.accessibilityIdentifier("settings.feedback")
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
            .onAppear { feedback.configure(scope: state.ownerScope) }
            .onChange(of: state.ownerScope) { _, scope in feedback.configure(scope: scope) }
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

@MainActor final class FeedbackQueueModel: ObservableObject {
    @Published var title = ""
    @Published var detail = ""
    @Published var kind = "idea"
    @Published private(set) var pending: FeedbackInput?
    @Published private(set) var items: [FeedbackQueueItem] = []
    @Published private(set) var deliveryAvailable = false
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var loadError: String?
    @Published private(set) var confirmation: String?
    private var scope = ""
    private var generation = UUID()
    var canSubmit: Bool {
        pending != nil || (!title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= 200 && detail.utf16.count <= 10_000)
    }
    func configure(scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope; generation = UUID()
        title = ""; detail = ""; kind = "idea"; pending = nil; items = []
        deliveryAvailable = false; loading = false; busy = false; error = nil; loadError = nil; confirmation = nil
    }
    func load(client: APIClient, scope: String) async {
        guard scope == self.scope, !loading, !busy else { return }
        let generation = generation
        loading = true; loadError = nil
        defer { if generation == self.generation { loading = false } }
        do {
            let response: FeedbackQueueResponse = try await client.request("v1/feedback/queue")
            guard generation == self.generation else { return }
            items = response.items; deliveryAvailable = response.deliveryAvailable
        } catch {
            guard generation == self.generation else { return }
            loadError = "Your queue could not be loaded. Try refreshing."
        }
    }
    func submit(client: APIClient, scope: String) async {
        guard scope == self.scope, !busy, !loading, canSubmit else { return }
        let generation = generation
        busy = true; error = nil; confirmation = nil
        if pending == nil {
            pending = FeedbackInput(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                                    description: detail.trimmingCharacters(in: .whitespacesAndNewlines), kind: kind)
        }
        defer { if generation == self.generation { busy = false } }
        do {
            let response: FeedbackSubmissionResponse = try await client.request("v1/feedback/queue", method: "POST", body: pending)
            guard generation == self.generation else { return }
            accept(response)
            pending = nil; title = ""; detail = ""; kind = "idea"
            confirmation = "Feedback saved to your queue."
        } catch {
            guard generation == self.generation else { return }
            // Only explicit pre-persistence rejections unlock editing. A lost
            // response keeps the exact payload and idempotency key frozen.
            if case let APIClient.ClientError.http(status, body) = error,
               (status == 400 && body?.code == "invalid_feedback") ||
               (status == 413 && body?.code == "payload_too_large") {
                pending = nil
                self.error = "Feedback was not saved. Check the title and details, then try again."
            } else if case let APIClient.ClientError.http(429, body) = error, body?.code == "feedback_limit" {
                self.error = "Your feedback queue is full. Your text is still here; contact support before retrying."
            } else if case APIClient.ClientError.http(401, _) = error {
                self.error = "Sign in again to confirm this submission. Your feedback text is still here."
            } else {
                self.error = "We could not confirm your feedback was saved. Retry this same submission; it will not create a second item."
            }
        }
    }
    func retry(item: FeedbackQueueItem, client: APIClient, scope: String) async {
        guard scope == self.scope, !busy, !loading else { return }
        let generation = generation
        busy = true; error = nil
        defer { if generation == self.generation { busy = false } }
        do {
            let response: FeedbackSubmissionResponse = try await client.request("v1/feedback/queue", pathSuffix: [item.id, "retry"], method: "POST")
            guard generation == self.generation else { return }
            accept(response)
        } catch {
            guard generation == self.generation else { return }
            self.error = "Delivery could not be confirmed. Your feedback remains saved. Wait 30 seconds before retrying."
        }
    }
    private func accept(_ response: FeedbackSubmissionResponse) {
        items.removeAll { $0.id == response.item.id }; items.insert(response.item, at: 0)
        deliveryAvailable = response.deliveryAvailable
    }
}

private struct FeedbackSettingsView: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject var model: FeedbackQueueModel
    private enum WritingField: Hashable { case title, details }
    @FocusState private var writingField: WritingField?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                form
                queue
            }.padding(20).foregroundStyle(OrcaTheme.ink)
        }.background(OrcaTheme.paper.ignoresSafeArea()).tint(OrcaTheme.accent)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Feedback").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { writingField = nil }
                        .accessibilityIdentifier("feedback.keyboard-done")
                }
            }
            .accessibilityIdentifier("feedback.root")
            .task(id: state.ownerScope) {
                model.configure(scope: state.ownerScope)
                if let client = state.client, !state.demoMode { await model.load(client: client, scope: state.ownerScope) }
            }
    }
    private var form: some View {
        SettingsGroup(title: "Share feedback", scope: "Orca") {
            Text("Tell us what happened or what you would like to improve. Only the text you enter is sent. Avoid private mail or passwords.")
                .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            Picker("Type", selection: $model.kind) {
                Text("Idea").tag("idea"); Text("Problem").tag("bug")
                Text("Question").tag("question"); Text("Other").tag("other")
            }.disabled(model.pending != nil || model.busy).tint(OrcaTheme.accent)
            VStack(alignment: .leading, spacing: 8) {
                Text("Title").font(OrcaTheme.ui(12, weight: .semibold))
                TextField("A short summary", text: $model.title)
                    .focused($writingField, equals: .title)
                    .submitLabel(.next).onSubmit { writingField = .details }
                    .textFieldStyle(.roundedBorder).accessibilityIdentifier("feedback.title")
                Text("Details").font(OrcaTheme.ui(12, weight: .semibold))
                TextEditor(text: $model.detail).frame(minHeight: 130).scrollContentBackground(.hidden)
                    .focused($writingField, equals: .details)
                    .padding(8).background(OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(OrcaTheme.border))
                    .accessibilityLabel("Feedback details").accessibilityIdentifier("feedback.details")
                Text("Title: \(model.title.utf16.count)/200 · Details: \(model.detail.utf16.count)/10,000")
                    .font(OrcaTheme.ui(10)).foregroundStyle(OrcaTheme.muted)
            }.disabled(model.pending != nil || model.busy)
            if let error = model.error {
                Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger).accessibilityIdentifier("feedback.error")
            }
            if let confirmation = model.confirmation {
                Text(confirmation).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.ink).accessibilityIdentifier("feedback.confirmation")
            }
            Button(model.busy ? "Saving…" : model.pending == nil ? "Queue feedback" : "Retry submission") {
                guard let client = state.client else { return }
                Task { await model.submit(client: client, scope: state.ownerScope) }
            }.buttonStyle(OrcaPrimaryButtonStyle())
                .disabled(!model.canSubmit || model.busy || model.loading || state.client == nil || state.demoMode)
                .accessibilityIdentifier("feedback.submit")
        }
    }
    private var queue: some View {
        SettingsGroup(title: "Your feedback", scope: "Latest 100") {
            Text("Queued items are saved in Orca. Delivered items have a Linear work record; follow the link for progress. Work starts after review.")
                .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            if !model.deliveryAvailable && !model.loading && model.loadError == nil {
                Text("Linear delivery is not configured. Feedback stays safely queued in Orca.")
                    .font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            }
            if model.loading { ProgressView("Loading feedback…") }
            if let error = model.loadError {
                Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger)
            } else if !model.loading && model.items.isEmpty {
                Text("No feedback yet. Your ideas and reports will appear here.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.muted)
            }
            Button("Refresh queue") {
                guard let client = state.client else { return }
                Task { await model.load(client: client, scope: state.ownerScope) }
            }.disabled(model.loading || model.busy || state.client == nil || state.demoMode)
                .frame(minHeight: 44).accessibilityIdentifier("feedback.refresh")
            ForEach(model.items) { item in feedbackRow(item) }
        }
    }
    private func feedbackRow(_ item: FeedbackQueueItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(item.title).font(OrcaTheme.ui(13, weight: .semibold))
            Text(item.status == "delivered" ? "Delivered to Linear" : "Queued")
                .font(OrcaTheme.ui(11, weight: .semibold)).accessibilityIdentifier("feedback.status.\(item.id)")
            Text(item.description).font(OrcaTheme.ui(12)).textSelection(.enabled)
            if let url = item.issueURL {
                Link(item.identifier ?? "Open work record", destination: url).frame(minHeight: 44)
            }
            if let error = item.deliveryError {
                Text(error).font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
            }
            if item.status == "queued" && model.deliveryAvailable {
                Button("Retry delivery") {
                    guard let client = state.client else { return }
                    Task { await model.retry(item: item, client: client, scope: state.ownerScope) }
                }.disabled(model.busy || model.loading).frame(minHeight: 44)
            }
            SettingsRule()
        }.padding(.vertical, 8)
    }
}
