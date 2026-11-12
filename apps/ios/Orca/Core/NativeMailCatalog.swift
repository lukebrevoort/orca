import Foundation
import CryptoKit

/// Native mirrors of the published read-only Organization wire. No URL authority.
enum NativeMailJSON {
    static func exact(_ left: String, _ right: String) -> Bool { left.utf8.elementsEqual(right.utf8) }
    static func invalid() -> Error { APIClient.ClientError.invalidResponse }
    static let jsWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func object(_ value: MailActionJSON, required: Set<String>, optional: Set<String> = []) throws -> [String: MailActionJSON] {
        guard case .object(let values) = value, required.isSubset(of: Set(values.keys)), Set(values.keys).isSubset(of: required.union(optional)) else { throw invalid() }
        return values
    }
    static func string(_ value: MailActionJSON, max: Int? = nil, trim: Bool = true, nonempty: Bool = true) throws -> String {
        guard let text = value.text else { throw invalid() }
        let result = trim ? text.trimmingCharacters(in: jsWhitespace) : text
        guard (!nonempty || !result.isEmpty), max.map({ result.utf16.count <= $0 }) ?? true else { throw invalid() }
        return result
    }
    static func integer(_ value: MailActionJSON, minimum: Int = 0) throws -> Int {
        guard let number = value.integer, number >= minimum, number <= 9_007_199_254_740_991 else { throw invalid() }; return number
    }
    static func boolean(_ value: MailActionJSON) throws -> Bool { guard case .bool(let v) = value else { throw invalid() }; return v }
    static func array(_ value: MailActionJSON) throws -> [MailActionJSON] { guard case .array(let v) = value else { throw invalid() }; return v }
    static func strings(_ value: MailActionJSON) throws -> [String] {
        let values = try array(value).map { try string($0) }
        guard Set(values).count == values.count else { throw invalid() }; return values
    }
    static func enumeration(_ value: MailActionJSON, _ values: Set<String>) throws -> String {
        let text = try string(value, trim: false); guard values.contains(text) else { throw invalid() }; return text
    }
    static func color(_ value: MailActionJSON) throws -> String {
        let text = try string(value); guard text.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { throw invalid() }; return text
    }
    static func date(_ value: MailActionJSON) throws -> String {
        let text = try string(value, trim: false)
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var parsed = parser.date(from: text)
        if parsed == nil { parser.formatOptions = [.withInternetDateTime]; parsed = parser.date(from: text) }
        guard text.hasSuffix("Z"), parsed != nil else { throw invalid() }; return text
    }
    static func nullableString(_ value: MailActionJSON) throws -> String? { if case .null = value { return nil }; return try string(value, trim: false) }
    static func decode<T: Decodable>(_ type: T.Type, _ value: MailActionJSON) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(value)) }
    // JS JSON.stringify rules for this definition's fixed ASCII keys and String
    // values. In particular, slash and Unicode scalar values stay unescaped.
    static func quote(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x0c: result += "\\f"
            case 0x0a: result += "\\n"
            case 0x0d: result += "\\r"
            case 0x09: result += "\\t"
            case 0..<0x20: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        return result + "\""
    }
    static func digest(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    static func tuple(_ values: [String]) -> String { "[" + values.map(quote).joined(separator: ",") + "]" }
}

