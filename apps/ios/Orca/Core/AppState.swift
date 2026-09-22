import Foundation
import SwiftUI

@MainActor final class AppState: ObservableObject {
    enum Phase { case configuring, signedOut, loading, ready }
    @Published var phase: Phase = .configuring
    @Published var baseURLText = UserDefaults.standard.string(forKey: "apiBaseURL") ?? ""
    @Published var accounts = [MailAccount]()
    @Published var selectedAccountID: String? { didSet { UserDefaults.standard.set(selectedAccountID, forKey: "selectedAccountID") } }
    @Published var errorMessage: String?
    @Published var selectedTab = "inbox"
    private var connectionGeneration = UUID()
    @Published var routedThread: (id: String, accountId: String)?
    let keychain = KeychainStore()
    let draftStore = DraftStore()
    let cache = CacheStore()
    @Published private(set) var userID: String?
    private(set) var client: APIClient?
#if DEBUG
    let demoMode = ProcessInfo.processInfo.arguments.contains("--demo")
#else
    let demoMode = false
#endif
    private var fixtureToken: String?

    init() { selectedAccountID = UserDefaults.standard.string(forKey: "selectedAccountID") }
    var selectedAccount: MailAccount? { accounts.first { $0.id == selectedAccountID } ?? accounts.first }
    var ownerScope: String { "\(validatedBaseURL(baseURLText).map(origin) ?? "unconfigured")|\(userID ?? "unknown-user")" }
    func start() async {
        if demoMode { accounts = DemoData.accounts; selectedAccountID = accounts.first?.id; phase = .ready; return }
#if DEBUG
        if let fixture = fixtureConfiguration() { baseURLText = fixture.url.absoluteString; fixtureToken = fixture.token; configure(fixture.url); phase = .loading; await loadAccounts(); return }
#endif
        guard let url = validatedBaseURL(baseURLText) else { phase = .configuring; return }
        configure(url); phase = await keychain.read(origin: origin(url)) == nil ? .signedOut : .loading
        if phase == .loading { await loadAccounts() }
    }
    func validatedBaseURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
        return url
    }
    func saveServer() async { guard let url = validatedBaseURL(baseURLText) else { errorMessage = "Use HTTPS. HTTP is allowed only for localhost development."; return }; UserDefaults.standard.set(url.absoluteString, forKey: "apiBaseURL"); fixtureToken = nil; configure(url); phase = await keychain.read(origin: origin(url)) == nil ? .signedOut : .loading; if phase == .loading { await loadAccounts() } }
    func signIn() async { guard let client, let url = validatedBaseURL(baseURLText) else { return }; do { let exchange = try await BrowserAuth().authenticate(client: client); try await keychain.save(exchange.accessToken, origin: origin(url)); configure(url); phase = .loading; await loadAccounts() } catch { errorMessage = error.localizedDescription } }
    func loadAccounts() async {
        guard let client, let url = validatedBaseURL(baseURLText) else { return }; let origin = origin(url), generation = connectionGeneration
        do {
            let session: AuthSession = try await client.request("v1/auth/session")
            guard generation == connectionGeneration else { return }
            guard session.isAuthenticated, let user = session.user else { phase = .signedOut; return }
            userID = user.id; UserDefaults.standard.set(user.id, forKey: "lastUser|\(origin)")
            let loadedAccounts = try await client.accounts()
            guard generation == connectionGeneration else { return }
            accounts = loadedAccounts; try? await cache.save(accounts, key: "\(origin)|\(user.id)|accounts")
            guard generation == connectionGeneration else { return }
            if !accounts.contains(where: { $0.id == selectedAccountID }) { selectedAccountID = accounts.first?.id }; phase = .ready
        } catch let APIClient.ClientError.http(code, _) where code == 401 {
            guard generation == connectionGeneration else { return }
            phase = .signedOut; errorMessage = "Your session expired. Local drafts are still safe."
        } catch {
            guard generation == connectionGeneration else { return }
            let cachedUserID = UserDefaults.standard.string(forKey: "lastUser|\(origin)")
            let cached: [MailAccount]? = if let cachedUserID { await cache.load([MailAccount].self, key: "\(origin)|\(cachedUserID)|accounts") } else { nil }
            guard generation == connectionGeneration else { return }
            userID = cachedUserID
            if let cached { accounts = cached; if !accounts.contains(where: { $0.id == selectedAccountID }) { selectedAccountID = accounts.first?.id }; phase = .ready }
            else { phase = .signedOut }
            errorMessage = "You’re offline. Cached mail and local drafts remain available."
        }
    }
    @discardableResult func logout() async -> Bool {
        if let client {
            do { let _: EmptyResponse = try await client.request("v1/mobile/auth/session", method: "DELETE") }
            catch let APIClient.ClientError.http(code, _) where code == 401 { /* Already revoked or expired. */ }
            catch { errorMessage = "Could not revoke this device's session. Reconnect and try signing out again."; return false }
        }
        if let url = validatedBaseURL(baseURLText) { await keychain.clear(origin: origin(url)) }
        connectionGeneration = UUID(); accounts = []; userID = nil; routedThread = nil; fixtureToken = nil; if let url = validatedBaseURL(baseURLText) { configure(url) }; phase = .signedOut
        return true
    }
    func routeNotification(_ userInfo: [AnyHashable: Any]) {
        guard phase == .ready, let thread = userInfo["threadId"] as? String, !thread.isEmpty,
              let account = userInfo["accountId"] as? String, accounts.contains(where: { $0.id == account }) else { return }
        selectedAccountID = account; selectedTab = "inbox"; routedThread = (thread, account)
    }
    private func configure(_ url: URL) { connectionGeneration = UUID(); let keychain = keychain, fixtureToken = fixtureToken, key = origin(url); client = APIClient(baseURL: url) { if let fixtureToken { return fixtureToken }; return await keychain.read(origin: key) } }
    private func origin(_ url: URL) -> String { var parts = URLComponents(); parts.scheme = url.scheme?.lowercased(); parts.host = url.host?.lowercased(); parts.port = url.port == (url.scheme == "https" ? 443 : 80) ? nil : url.port; return parts.string ?? url.absoluteString }
