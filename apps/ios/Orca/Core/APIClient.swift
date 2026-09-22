import Foundation

actor APIClient {
    enum ClientError: LocalizedError { case invalidBaseURL, invalidResponse, http(Int, APIErrorBody?), decoding(Error)
        var errorDescription: String? { switch self { case .invalidBaseURL: "Enter a valid server URL."; case .invalidResponse: "The server returned an unreadable response."; case let .http(code, body): body?.message ?? "Server error (\(code))."; case let .decoding(error): "Orca could not read the server response: \(error.localizedDescription)" } }
    }
    private var baseURL: URL
    private let session: URLSession
    private let token: @Sendable () async -> String?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, session: URLSession? = nil, token: @escaping @Sendable () async -> String?) {
        self.baseURL = baseURL; self.session = session ?? URLSession(configuration: .ephemeral, delegate: CredentialSafeRedirectDelegate(), delegateQueue: nil); self.token = token
    }
    func updateBaseURL(_ url: URL) { baseURL = url }
    func request<T: Decodable>(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws -> T {
        let (data, _) = try await raw(path, method: method, query: query, body: body)
        guard !data.isEmpty else { if T.self == EmptyResponse.self { return EmptyResponse() as! T }; throw ClientError.invalidResponse }
        do { return try decoder.decode(T.self, from: data) } catch { throw ClientError.decoding(error) }
    }
    func raw(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: (any Encodable)? = nil) async throws -> (Data, HTTPURLResponse) {
        guard var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false) else { throw ClientError.invalidBaseURL }
        components.queryItems = query.isEmpty ? nil : query
        guard let url = components.url else { throw ClientError.invalidBaseURL }
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
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
    func inbox(accountId: String, view: String, query text: String?, cursor: String? = nil) async throws -> InboxPage {
        var q = [URLQueryItem(name: "accountId", value: accountId), .init(name: "view", value: view), .init(name: "limit", value: "30")]
        if let text, !text.isEmpty { q.append(.init(name: "query", value: text)) }; if let cursor { q.append(.init(name: "cursor", value: cursor)) }
        return try await request("v1/inbox", query: q)
    }
    func thread(_ id: String, accountId: String) async throws -> ThreadDetail { try await request("v1/threads/\(id)", query: [.init(name: "accountId", value: accountId)]) }
    func markRead(_ id: String, accountId: String, isRead: Bool = true) async throws { struct Ack: Decodable { var ok: Bool }; let _: Ack = try await request("v1/threads/\(id)/read", method: "PATCH", query: [.init(name: "accountId", value: accountId)], body: ["isRead": isRead]) }
    func drafts(accountId: String) async throws -> [MessageDraft] { try await request("v1/drafts", query: [.init(name: "accountId", value: accountId)]) }
    func createDraft(accountId: String, content: DraftContent) async throws -> MessageDraft { try await request("v1/drafts", method: "POST", query: [.init(name: "accountId", value: accountId)], body: content) }
    func updateDraft(_ id: String, accountId: String, revision: Int, content: DraftContent) async throws -> MessageDraft { struct Update: Encodable { var revision: Int; var to: [Recipient]; var cc: [Recipient]; var bcc: [Recipient]; var subject: String; var body: DraftBody; var context: DraftContext?; var attachments: [OutboundAttachment] }; return try await request("v1/drafts/\(id)", method: "PATCH", query: [.init(name: "accountId", value: accountId)], body: Update(revision: revision, to: content.to, cc: content.cc, bcc: content.bcc, subject: content.subject, body: content.body, context: content.context, attachments: content.attachments)) }
    func sendDraft(_ id: String, accountId: String, revision: Int, idempotencyKey: String) async throws -> DeliveryResult { struct Command: Encodable { var revision: Int; var idempotencyKey: String }; return try await request("v1/drafts/\(id)/send", method: "POST", query: [.init(name: "accountId", value: accountId)], body: Command(revision: revision, idempotencyKey: idempotencyKey)) }
    func deleteDraft(_ id: String, accountId: String) async throws { let _: EmptyResponse = try await request("v1/drafts/\(id)", method: "DELETE", query: [.init(name: "accountId", value: accountId)]) }
    func attachment(_ id: String, accountId: String) async throws -> Data { let data = try await raw("v1/attachments/\(id)", query: [.init(name: "accountId", value: accountId)]).0; guard data.count <= 25 * 1024 * 1024 else { throw ClientError.http(413, APIErrorBody(code: "attachment_limit", message: "Attachment exceeds the 25 MB device limit", retryable: false)) }; return data }
    func pushStatus(installationId: String) async throws -> PushStatus { try await request("v1/mobile/push/status", query: [.init(name: "installationId", value: installationId)]) }
    func registerDevice(installationId: String, token: String, environment: String, mode: String) async throws -> PushRegistration { struct Body: Encodable { var token: String; var environment: String; var notificationMode: String }; return try await request("v1/mobile/devices/\(installationId)", method: "PUT", body: Body(token: token, environment: environment, notificationMode: mode)) }
    func unregisterDevice(installationId: String) async throws { let _: EmptyResponse = try await request("v1/mobile/devices/\(installationId)", method: "DELETE") }
}