struct NativeMailIdentity: Hashable, Codable, Identifiable {
    enum Kind: String, Codable { case utility, space, collection, savedView, pin }
    var kind: Kind; var opaqueID: String; var accountID: String?
    var validForInternalNavigation: Bool {
        switch kind {
        case .utility: return accountID == nil && ["important", "all", "normal", "focus"].contains(opaqueID)
        case .space, .savedView: return accountID == nil && !opaqueID.isEmpty
        case .collection, .pin: return accountID != nil && !opaqueID.isEmpty
        }
    }
    var id: String { selectionID }
    static func == (left: Self, right: Self) -> Bool {
        left.kind == right.kind && NativeMailJSON.exact(left.opaqueID, right.opaqueID)
            && ((left.accountID == nil && right.accountID == nil) || (left.accountID != nil && right.accountID != nil && NativeMailJSON.exact(left.accountID!, right.accountID!)))
    }
    func hash(into hasher: inout Hasher) { hasher.combine(kind); hasher.combine(Data(opaqueID.utf8)); hasher.combine(accountID.map { Data($0.utf8) }) }
    var selectionID: String {
        switch kind {
        case .utility: return opaqueID
        case .space: return "destination:" + opaqueID
        case .savedView: return "view:" + opaqueID
        case .collection, .pin:
            return kind.rawValue + ":" + Data(NativeMailJSON.tuple([accountID ?? "", opaqueID]).utf8).base64EncodedString()
        }
    }
}

struct NativeSavedQueryDefinition {
    let filters: [String: String]
    var profile: String { filters["dataSource"] == "stored_mail" ? "stored-mail-v1" : "legacy-pin-v1" }
    var canonical: String { "{\"filters\":{" + filters.keys.sorted().map { NativeMailJSON.quote($0) + ":" + NativeMailJSON.quote(filters[$0]!) }.joined(separator: ",") + "},\"revision\":1}" }
    var digest: String { NativeMailJSON.digest(canonical) }
    init(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["revision", "filters"])
        guard try NativeMailJSON.integer(value["revision"], minimum: 1) == 1 else { throw NativeMailJSON.invalid() }
        let raw = try NativeMailJSON.object(value["filters"], required: [], optional: ["mailbox", "attention", "classification", "text", "sender", "accountId", "collectionId", "dataSource"])
        var parsed = [String: String]()
        for (key, input) in raw {
            switch key {
            case "mailbox": parsed[key] = try NativeMailJSON.enumeration(input, ["inbox", "focus", "quiet", "hidden", "all"])
            case "attention": parsed[key] = try NativeMailJSON.enumeration(input, ["all", "notify", "focus", "normal"])
            case "classification": parsed[key] = try NativeMailJSON.enumeration(input, ["human", "tideline", "uncertain", "all"])
            case "dataSource": parsed[key] = try NativeMailJSON.enumeration(input, ["stored_mail"])
            default: parsed[key] = try NativeMailJSON.string(input, max: key == "text" ? 200 : key == "sender" ? 320 : nil)
            }
        }
        guard (parsed["mailbox"] == nil) == (parsed["attention"] == nil) else { throw NativeMailJSON.invalid() }
        if parsed["mailbox"] == "inbox", parsed["attention"] == "all" { parsed.removeValue(forKey: "mailbox"); parsed.removeValue(forKey: "attention") }
        filters = parsed
    }
}

struct NativeSavedQuery {
    let id: String; let accountID: String; let name: String; let revision: Int; let definition: NativeSavedQueryDefinition
    init(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["id", "accountId", "name", "definition", "revision"])
        id = try NativeMailJSON.string(value["id"]); accountID = try NativeMailJSON.string(value["accountId"])
        name = try NativeMailJSON.string(value["name"], max: 120); revision = try NativeMailJSON.integer(value["revision"], minimum: 1)
        definition = try NativeSavedQueryDefinition(value["definition"])
    }
}

struct NativeCollection {
    let id: String; let accountID: String; let name: String; let revision: Int; let position: Int; let threadIDs: [String]; let color: String
    var identity: NativeMailIdentity { .init(kind: .collection, opaqueID: id, accountID: accountID) }
    init(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["id", "accountId", "name", "color", "position", "threadIds", "revision", "createdAt", "updatedAt"])
        id = try NativeMailJSON.string(value["id"]); accountID = try NativeMailJSON.string(value["accountId"])
        name = try NativeMailJSON.string(value["name"], max: 80); color = try NativeMailJSON.color(value["color"])
        position = try NativeMailJSON.integer(value["position"]); revision = try NativeMailJSON.integer(value["revision"], minimum: 1)
        threadIDs = try NativeMailJSON.strings(value["threadIds"])
        _ = try NativeMailJSON.date(value["createdAt"]); _ = try NativeMailJSON.date(value["updatedAt"])
    }
}

