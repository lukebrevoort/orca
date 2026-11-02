import SwiftUI

@main struct OrcaApp: App {
    @UIApplicationDelegateAdaptor(NotificationManager.self) var notifications
    @StateObject private var state = AppState()
    @Environment(\.scenePhase) private var scenePhase
    init() { OrcaTheme.configureNavigation() }
    var body: some Scene { WindowGroup { RootView().environmentObject(state).environmentObject(notifications).tint(OrcaTheme.accent).font(OrcaTheme.ui(15)).foregroundStyle(OrcaTheme.ink).task { notifications.state = state; await notifications.refreshPermission(); await state.start(); if state.phase == .ready { notifications.openPendingNotification(); notifications.reconcile() } }.onChange(of: state.phase) { if state.phase == .ready { notifications.openPendingNotification(); notifications.reconcile() } }.onChange(of: scenePhase) { if scenePhase == .active && state.phase == .ready { notifications.reconcile() } }.alert("Orca", isPresented: Binding(get: { state.errorMessage != nil }, set: { if !$0 { state.errorMessage = nil } })) { Button("OK") { state.errorMessage = nil } } message: { Text(state.errorMessage ?? "") } } }
}

struct RootView: View {
    @EnvironmentObject var state: AppState
    var body: some View { Group { switch state.phase {
    case .configuring:
#if DEBUG
        ServerSetupView()
#else
        ContentUnavailableView("Orca needs an update", systemImage: "exclamationmark.triangle", description: Text("The app’s connection settings are missing. Please install the latest build."))
#endif
    case .signedOut: SignInView()
    case .loading: ProgressView("Opening Orca")
    case .ready: MainView()
    } }.background(OrcaTheme.paper).preferredColorScheme(nil) }
}

struct ServerSetupView: View {
    @EnvironmentObject var state: AppState
    var body: some View { NavigationStack { VStack(alignment: .leading, spacing: 22) { Spacer(); Image(systemName: "water.waves").font(.system(size: 50)).foregroundStyle(OrcaTheme.accent); Text("A calmer current").font(.largeTitle.bold()); Text("Connect Orca to your team’s secure server. Production servers must use HTTPS.").foregroundStyle(.secondary); TextField("https://mail.example.com", text: $state.baseURLText).textInputAutocapitalization(.never).keyboardType(.URL).textFieldStyle(.roundedBorder).accessibilityLabel("Orca API server"); Button("Continue") { Task { await state.saveServer() } }.buttonStyle(OrcaPrimaryButtonStyle()).controlSize(.large); Spacer() }.padding(28) } }
}
struct SignInView: View {
    @EnvironmentObject var state: AppState
    var body: some View { VStack(spacing: 20) { Spacer(); Image(systemName: "water.waves").font(.system(size: 54)).foregroundStyle(OrcaTheme.accent); Text("Orca").font(.largeTitle.bold()); Text("Read and write with less noise.").foregroundStyle(.secondary); Button("Continue with Google") { Task { await state.signIn() } }.buttonStyle(OrcaPrimaryButtonStyle()).controlSize(.large)
#if DEBUG
        Button("Change server") { state.phase = .configuring }
#endif
        Spacer() }.padding() }
}
struct MainView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var mailboxes = MailboxViews()
    @StateObject private var feedback = FeedbackTicketModel()
    @State private var feedbackPresented = false
    var body: some View {
        TabView(selection: $state.selectedTab) {
            InboxView().safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) { feedbackCorner }.tabItem { Label("Inbox", systemImage: "tray") }.tag("inbox")
            DraftsView().safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) { feedbackCorner }.tabItem { Label("Drafts", systemImage: "doc.text") }.tag("drafts")
            SettingsView().safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) { feedbackCorner }.tabItem { Label("Settings", systemImage: "gearshape") }.tag("settings")
        }
        .environmentObject(mailboxes)
        .sheet(isPresented: $feedbackPresented) {
            FeedbackTicketComposer(model: feedback).environmentObject(state)
        }
        .task(id: state.ownerScope) {
            feedback.configure(scope: state.ownerScope)
            if let client = state.client, !state.demoMode {
                await feedback.checkAvailability(client: client, scope: state.ownerScope)
            }
        }
        .onChange(of: state.ownerScope) { _, scope in
            feedbackPresented = false
            feedback.configure(scope: scope)
        }
        .task(id: state.ownerScope) { await mailboxes.load(state: state) }
        .onChange(of: scenePhase) {
            if scenePhase == .active {
                Task {
                    try? await state.refreshAccountCapabilities()
                    await mailboxes.load(state: state)
                    if let client = state.client, !state.demoMode {
                        await feedback.checkAvailability(client: client, scope: state.ownerScope)
                    }
                }
            }
        }
    }
    @ViewBuilder private var feedbackCorner: some View {
        if feedback.available {
            Button { feedbackPresented = true } label: {
                Label("Feedback", systemImage: "bubble.left")
                    .font(OrcaTheme.ui(11, weight: .semibold))
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .foregroundStyle(OrcaTheme.ink)
                    .background(OrcaTheme.surface, in: Capsule())
                    .overlay(Capsule().stroke(OrcaTheme.border))
            }.buttonStyle(.plain)
                .accessibilityIdentifier("feedback.open")
                .accessibilityHint("Send a note to your Linear")
                .padding(.trailing, 16).padding(.vertical, 4)
        }
    }
}

