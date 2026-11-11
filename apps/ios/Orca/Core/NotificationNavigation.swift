import Foundation

@MainActor extension AppState {
    func routeNotification(_ userInfo: [AnyHashable: Any]) {
        guard phase == .ready, let thread = userInfo["threadId"] as? String, !thread.isEmpty,
              let account = userInfo["accountId"] as? String, accounts.contains(where: { $0.id == account }) else { return }
        selectedAccountID = account; selectedTab = "inbox"; routedThread = (thread, account)
    }
}