enum NativePinTarget {
    enum LegacyMailbox: String { case inbox, focus, quiet, hidden, all }
    case thread(String), mailbox(LegacyMailbox), collection(String), sender(String), query(String)
    init(_ value: MailActionJSON) throws {
        switch value["type"].text {
        case "query":
            _ = try NativeMailJSON.object(value, required: ["type", "queryId"])
            self = .query(try NativeMailJSON.string(value["queryId"]))
        case "resource":
            _ = try NativeMailJSON.object(value, required: ["type", "resource"])
            _ = try NativeMailJSON.object(value["resource"], required: ["family", "id"])
            let id = try NativeMailJSON.string(value["resource"]["id"])
            switch value["resource"]["family"].text {
            case "thread": self = .thread(id)
            case "view": guard let mailbox = LegacyMailbox(rawValue: id) else { throw NativeMailJSON.invalid() }; self = .mailbox(mailbox)
            case "collection": self = .collection(id)
            case "sender":
                guard id.utf16.count <= 320, id.range(of: #"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$"#, options: .regularExpression) != nil else { throw NativeMailJSON.invalid() }
                self = .sender(id)
            default: throw NativeMailJSON.invalid()
            }
        default: throw NativeMailJSON.invalid()
        }
    }
}

struct NativePin {
    let id: String; let accountID: String; let label: String; let revision: Int; let position: Int; let target: NativePinTarget; let icon: String; let color: String
    var identity: NativeMailIdentity { .init(kind: .pin, opaqueID: id, accountID: accountID) }
    var symbol: String { ["person": "person.crop.circle", "thread": "bubble.left.and.bubble.right", "search": "magnifyingglass", "grid": "square.grid.2x2", "star": "star", "bolt": "bolt", "heart": "heart", "bookmark": "bookmark"][icon] ?? "bookmark" }
    var kindDescription: String {
        switch target { case .thread: return "Conversation"; case .mailbox: return "Mailbox"; case .collection: return "Collection"; case .sender: return "Sender name/address match"; case .query: return "Saved query" }
    }
    init(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["id", "accountId", "label", "icon", "color", "position", "target", "revision", "createdAt", "updatedAt"])
        id = try NativeMailJSON.string(value["id"]); accountID = try NativeMailJSON.string(value["accountId"])
        label = try NativeMailJSON.string(value["label"], max: 120); revision = try NativeMailJSON.integer(value["revision"], minimum: 1); position = try NativeMailJSON.integer(value["position"])
        icon = try NativeMailJSON.enumeration(value["icon"], ["person", "thread", "search", "grid", "star", "bolt", "heart", "bookmark"])
        color = try NativeMailJSON.color(value["color"]); _ = try NativeMailJSON.date(value["createdAt"]); _ = try NativeMailJSON.date(value["updatedAt"])
        target = try NativePinTarget(value["target"])
    }
}

struct NativeMailCatalog {
    let workspaceID: String; let accountIDs: [String]
    let collections: [NativeCollection]; let pins: [NativePin]; let queries: [NativeSavedQuery]
    init(_ value: MailActionJSON, owner: String, account: String, ownedAccounts: Set<String>) throws {
        _ = try NativeMailJSON.object(value, required: ["workspaceId", "accountIds", "collections", "pins", "queries"])
        workspaceID = try NativeMailJSON.string(value["workspaceId"]); accountIDs = try NativeMailJSON.strings(value["accountIds"])
        collections = try NativeMailJSON.array(value["collections"]).map(NativeCollection.init)
        pins = try NativeMailJSON.array(value["pins"]).map(NativePin.init)
        queries = try NativeMailJSON.array(value["queries"]).map(NativeSavedQuery.init)
        guard NativeMailJSON.exact(workspaceID, owner), accountIDs.count == 1, NativeMailJSON.exact(accountIDs[0], account), ownedAccounts.contains(account),
              collections.allSatisfy({ $0.accountID == account }), pins.allSatisfy({ $0.accountID == account }), queries.allSatisfy({ $0.accountID == account }),
              Set(collections.map(\.id)).count == collections.count, Set(pins.map(\.id)).count == pins.count,
              Set(queries.map(\.id)).count == queries.count else { throw NativeMailJSON.invalid() }
    }
}

