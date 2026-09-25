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
    var body: some View {
        TabView(selection: $state.selectedTab) {
            InboxView().tabItem { Label("Inbox", systemImage: "tray") }.tag("inbox")
            DraftsView().tabItem { Label("Drafts", systemImage: "doc.text") }.tag("drafts")
            SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }.tag("settings")
        }
        .environmentObject(mailboxes)
        .task(id: state.ownerScope) { await mailboxes.load(state: state) }
        .onChange(of: scenePhase) { if scenePhase == .active { Task { await mailboxes.load(state: state) } } }
    }
}
