import Foundation

/// Observes actual APIClient-produced task requests at response admission.
/// No URL rewriting, request-body inspection, credential logging or state writes.
final class SyntheticSenderRequestProbe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Observation: Codable {
        var rawPercentEncodedQuery: String; var sender: String; var accountId: String; var view: String; var status: Int
    }
    private let baseURL: URL
    private let lock = NSLock()
    private var observations = [Observation]()
    init(baseURL: URL) { self.baseURL = baseURL; super.init() }
    func snapshot() -> [Observation] { lock.lock(); defer { lock.unlock() }; return observations }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let request = dataTask.originalRequest, request.httpMethod == "GET", let url = request.url,
           url.scheme == "http", url.host == "127.0.0.1", url.port == baseURL.port, url.path == "/v1/inbox",
           let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let items = parts.queryItems,
           items.map(\.name).sorted() == ["accountId", "sender", "view"],
           items.first(where: { $0.name == "accountId" })?.value == "account",
           items.first(where: { $0.name == "view" })?.value == "all",
           let sender = items.first(where: { $0.name == "sender" })?.value,
           ["needle+nav@example.com", "needle nav@example.com", "neighbor@example.com", "needle%2Bnav@example.com"].contains(sender),
           let query = parts.percentEncodedQuery, let http = response as? HTTPURLResponse {
            lock.lock()
            if observations.count < 8 { observations.append(.init(rawPercentEncodedQuery: query, sender: sender, accountId: "account", view: "all", status: http.statusCode)) }
            lock.unlock()
        }
        completionHandler(.allow)
    }
    // Diagnostic requests are loopback-only. No redirect capability is needed.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor func runSenderTransportDiagnosticCases(connection: ReviewRegressions.Connection, client: APIClient, transport: URLSession, probe: SyntheticSenderRequestProbe, check: (String, Bool, String) -> Void) async throws {
    guard let base = URL(string: connection.baseURL), base.scheme == "http", base.host == "127.0.0.1", base.port != nil else { throw APIClient.ClientError.invalidBaseURL }
    // Direct URLSession control deliberately supplies an encoded plus. It does
    // not change APIClient or replace the original alias stimulus/assertion.
    let directURL = base.appending(path: "v1/inbox").absoluteString + "?accountId=account&view=all&sender=needle%2Bnav%40example.com"
    var request = URLRequest(url: URL(string: directURL)!); request.httpMethod = "GET"; request.timeoutInterval = 30
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer " + connection.token, forHTTPHeaderField: "Authorization")
    let (data, response) = try await transport.data(for: request)
    let direct = try JSONDecoder().decode(InboxPage.self, from: data)
    let expected: Set<String> = ["nav-mail-archived", "nav-mail-quiet"]
    check("NAV-DIAG-direct-encoded-plus-transport", (response as? HTTPURLResponse)?.statusCode == 200 && Set(direct.messages.map(\.id)) == expected, "direct transport %2B control, not a production APIClient fix")
    for (label, sender, ids) in [("no-plus", "neighbor@example.com", Set(["nav-mail-inbox"])), ("space", "needle nav@example.com", Set<String>()), ("literal-percent", "needle%2Bnav@example.com", Set<String>())] {
        let page: InboxPage = try await client.request("v1/inbox", query: [.init(name: "accountId", value: "account"), .init(name: "view", value: "all"), .init(name: "sender", value: sender)])
        check("NAV-DIAG-\(label)-transport-boundary", Set(page.messages.map(\.id)) == ids, "unchanged APIClient input; literal sender name/address matching, no domain expansion")
    }
    let snapshot: MailActionJSON = try await client.request("__bre457/navigation/state")
    guard case .array(let rows) = snapshot["expectedExactSenderRows"], case .array(let noPlusRows) = snapshot["expectedNoPlusSenderRows"], case .array(let server) = snapshot["senderTransport"] else { throw APIClient.ClientError.invalidResponse }
    check("NAV-DIAG-independent-sender-sqlite-witness", Set(rows.compactMap(\.text)) == expected && noPlusRows.compactMap(\.text) == ["nav-mail-inbox"], "independent exact-address SQLite IDs; not copied from HTTP results or an API matcher reimplementation")
    let actual = probe.snapshot()
    var reconstructed = URLComponents(url: base.appending(path: "v1/inbox"), resolvingAgainstBaseURL: false)!
    reconstructed.queryItems = [.init(name: "accountId", value: "account"), .init(name: "view", value: "all"), .init(name: "sender", value: "needle+nav@example.com")]
    let original = server.first
    let raw = actual.first?.rawPercentEncodedQuery
    check("NAV-DIAG-original-wire-evidence-complete", actual.count == 5 && server.count == 5 && raw != nil && raw == reconstructed.percentEncodedQuery && raw == original?["rawPercentEncodedQuery"].text && actual.first?.sender == "needle+nav@example.com" && original?["status"].integer == 200 && original?["decodeFailed"].flag == false && original?["otherRowCount"].integer == 0, "actual original request and server raw query tied to a separately labeled URLComponents reconstruction; decoded sender and rows retained without asserting a hypothesis")
    check("NAV-DIAG-direct-wire-preserves-plus", server.dropFirst().first?["sender"].text == "needle+nav@example.com" && server.dropFirst().first?["rawPercentEncodedQuery"].text?.contains("%2B") == true && actual.dropFirst().first?.sender == "needle+nav@example.com", "explicitly encoded transport reaches the same API as a literal plus, not a space")
    check("NAV-DIAG-final-read-boundaries", snapshot["readRequests"].integer == 17 && snapshot["readDomainDML"].integer == 0 && snapshot["readAuthDML"].integer == 0 && snapshot["providerClientCalls"].integer == 0 && snapshot["outboundNetworkCalls"].integer == 0, "four extra read-only transport controls; original13-GET assertion remains before this suffix")
    let clientRecord = try JSONSerialization.jsonObject(with: JSONEncoder().encode(actual))
    let report: [String: Any] = ["scope": "fixed synthetic loopback sender transport only", "urlComponentsReconstructionPercentEncodedQuery": reconstructed.percentEncodedQuery ?? "", "actualRequestObservations": clientRecord]
    print("NATIVE_SYNTHETIC_SENDER_TRANSPORT " + String(decoding: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), as: UTF8.self))
}