#if DEBUG
    private func fixtureConfiguration() -> (url: URL, token: String)? {
        let args = ProcessInfo.processInfo.arguments
        guard let urlIndex = args.firstIndex(of: "--fixture-api-url"), args.indices.contains(urlIndex + 1), let tokenIndex = args.firstIndex(of: "--fixture-access-token"), args.indices.contains(tokenIndex + 1), let url = URL(string: args[urlIndex + 1]), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host), !args[tokenIndex + 1].isEmpty else { return nil }
        return (url, args[tokenIndex + 1])
    }
#endif
}

enum DemoData {
    static let accounts = [MailAccount(id: "demo-account", provider: "gmail", email: "hello@example.com", displayName: "Alex Rivera", avatarUrl: nil, capabilities: .init(read: true, send: true, draft: true))]
    static let messages = [
        InboxMessage(id: "m1", accountId: "demo-account", provider: "gmail", providerMessageId: "p1", threadId: "t1", from: .init(name: "Maya Chen", email: "maya@example.com"), subject: "The quiet launch plan", snippet: "I tightened the rollout notes and left one question for you…", receivedAt: "2026-09-22T15:30:00Z", unread: true, labels: ["INBOX"], attentionBehavior: "focus", humanSignal: 9, humanClassification: nil),
        InboxMessage(id: "m2", accountId: "demo-account", provider: "gmail", providerMessageId: "p2", threadId: "t2", from: .init(name: "Jon Bell", email: "jon@example.com"), subject: "Coffee next Thursday?", snippet: "Would 10:30 work near Union Station?", receivedAt: "2026-09-22T13:15:00Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 10, humanClassification: nil),
        InboxMessage(id: "m3", accountId: "demo-account", provider: "gmail", providerMessageId: "p3", threadId: "t3", from: .init(name: "Orca updates", email: "updates@orca.test"), subject: "Your weekly current", snippet: "Three conversations moved into focus this week.", receivedAt: "2026-09-21T16:00:00Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 2, humanClassification: nil)
    ]
}
