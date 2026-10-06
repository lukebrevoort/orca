import Foundation

actor APIClient {
    enum ClientError: LocalizedError { case invalidBaseURL, invalidResponse, http(Int, APIErrorBody?), decoding(Error)
        var errorDescription: String? { switch self { case .invalidBaseURL: "Enter a valid server URL."; case .invalidResponse: "The server returned an unreadable response."; case let .http(code, body): body?.message ?? "Server error (\(code))."; case let .decoding(error): "Orca could not read the server response: \(error.localizedDescription)" } }
    }
    enum SendFailurePhase: Equatable { case confirmedPreReservation, uncertain }
    nonisolated static func sendFailurePhase(for error: Error) -> SendFailurePhase {
        guard case let ClientError.http(status, body) = error else { return .uncertain }
        switch (status, body?.code) {
        case (409, "stale_draft"), (501, "missing_capability"), (409, "provider_rejected"):
            return .confirmedPreReservation
        default:
            return .uncertain
        }
    }
    private var baseURL: URL
    private let session: URLSession
    private let token: @Sendable () async -> String?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    // This actor belongs to the authenticated app session, so a new query or
    // InboxViewModel cannot forget an indexed capability already observed.
    private var indexedSearchOwners = Set<String>()
    private var searchCapabilityGeneration = UUID()
    private var currentSearchSession: MailSearchSession?

    init(baseURL: URL, session: URLSession? = nil, token: @escaping @Sendable () async -> String?) {
        self.baseURL = baseURL; self.session = session ?? URLSession(configuration: .ephemeral, delegate: CredentialSafeRedirectDelegate(), delegateQueue: nil); self.token = token
    }
    func updateBaseURL(_ url: URL) { baseURL = url }
    func request<T: Decodable>(_ path: String, pathSuffix: [String] = [], method: String = "GET", query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws -> T {
        let (data, _) = try await raw(path, pathSuffix: pathSuffix, method: method, query: query, body: body)
        guard !data.isEmpty else { if T.self == EmptyResponse.self { return EmptyResponse() as! T }; throw ClientError.invalidResponse }
        do { return try decoder.decode(T.self, from: data) } catch { throw ClientError.decoding(error) }
    }
    func raw(_ path: String, pathSuffix: [String] = [], method: String = "GET", query: [URLQueryItem] = [], body: (any Encodable)? = nil, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
        let endpoint = pathSuffix.reduce(baseURL.appending(path: path)) { $0.appending(component: $1) }
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { throw ClientError.invalidBaseURL }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw ClientError.invalidBaseURL }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if path.hasPrefix("v1/mail/search") || headers["X-Orca-Expected-Search-Mode"] != nil { request.cachePolicy = .reloadIgnoringLocalCacheData }
        if let accessToken = await token() { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try encoder.encode(AnyEncodable(body)); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }
        guard 200..<300 ~= http.statusCode else { throw ClientError.http(http.statusCode, try? decoder.decode(ErrorEnvelope.self, from: data).error) }
        return (data, http)
    }
}
private final class CredentialSafeRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let original = task.originalRequest?.url, let redirected = request.url, redirected.scheme == "https" || original.scheme == "http" else { completionHandler(nil); return }
        var safe = request
        if original.scheme?.lowercased() != redirected.scheme?.lowercased() || original.host?.lowercased() != redirected.host?.lowercased() || original.port != redirected.port { safe.setValue(nil, forHTTPHeaderField: "Authorization") }
        completionHandler(safe)
    }
}
struct EmptyResponse: Codable {}
private struct AnyEncodable: Encodable { let value: any Encodable; init(_ value: any Encodable) { self.value = value }; func encode(to encoder: Encoder) throws { try value.encode(to: encoder) } }

