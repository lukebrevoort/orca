import Foundation

struct SettingsNavigationRequest {
    enum Intent { case tab(String), notification(thread: String, account: String) }
    var owner: String
    var intent: Intent
}

@MainActor extension AppState {
    func navigate(to tab: String) { requestNavigation(.tab(tab)) }
    func routeNotification(_ userInfo: [AnyHashable: Any]) {
        guard phase == .ready, let thread = userInfo["threadId"] as? String, !thread.isEmpty,
              let account = userInfo["accountId"] as? String, accounts.contains(where: { $0.id == account }) else { return }
        requestNavigation(.notification(thread: thread, account: account))
    }
    private func requestNavigation(_ intent: SettingsNavigationRequest.Intent) {
        guard phase == .ready else { return }
        if case .tab("settings") = intent, selectedTab == "settings" { return }
        if selectedTab == "settings", let preferences = accountPreferences, preferences.dirty || preferences.saving {
            pendingSettingsNavigation = .init(owner: ownerScope, intent: intent)
        } else { pendingSettingsNavigation = nil; applyNavigation(intent) }
    }
    func stayInSettings() { pendingSettingsNavigation = nil }
    func discardSettingsAndLeave() {
        guard let pending = pendingSettingsNavigation else { return }
        guard pending.owner == ownerScope, phase == .ready else { pendingSettingsNavigation = nil; return }
        guard accountPreferences?.saving != true else { return }
        if case .notification(_, let account) = pending.intent, !accounts.contains(where: { $0.id == account }) {
            pendingSettingsNavigation = nil; return
        }
        accountPreferences?.discard(); pendingSettingsNavigation = nil; applyNavigation(pending.intent)
    }
    private func applyNavigation(_ intent: SettingsNavigationRequest.Intent) {
        switch intent {
        case .tab(let tab): selectedTab = tab
        case .notification(let thread, let account):
            guard accounts.contains(where: { $0.id == account }) else { return }
            selectedAccountID = account; selectedTab = "inbox"; routedThread = (thread, account)
        }
    }
}