@MainActor final class FeedbackTicketModel: ObservableObject {
    @Published var message = ""
    @Published private(set) var pending: FeedbackTicketInput?
    @Published private(set) var available = false
    @Published private(set) var busy = false
    @Published private(set) var receipt: FeedbackTicketReceipt?
    @Published private(set) var error: String?
    private var scope = ""
    private var generation = UUID()
    private var checking = false
    var canSubmit: Bool {
        available && (pending != nil || (!message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.utf16.count <= 10_000))
    }
    func configure(scope: String) {
        guard self.scope != scope else { return }
        self.scope = scope; generation = UUID()
        message = ""; pending = nil; available = false; busy = false
        receipt = nil; error = nil; checking = false
    }
    func checkAvailability(client: APIClient, scope: String) async {
        guard scope == self.scope, !checking else { return }
        let generation = generation
        checking = true
        defer { if generation == self.generation { checking = false } }
        do {
            let response: FeedbackTicketAvailability = try await client.request("v1/feedback/ticket")
            guard generation == self.generation else { return }
            available = response.available
        } catch {
            guard generation == self.generation else { return }
            available = false
        }
    }
    func send(client: APIClient, scope: String) async {
        guard scope == self.scope, !busy, canSubmit else { return }
        let generation = generation
        busy = true; error = nil; receipt = nil
        if pending == nil { pending = FeedbackTicketInput(message: message.trimmingCharacters(in: .whitespacesAndNewlines)) }
        defer { if generation == self.generation { busy = false } }
        do {
            let confirmed: FeedbackTicketReceipt = try await client.request("v1/feedback/ticket", method: "POST", body: pending)
            guard generation == self.generation else { return }
            guard !confirmed.identifier.isEmpty, confirmed.issueURL != nil else { throw APIClient.ClientError.invalidResponse }
            receipt = confirmed; pending = nil; message = ""
        } catch {
            guard generation == self.generation else { return }
            if case let APIClient.ClientError.http(status, body) = error,
               (status == 400 && body?.code == "invalid_feedback") ||
               (status == 413 && body?.code == "payload_too_large") {
                pending = nil
                self.error = "Your note was not sent. Check the text and try again."
            } else {
                self.error = "We could not confirm a Linear ticket. Your note is still here. Retry to check or finish this same submission."
            }
        }
    }
    func writeAnother() { receipt = nil; error = nil }
}

private struct FeedbackTicketComposer: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: FeedbackTicketModel
    @FocusState private var writing: Bool
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let receipt = model.receipt, let url = receipt.issueURL {
                        Label("Sent to Linear", systemImage: "checkmark.circle")
                            .font(OrcaTheme.ui(16, weight: .semibold))
                            .accessibilityIdentifier("feedback.confirmation")
                        Link("Open \(receipt.identifier)", destination: url)
                            .font(OrcaTheme.ui(14, weight: .semibold)).frame(minHeight: 44)
                            .accessibilityIdentifier("feedback.ticket-link")
                        Button("Send another note") { model.writeAnother(); writing = true }.frame(minHeight: 44)
                    } else {
                        Text("What would you like to change?").font(OrcaTheme.reader(24))
                        ZStack(alignment: .topLeading) {
                            TextEditor(text: $model.message)
                                .focused($writing).frame(minHeight: 180).scrollContentBackground(.hidden)
                                .accessibilityLabel("Feedback note").accessibilityIdentifier("feedback.message")
                            if model.message.isEmpty {
                                Text("An idea, a problem, or a small improvement…")
                                    .foregroundStyle(OrcaTheme.muted).padding(.top, 8).padding(.leading, 5)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }.padding(8).background(OrcaTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(OrcaTheme.border))
                            .disabled(model.pending != nil || model.busy)
                        Text("Creates a ticket in your Linear. Only your note is sent.")
                            .font(OrcaTheme.ui(11)).foregroundStyle(OrcaTheme.muted)
                        if model.message.utf16.count > 10_000 {
                            Text("Keep your note under 10,000 characters.").font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger)
                        }
                        if let error = model.error {
                            Text(error).font(OrcaTheme.ui(12)).foregroundStyle(OrcaTheme.danger).accessibilityIdentifier("feedback.error")
                        }
                        Button(model.busy ? "Sending…" : model.pending == nil ? "Send to Linear" : "Retry submission") {
                            guard let client = state.client else { return }
                            writing = false
                            Task { await model.send(client: client, scope: state.ownerScope) }
                        }.buttonStyle(OrcaPrimaryButtonStyle())
                            .disabled(!model.canSubmit || model.busy || state.client == nil)
                            .accessibilityIdentifier("feedback.submit")
                    }
                }.padding(20).foregroundStyle(OrcaTheme.ink)
            }.background(OrcaTheme.paper.ignoresSafeArea())
                .scrollDismissesKeyboard(.interactively)
                .navigationTitle("Feedback").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Close") { dismiss() }.accessibilityIdentifier("feedback.close")
                    }
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { writing = false }.accessibilityIdentifier("feedback.keyboard-done")
                    }
                }.accessibilityIdentifier("feedback.composer")
        }.tint(OrcaTheme.accent)
    }
}
