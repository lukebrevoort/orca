import Foundation
import SwiftUI

@MainActor final class AppState: ObservableObject {
    enum Phase { case configuring, signedOut, loading, ready }
    @Published var phase: Phase = .configuring
    @Published var baseURLText: String = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "OrcaAPIBaseURL") as? String ?? ""
#if DEBUG
        return UserDefaults.standard.string(forKey: "apiBaseURL") ?? configured
#else
        return configured
#endif
    }()
    @Published var accounts = [MailAccount]()
    @Published var selectedAccountID: String? { didSet { UserDefaults.standard.set(selectedAccountID, forKey: "selectedAccountID") } }
    @Published var errorMessage: String?
    @Published var selectedTab = "inbox"
    @Published private(set) var mailboxReadRevision = UUID()
    private var connectionGeneration = UUID()
    private var accountRefreshGeneration = UUID()
    @Published var routedThread: (id: String, accountId: String)?
    let keychain = KeychainStore()
    let draftStore = DraftStore()
    @Published var activeDraftOperations = [UUID: UUID]()
    let cache: CacheStore
    @Published private(set) var userID: String?
    private(set) var client: APIClient?
#if DEBUG
    let demoMode = ProcessInfo.processInfo.arguments.contains("--demo")
#else
    let demoMode = false
#endif
    private var fixtureToken: String?

    init(client: APIClient? = nil, cache: CacheStore = CacheStore()) { self.client = client; self.cache = cache; selectedAccountID = UserDefaults.standard.string(forKey: "selectedAccountID") }
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
    /// Refresh grants without replacing the current identity, navigation, or
    /// cached accounts when the device is offline or its session has expired.
    @discardableResult func refreshAccountCapabilities() async throws -> Bool {
        guard !demoMode, phase == .ready, let client else { return false }
        let generation = connectionGeneration, scope = ownerScope
        accountRefreshGeneration = UUID(); let refreshGeneration = accountRefreshGeneration
        let loaded = try await client.accounts()
        guard !Task.isCancelled, phase == .ready, generation == connectionGeneration,
              refreshGeneration == accountRefreshGeneration, scope == ownerScope,
              self.client === client else { return false }
        accounts = loaded
        // A composer keeps its original account even if it was disconnected.
        // Only list navigation falls back to another currently owned account.
        if !accounts.contains(where: { $0.id == selectedAccountID }) { selectedAccountID = accounts.first?.id }
        try? await cache.save(loaded, key: "\(scope)|accounts")
        return true
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
    @discardableResult func selectSavedViewThread(_ thread: SavedViewThread) -> Bool {
        guard phase == .ready, accounts.contains(where: { $0.id == thread.accountId }) else { return false }
        selectedAccountID = thread.accountId
        return true
    }
    /// A successful read mutation retires every cached inbox lens for this
    /// identity/account, including pages saved before a later app launch.
    func inboxCacheKey(accountID: String, view: String, search: String) -> String {
        let revision = UserDefaults.standard.string(forKey: "inboxReadRevision|\(ownerScope)|\(accountID)") ?? "initial"
        return "\(ownerScope)|\(accountID)|inbox-unread-focus-v1|\(revision)|\(view)|\(search)"
    }
    func markThreadRead(_ threadID: String, accountID: String, isRead: Bool = true) async throws {
        guard let client else { throw APIClient.ClientError.invalidResponse }
        let scope = ownerScope
        try await client.markRead(threadID, accountId: accountID, isRead: isRead)
        // Persist for the original owner even if navigation changed while the
        // request was in flight. Never publish a former identity's mutation.
        let revision = UUID()
        UserDefaults.standard.set(revision.uuidString, forKey: "inboxReadRevision|\(scope)|\(accountID)")
        guard scope == ownerScope else { return }
        mailboxReadRevision = revision
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
    private struct ThreadKey: Hashable { var accountID: String; var threadID: String }

    static func inbox(view: String, messages: [InboxMessage] = DemoData.messages) -> [InboxMessage] {
        let isInbox = view == "normal" || view == "focus"
        func newestFirst(_ left: InboxMessage, _ right: InboxMessage) -> Bool {
            if left.receivedAt != right.receivedAt { return left.receivedAt > right.receivedAt }
            if left.accountId != right.accountId { return left.accountId < right.accountId }
            return left.id < right.id
        }
        let rows: [InboxMessage]
        if isInbox {
            let threads = Dictionary(grouping: messages) { ThreadKey(accountID: $0.accountId, threadID: $0.threadId) }
            rows = threads.values.compactMap { threadMessages -> InboxMessage? in
                // Membership and unread belong to the entire account-scoped
                // thread; a newer sent/read reply remains its visible summary.
                guard threadMessages.contains(where: { $0.labels.contains("INBOX") }),
                      var latest = threadMessages.sorted(by: newestFirst).first else { return nil }
                latest.unread = threadMessages.contains(where: \.unread)
                return latest
            }
        } else {
            rows = messages
        }
        let legacyRank = ["notify": 0, "focus": 1, "normal": 2, "quiet": 3, "hidden": 4]
        return rows.filter { message in
            switch view {
            case "normal": return !["quiet", "hidden"].contains(message.attentionBehavior)
            case "focus": return ["focus", "notify"].contains(message.attentionBehavior)
            case "all": return true
            default: return message.attentionBehavior == view
            }
        }.sorted { left, right in
            if isInbox {
                let leftPromoted = left.unread && ["focus", "notify"].contains(left.attentionBehavior)
                let rightPromoted = right.unread && ["focus", "notify"].contains(right.attentionBehavior)
                if leftPromoted != rightPromoted { return leftPromoted }
            } else {
                let leftRank = legacyRank[left.attentionBehavior] ?? 2
                let rightRank = legacyRank[right.attentionBehavior] ?? 2
                if leftRank != rightRank { return leftRank < rightRank }
            }
            return newestFirst(left, right)
        }
    }

    static let accounts = [MailAccount(id: "demo-account", provider: "gmail", email: "hello@example.com", displayName: "Alex Rivera", avatarUrl: nil, capabilities: .init(read: true, send: true, draft: true))]
    static let messages = [
        InboxMessage(id: "m1", accountId: "demo-account", provider: "gmail", providerMessageId: "p1", threadId: "t1", from: .init(name: "Maya Chen", email: "maya@example.com"), subject: "The quiet launch plan", snippet: "I tightened the rollout notes and left one question for you…", receivedAt: "2026-09-22T15:30:00Z", unread: true, labels: ["INBOX"], attentionBehavior: "focus", humanSignal: 9, humanClassification: nil),
        InboxMessage(id: "m2", accountId: "demo-account", provider: "gmail", providerMessageId: "p2", threadId: "t2", from: .init(name: "Jon Bell", email: "jon@example.com"), subject: "Coffee next Thursday?", snippet: "Would 10:30 work near Union Station?", receivedAt: "2026-09-22T13:15:00Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 10, humanClassification: nil),
        InboxMessage(id: "m3", accountId: "demo-account", provider: "gmail", providerMessageId: "p3", threadId: "t3", from: .init(name: "Orca updates", email: "updates@orca.test"), subject: "Your weekly current", snippet: "Three conversations moved into focus this week.", receivedAt: "2026-09-21T16:00:00Z", unread: false, labels: ["INBOX"], attentionBehavior: "normal", humanSignal: 2, humanClassification: nil)
    ]
}

