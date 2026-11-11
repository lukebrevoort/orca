import Foundation
import SwiftUI
// Runtime test data owner only. Production controllers, models, API client and
// CacheStore execute unchanged; this is not the native application or UI.
@MainActor final class AppState {
    enum Phase { case ready, signedOut }
    var phase: Phase = .ready
    var client: APIClient?
    var accounts = [MailAccount(id: "account", provider: "gmail", email: "owner@example.com", displayName: "Fixture", capabilities: .init(read: true, send: true, draft: true))]
    var selectedAccount: MailAccount? { accounts.first }
    var selectedAccountID: String? = "account"
    var selectedTab = "settings"
    var pendingSettingsNavigation: SettingsNavigationRequest?
    weak var accountPreferences: AccountPreferencesController?
    var routedThread: (id: String, accountId: String)?
    var ownerScope = "synthetic-owner"
    var userID: String? = "owner"
    var baseURLText = "https://example.invalid"
    var demoMode = false
    let cache: CacheStore
    init(cache: CacheStore) { self.cache = cache }
    func validatedBaseURL(_ value: String) -> URL? { URL(string: value) }
    var mailboxReadRevision = UUID()
    func importanceDidChange(accountId: String) { mailboxReadRevision = UUID() }
    func inboxCacheKey(accountID: String, view: String, search: String) -> String { "\(ownerScope)|\(accountID)|\(view)|\(search)" }
}
enum DemoData { static func inbox(view: String) -> [InboxMessage] { [] } }
enum MailboxViews {
    static func permitsOfflineCache(_ error: Error) -> Bool {
        if case let APIClient.ClientError.http(code, _) = error { return code >= 500 }
        return error is URLError
    }
}
final class ReviewURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (code, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
func body(_ request: URLRequest) throws -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }; stream.open(); defer { stream.close() }
    var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while true { let n = stream.read(&buffer, maxLength: buffer.count); if n == 0 { return data }; if n < 0 { throw stream.streamError! }; data.append(buffer, count: n) }
}

actor PreferenceCredentialHold {
    private var count = 0
    private let first: String, second: String
    init(first: String = "owner-a-token", second: String = "owner-b-token") { self.first = first; self.second = second }
    private var held = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?
    func token() async -> String {
        count += 1
        if count == 2 {
            held = true; started?.resume(); started = nil
            await withCheckedContinuation { continuation = $0 }
            return second
        }
        return count >= 2 ? second : first
    }
    func waitUntilHeld() async { if !held { await withCheckedContinuation { started = $0 } } }
    func release() { continuation?.resume(); continuation = nil }
}
