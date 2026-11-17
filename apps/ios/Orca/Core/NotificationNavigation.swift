import Foundation

struct SettingsNavigationRequest {
    enum Intent { case tab(String), notification(thread: String, account: String), mailbox(NativeMailIntent) }
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
    func routeMailbox(_ intent: NativeMailIntent) {
        guard validMailIntent(intent) else { return }
        requestNavigation(.mailbox(intent))
    }
    private func validMailIntent(_ intent: NativeMailIntent) -> Bool {
        guard let verified = nativeMailContext(), NativeMailJSON.exact(verified.origin, intent.context.origin), NativeMailJSON.exact(verified.userID, intent.context.userID) else { return false }
        return phase == .ready && intent.identity.validForInternalNavigation && NativeMailJSON.exact(ownerScope, intent.context.owner) && mailConnectionGeneration == intent.context.connection
            && Set(accounts.map(\.id)) == intent.context.ownedAccountIDs
            && accounts.contains { $0.id == intent.context.accountID }
            && (intent.identity.accountID == nil || intent.identity.accountID == intent.context.accountID)
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
        if case .mailbox(let intent) = pending.intent, !validMailIntent(intent) { pendingSettingsNavigation = nil; return }
        accountPreferences?.discard(); pendingSettingsNavigation = nil; applyNavigation(pending.intent)
    }
    private func applyNavigation(_ intent: SettingsNavigationRequest.Intent) {
        switch intent {
        case .mailbox(let intent):
            guard validMailIntent(intent) else { return }
            selectedAccountID = intent.context.accountID; selectedTab = "inbox"; routedMailbox = intent
        case .tab(let tab): selectedTab = tab
        case .notification(let thread, let account):
            guard accounts.contains(where: { $0.id == account }) else { return }
            selectedAccountID = account; selectedTab = "inbox"; routedThread = (thread, account)
        }
    }
}