struct NativeSpace: Identifiable {
    let id: String; let name: String; let revision: Int; let retired: Bool
    var identity: NativeMailIdentity { .init(kind: .space, opaqueID: id) }
}
struct NativeSpaceCatalog {
    let revision: Int; let spaces: [NativeSpace]; let options: [MailboxOption]
    init(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["revision", "fallbackDestinationId", "legacyDestinationIds", "destinations"])
        revision = try NativeMailJSON.integer(value["revision"], minimum: 1)
        let fallback = try NativeMailJSON.string(value["fallbackDestinationId"], max: 256)
        let legacy = try NativeMailJSON.object(value["legacyDestinationIds"], required: ["normal"], optional: ["focus", "quiet", "notify", "hidden"])
        for item in legacy.values { _ = try NativeMailJSON.string(item, max: 256) }
        spaces = try NativeMailJSON.array(value["destinations"]).map { item in
            _ = try NativeMailJSON.object(item, required: ["id", "isFallback", "name", "position", "retiredAt", "revision", "notificationPreference", "delivery", "counts"], optional: ["color"])
            let id = try NativeMailJSON.string(item["id"], max: 256)
            _ = try NativeMailJSON.boolean(item["isFallback"])
            let name = try NativeMailJSON.string(item["name"], trim: false, nonempty: false)
            // Position is an integer in this published catalog, including legacy negatives.
            guard item["position"].integer != nil else { throw NativeMailJSON.invalid() }
            if case .object(let object) = item, object["color"] != nil { _ = try NativeMailJSON.color(item["color"]) }
            _ = try NativeMailJSON.enumeration(item["notificationPreference"], ["notify", "badge", "quiet"])
            _ = try NativeMailJSON.enumeration(item["delivery"], ["proposal_only"])
            _ = try NativeMailJSON.object(item["counts"], required: ["total", "unread"])
            _ = try NativeMailJSON.integer(item["counts"]["total"]); _ = try NativeMailJSON.integer(item["counts"]["unread"])
            try NativeMailWire.nullable(item["retiredAt"], NativeMailWire.string)
            return NativeSpace(id: id, name: name, revision: try NativeMailJSON.integer(item["revision"], minimum: 1), retired: { if case .null = item["retiredAt"] { return false }; return true }())
        }
        options = NativeMailboxProjection.destinations(routing: value) ?? []
        guard Set(spaces.map(\.id)).count == spaces.count, spaces.contains(where: { $0.id == fallback && !$0.retired }) else { throw NativeMailJSON.invalid() }
    }
}

/// Captured from the verified AppState identity and its real connection epoch.
/// This is a local request/cache boundary, never a replacement credential.
struct NativeMailContext: Hashable {
    let origin: String; let userID: String; let accountID: String; let connection: UUID
    let ownedAccountIDs: Set<String>
    var owner: String { origin + "|" + userID }
    var key: String { NativeMailJSON.tuple([origin, userID, accountID, connection.uuidString] + ownedAccountIDs.sorted()) }
    static func == (left: Self, right: Self) -> Bool { NativeMailJSON.exact(left.key, right.key) }
    func hash(into hasher: inout Hasher) { hasher.combine(Data(key.utf8)) }
}

