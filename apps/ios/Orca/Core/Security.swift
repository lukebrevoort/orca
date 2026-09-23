import AuthenticationServices
import CryptoKit
import Foundation
import Security

actor KeychainStore {
    private let service = "com.orca.mail.session"
    func read(origin: String) -> String? { var value: CFTypeRef?; guard SecItemCopyMatching(query(origin: origin, returning: true) as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }; return String(data: data, encoding: .utf8) }
    func save(_ token: String, origin: String) throws { let data = Data(token.utf8); SecItemDelete(query(origin: origin) as CFDictionary); let status = SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin, kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil); guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) } }
    func clear(origin: String) { SecItemDelete(query(origin: origin) as CFDictionary) }
    private func query(origin: String, returning: Bool = false) -> [String: Any] { var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: origin]; if returning { value[kSecReturnData as String] = true }; return value }
}

enum PKCE {
    static func verifier() -> String { base64(Data((0..<32).map { _ in UInt8.random(in: .min ... .max) })) }
    static func challenge(_ verifier: String) -> String { base64(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func state() -> String { UUID().uuidString }
    private static func base64(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}

@MainActor final class BrowserAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func authenticate(client: APIClient) async throws -> AuthExchange {
        let verifier = PKCE.verifier(), state = PKCE.state()
        struct Start: Encodable { var codeChallenge: String; var state: String }
        let start: AuthStart = try await client.request("v1/mobile/auth/start", method: "POST", body: Start(codeChallenge: PKCE.challenge(verifier), state: state))
        let callback: URL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            session = ASWebAuthenticationSession(url: start.authorizationUrl, callbackURLScheme: "orca") { url, error in if let error { continuation.resume(throwing: error) } else if let url { continuation.resume(returning: url) } }
            session?.presentationContextProvider = self; session?.prefersEphemeralWebBrowserSession = false; session?.start()
        }
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false), parts.queryItems?.first(where: { $0.name == "state" })?.value == state, let code = parts.queryItems?.first(where: { $0.name == "code" })?.value else { throw URLError(.userAuthenticationRequired) }
        struct Exchange: Encodable { var code: String; var codeVerifier: String }
        return try await client.request("v1/mobile/auth/exchange", method: "POST", body: Exchange(code: code, codeVerifier: verifier))
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor() }
}
