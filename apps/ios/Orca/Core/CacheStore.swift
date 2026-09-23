import CryptoKit
import Foundation

actor CacheStore {
    private let root: URL
    init(directory: URL? = nil) { root = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "OrcaMail"); try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) }
    func save<T: Encodable>(_ value: T, key: String) throws { try JSONEncoder().encode(value).write(to: url(key), options: [.atomic, .completeFileProtection]) }
    func load<T: Decodable>(_ type: T.Type, key: String) -> T? { guard let data = try? Data(contentsOf: url(key)) else { return nil }; return try? JSONDecoder().decode(type, from: data) }
    private func url(_ key: String) -> URL { let hash = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined(); return root.appending(path: hash + ".json") }
}