struct NativeMailRoute: Identifiable {
    enum Target { case inbox(view: String?, destination: String?, collection: String?, sender: String?), query(NativeSavedQuery), thread(String) }
    let identity: NativeMailIdentity; let title: String; let subtitle: String; let revision: Int; let provenance: String; let target: Target
    var id: String { identity.selectionID }
    var fingerprint: String { NativeMailJSON.tuple([id, String(revision), provenance]) }
    static func collection(_ collection: NativeCollection) -> Self {
        .init(identity: collection.identity, title: collection.name, subtitle: "Collection · mail in this account", revision: collection.revision,
              provenance: NativeMailJSON.tuple(collection.threadIDs), target: .inbox(view: "all", destination: nil, collection: collection.id, sender: nil))
    }
    static func pin(_ pin: NativePin, catalog: NativeMailCatalog) -> Self? {
        let target: Target; let detail: String; let provenance: String
        switch pin.target {
        case .thread(let id): target = .thread(id); detail = "Pinned conversation"; provenance = id
        case .mailbox(let mailbox):
            target = .inbox(view: mailbox == .inbox ? nil : mailbox.rawValue, destination: nil, collection: nil, sender: nil)
            detail = "Pinned mailbox · " + mailbox.rawValue; provenance = mailbox.rawValue
        case .collection(let id):
            guard let collection = catalog.collections.first(where: { $0.id == id }) else { return nil }
            target = .inbox(view: "all", destination: nil, collection: id, sender: nil)
            detail = "Pinned collection · " + collection.name; provenance = NativeMailJSON.tuple([id, String(collection.revision)] + collection.threadIDs)
        case .sender(let sender):
            target = .inbox(view: "all", destination: nil, collection: nil, sender: sender)
            detail = "Sender name/address contains “\(sender)”"; provenance = sender
        case .query(let id):
            guard let query = catalog.queries.first(where: { $0.id == id }) else { return nil }
            target = .query(query); detail = "Saved query · " + query.name
            provenance = NativeMailJSON.tuple([id, String(query.revision), query.definition.digest, query.definition.profile])
        }
        return .init(identity: pin.identity, title: pin.label, subtitle: detail, revision: pin.revision, provenance: provenance, target: target)
    }
}

/// Strict validation of the additive API320 page before publishing/caching.
struct NativeSavedQueryPage {
    let raw: MailActionJSON; let messages: [InboxMessage]; let cursor: String?; let freshness: Freshness
    init(_ raw: MailActionJSON, query: NativeSavedQuery, account: String, limit: Int) throws {
        _ = try NativeMailJSON.object(raw, required: ["query", "accounts", "messages", "nextCursor", "freshness"])
        _ = try NativeMailJSON.object(raw["query"], required: ["id", "accountId", "revision", "definitionDigest", "evaluationProfile"])
        let metadata = raw["query"]
        guard try NativeMailJSON.string(metadata["id"], trim: false) == query.id,
              try NativeMailJSON.string(metadata["accountId"], trim: false) == account,
              try NativeMailJSON.integer(metadata["revision"], minimum: 1) == query.revision,
              try NativeMailJSON.string(metadata["definitionDigest"], trim: false) == query.definition.digest,
              try NativeMailJSON.enumeration(metadata["evaluationProfile"], ["stored-mail-v1", "legacy-pin-v1"]) == query.definition.profile else {
            throw APIClient.ClientError.http(409, APIErrorBody(code: "native_query_changed", message: "This saved query changed. Reload its catalog before reading more.", retryable: true))
        }
        let accounts = try NativeMailJSON.array(raw["accounts"])
        guard accounts.count == 1 else { throw NativeMailJSON.invalid() }
        try NativeMailWire.account(accounts[0])
        guard accounts[0]["id"].text == account else { throw NativeMailJSON.invalid() }
        let rows = try NativeMailJSON.array(raw["messages"])
        guard rows.count <= min(100, limit) else { throw NativeMailJSON.invalid() }
        for row in rows { try NativeMailWire.message(row); guard row["accountId"].text == account, row["provider"].text == accounts[0]["provider"].text else { throw NativeMailJSON.invalid() } }
        let parsed = try rows.map { try NativeMailJSON.decode(InboxMessage.self, $0) }
        guard Set(parsed.map(\.id)).count == parsed.count else { throw NativeMailJSON.invalid() }
        _ = try NativeMailJSON.object(raw["freshness"], required: ["revision", "lastSyncedAt"])
        let revision = try NativeMailJSON.string(raw["freshness"]["revision"], trim: false)
        guard revision.range(of: "^mailbox-v[12]:[0-9a-f]{64}$", options: .regularExpression) != nil else { throw NativeMailJSON.invalid() }
        if case .null = raw["freshness"]["lastSyncedAt"] {} else { _ = try NativeMailJSON.date(raw["freshness"]["lastSyncedAt"]) }
        self.raw = raw; messages = parsed; cursor = try NativeMailJSON.nullableString(raw["nextCursor"])
        freshness = .init(revision: revision, lastSyncedAt: raw["freshness"]["lastSyncedAt"].text)
    }
}