extension APIClient {
    func accounts() async throws -> [MailAccount] { struct Page: Decodable { var items: [MailAccount] }; let page: Page = try await request("v1/accounts"); return page.items }
    func inbox(accountId: String, view: String, query text: String?, cursor: String? = nil, destinationId: String? = nil, limit: Int = 30, searchSession: MailSearchSession? = nil) async throws -> InboxPage {
        var q = [URLQueryItem(name: "accountId", value: accountId), .init(name: "view", value: view), .init(name: "limit", value: String(limit))]
        if let text, !text.isEmpty { q.append(.init(name: "query", value: text)) }; if let cursor { q.append(.init(name: "cursor", value: cursor)) }
        if let destinationId { q.append(.init(name: "destinationId", value: destinationId)) }
        if let searchSession {
            guard searchSession.capabilities.mode == .legacyMetadata, text?.isEmpty == false else { throw ClientError.invalidResponse }
            return try await boundSearchRequest("v1/inbox", query: q, searchSession: searchSession)
        }
        return try await request("v1/inbox", query: q)
    }
    func searchCapabilities(expectedOwnerID: String? = nil) async throws -> MailSearchSession {
        let origin = baseURL, generation = UUID()
        searchCapabilityGeneration = generation
        let capabilities: MailSearchCapabilities
        let isLegacyServer: Bool
        do {
            capabilities = try await request("v1/mail/search/capabilities")
            isLegacyServer = false
        } catch let ClientError.http(status, _) where status == 404 {
            // An old server has no capability route. Verify the existing session
            // before interpreting that absence as an explicit compatibility mode.
            let auth: AuthSession = try await request("v1/auth/session")
            guard auth.isAuthenticated, let owner = auth.user, !owner.id.isEmpty else { throw ClientError.http(401, nil) }
            guard !indexedSearchOwners.contains("\(searchOrigin(origin))|\(owner.id)") else {
                throw ClientError.http(503, APIErrorBody(code: "search_capabilities_unavailable", message: "Search capabilities could not be verified. Try again without changing your query or mailbox.", retryable: true))
            }
            capabilities = MailSearchCapabilities(version: 1, mode: .legacyMetadata, epoch: "legacy-server", ownerId: owner.id, coverage: "stored-metadata", semantics: "legacy-substring-v1")
            isLegacyServer = true
        }
        guard generation == searchCapabilityGeneration, origin == baseURL else { throw CancellationError() }
        guard expectedOwnerID == nil || expectedOwnerID == capabilities.ownerId else { throw ClientError.invalidResponse }
        if capabilities.mode == .indexed { indexedSearchOwners.insert("\(searchOrigin(origin))|\(capabilities.ownerId)") }
        let result = MailSearchSession(capabilities: capabilities, origin: origin, isLegacyServer: isLegacyServer)
        currentSearchSession = result
        return result
    }
    private func boundSearchRequest<T: Decodable>(_ path: String, query: [URLQueryItem], searchSession: MailSearchSession) async throws -> T {
        guard searchSession == currentSearchSession, searchSession.origin == baseURL else { throw searchModeChanged() }
        let capability = searchSession.capabilities
        let (data, response) = try await raw(path, query: query, headers: [
            "X-Orca-Expected-Search-Mode": capability.mode.rawValue,
            "X-Orca-Expected-Search-Epoch": capability.epoch,
        ])
        guard searchSession == currentSearchSession, searchSession.origin == baseURL else { throw searchModeChanged() }
        let responseMode = response.value(forHTTPHeaderField: "X-Orca-Search-Mode")
        let responseEpoch = response.value(forHTTPHeaderField: "X-Orca-Search-Epoch")
        let oldServerWithoutHeaders = searchSession.isLegacyServer && responseMode == nil && responseEpoch == nil
        guard oldServerWithoutHeaders || (responseMode == capability.mode.rawValue && responseEpoch == capability.epoch) else { throw searchModeChanged() }
        do { return try decoder.decode(T.self, from: data) } catch { throw ClientError.decoding(error) }
    }
    private func searchModeChanged() -> ClientError {
        .http(409, APIErrorBody(code: "search_mode_changed", message: "Search coverage changed. Restart this search to use the current mode.", retryable: true))
    }
    private func searchOrigin(_ url: URL) -> String {
        var origin = URLComponents()
        origin.scheme = url.scheme?.lowercased(); origin.host = url.host?.lowercased()
        origin.port = url.port == (origin.scheme == "https" ? 443 : 80) ? nil : url.port
        return origin.string ?? url.absoluteString
    }
    func searchMail(query text: String, accountId: String? = nil, view: MailSearchView = .all, cursor: String? = nil, destinationId: String? = nil, searchSession: MailSearchSession) async throws -> MailSearchPage {
        guard searchSession.capabilities.mode == .indexed else { throw searchModeChanged() }
        var query = [URLQueryItem(name: "query", value: text), .init(name: "limit", value: "10"), .init(name: "view", value: view.rawValue)]
        if let accountId { query.append(.init(name: "accountId", value: accountId)) }
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        if let destinationId { query.append(.init(name: "destinationId", value: destinationId)) }
        return try await boundSearchRequest("v1/mail/search", query: query, searchSession: searchSession)
    }
    func thread(_ id: String, accountId: String) async throws -> ThreadDetail { try await request("v1/threads/\(id)", query: [.init(name: "accountId", value: accountId)]) }
    func markRead(_ id: String, accountId: String, isRead: Bool = true) async throws { struct Ack: Decodable { var ok: Bool }; let _: Ack = try await request("v1/threads/\(id)/read", method: "PATCH", query: [.init(name: "accountId", value: accountId)], body: ["isRead": isRead]) }
    func drafts(accountId: String) async throws -> [MessageDraft] { try await request("v1/drafts", query: [.init(name: "accountId", value: accountId)]) }
    func draft(_ id: String, accountId: String) async throws -> MessageDraft { try await request("v1/drafts/\(id)", query: [.init(name: "accountId", value: accountId)]) }
    func createDraft(accountId: String, content: DraftContent) async throws -> MessageDraft { try await request("v1/drafts", method: "POST", query: [.init(name: "accountId", value: accountId)], body: content) }
    func updateDraft(_ id: String, accountId: String, revision: Int, content: DraftContent) async throws -> MessageDraft { struct Update: Encodable { var revision: Int; var to: [Recipient]; var cc: [Recipient]; var bcc: [Recipient]; var subject: String; var body: DraftBody; var context: DraftContext?; var attachments: [OutboundAttachment] }; return try await request("v1/drafts/\(id)", method: "PATCH", query: [.init(name: "accountId", value: accountId)], body: Update(revision: revision, to: content.to, cc: content.cc, bcc: content.bcc, subject: content.subject, body: content.body, context: content.context, attachments: content.attachments)) }
    func sendDraft(_ id: String, accountId: String, revision: Int, idempotencyKey: String) async throws -> DeliveryResult { struct Command: Encodable { var revision: Int; var idempotencyKey: String }; return try await request("v1/drafts/\(id)/send", method: "POST", query: [.init(name: "accountId", value: accountId)], body: Command(revision: revision, idempotencyKey: idempotencyKey)) }
    func deleteDraft(_ id: String, accountId: String) async throws { let _: EmptyResponse = try await request("v1/drafts/\(id)", method: "DELETE", query: [.init(name: "accountId", value: accountId)]) }
    func attachment(_ id: String, accountId: String) async throws -> Data { let data = try await raw("v1/attachments/\(id)", query: [.init(name: "accountId", value: accountId)]).0; guard data.count <= 25 * 1024 * 1024 else { throw ClientError.http(413, APIErrorBody(code: "attachment_limit", message: "Attachment exceeds the 25 MB device limit", retryable: false)) }; return data }
    func mailboxViews() async throws -> SavedMailboxViewCatalog { try await request("v1/organization/views") }
    func mailboxViewResults(_ id: String, cursor: String? = nil) async throws -> SavedViewPage {
        var query = [URLQueryItem(name: "limit", value: "30")]
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        return try await request("v1/organization/views", pathSuffix: [id, "results"], query: query)
    }
    func notificationCatalog() async throws -> NotificationCatalog { try await request("v1/mobile/push/catalog") }
    func pushStatus(installationId: String) async throws -> PushStatus { try await request("v1/mobile/push/status", query: [.init(name: "installationId", value: installationId)]) }
    func registerDevice(installationId: String, token: String, environment: String, selection: NotificationSelection) async throws -> PushRegistration { struct Body: Encodable { var token: String; var environment: String; var notificationSelection: NotificationSelection }; return try await request("v1/mobile/devices/\(installationId)", method: "PUT", body: Body(token: token, environment: environment, notificationSelection: selection)) }
    func unregisterDevice(installationId: String) async throws { let _: EmptyResponse = try await request("v1/mobile/devices/\(installationId)", method: "DELETE") }
}
