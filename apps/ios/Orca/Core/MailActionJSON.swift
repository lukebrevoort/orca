import Foundation

/// Preserve server-owned View definitions verbatim, including clauses this client cannot edit.
enum MailActionJSON: Codable {
    case object([String: MailActionJSON]), array([MailActionJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: Self].self) { self = .object(v) }
        else { self = .array(try c.decode([Self].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> Self { if case .object(let v) = self { return v[key] ?? .null }; return .null }
    var text: String? { if case .string(let v) = self { return v }; return nil }
    var integer: Int? { if case .number(let v) = self { return Int(exactly: v) }; return nil }
    var flag: Bool { if case .bool(let v) = self { return v }; return false }
    func keeping(_ keys: [String]) -> Self {
        guard case .object(let values) = self else { return .object([:]) }
        return .object(values.filter { keys.contains($0.key) })
    }
}

extension MailActionJSON {
    func setting(_ key: String, to value: Self) -> Self {
        guard case .object(var values) = self else { return .object([key: value]) }
        values[key] = value; return .object(values)
    }
}