/// Internal, owner-bound navigation only. This is not an incoming URL format.
struct NativeMailIntent {
    let identity: NativeMailIdentity; let context: NativeMailContext
}
struct NativeMailBackContext {
    let context: NativeMailContext; let selection: String; let readerAccount: String
    func mayRestore(current: NativeMailContext?, currentReaderAccount: String?) -> Bool {
        guard let current else { return false }
        return NativeMailJSON.exact(context.origin, current.origin) && NativeMailJSON.exact(context.userID, current.userID) && context.connection == current.connection
            && current.ownedAccountIDs.contains(where: { NativeMailJSON.exact($0, context.accountID) }) && currentReaderAccount.map { NativeMailJSON.exact($0, readerAccount) } == true
    }
}

extension NativeMailboxProjection {
    static func groups(destinations: [MailboxOption], views: [SavedMailboxView], enabledIDs: Set<String>, hiddenIDs: Set<String>, catalog: NativeMailCatalog?) -> [NativeMailboxGroup] {
        let utilities = options(destinations: [], views: [], enabledIDs: enabledIDs)
        return [
            .init(id: "fixed", title: "Mail", options: Array(utilities.prefix(2))),
            .init(id: "inbox", title: "Inbox", options: Array(utilities.dropFirst(2))),
            .init(id: "spaces", title: "Spaces", options: destinations.filter { !hiddenIDs.contains($0.id) }),
            .init(id: "collections", title: "Collections", options: catalog?.collections.filter { !hiddenIDs.contains($0.identity.selectionID) }.map { .init(id: $0.identity.selectionID, name: $0.name, detail: "Collection", symbol: "tray.full") } ?? []),
            .init(id: "views", title: "Saved views", options: views.filter { enabledIDs.contains($0.selectionID) }.map { .init(id: $0.selectionID, name: $0.name) }),
            .init(id: "pins", title: "Pins", options: catalog?.pins.filter { !hiddenIDs.contains($0.identity.selectionID) }.map { .init(id: $0.identity.selectionID, name: $0.label, detail: $0.kindDescription, symbol: $0.symbol) } ?? [])
        ]
    }
    static func hidden(destinations: [MailboxOption], views: [SavedMailboxView], enabledIDs: Set<String>, hiddenIDs: Set<String>, catalog: NativeMailCatalog?) -> [MailboxOption] {
        var result: [MailboxOption] = enabledIDs.contains("focus") ? [] : [MailboxOption(id: "focus", name: "Inbox focus")]
        result.append(contentsOf: destinations.filter { hiddenIDs.contains($0.id) })
        let collections: [MailboxOption] = catalog?.collections.filter { hiddenIDs.contains($0.identity.selectionID) }.map { MailboxOption(id: $0.identity.selectionID, name: $0.name) } ?? []
        result.append(contentsOf: collections)
        result.append(contentsOf: views.filter { !enabledIDs.contains($0.selectionID) }.map { MailboxOption(id: $0.selectionID, name: $0.name) })
        let pins: [MailboxOption] = catalog?.pins.filter { hiddenIDs.contains($0.identity.selectionID) }.map { MailboxOption(id: $0.identity.selectionID, name: $0.label) } ?? []
        result.append(contentsOf: pins)
        return result
    }
}
