import Foundation

struct SavedMailboxView: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var description: String
    var revision: Int
    var position: Int? = nil
    var selectionID: String { "view:\(id)" }
}
struct SavedMailboxViewCatalog: Codable { var items: [SavedMailboxView]; var workspaceRevision: Int? = nil }
struct SavedViewThread: Codable, Identifiable, Hashable {
    var accountId: String; var accountEmail: String; var provider: String; var threadId: String
    var subject: String; var latestReceivedAt: String; var messageCount: Int; var readState: String; var sender: MailContact
    var id: String { "\(accountId)|\(threadId)" }
}
struct SavedViewPage: Codable {
    var viewId: String; var viewRevision: Int; var accountIds: [String]
    var items: [SavedViewThread]; var nextCursor: String?
}

struct MailContact: Codable, Hashable { var name: String?; var email: String }
struct MailCapabilities: Codable, Hashable { var read: Bool; var send: Bool; var draft: Bool }
struct MailAccount: Codable, Identifiable, Hashable {
    var id: String; var provider: String; var email: String; var displayName: String
    var avatarUrl: String?; var capabilities: MailCapabilities
}
struct HumanAssessment: Codable, Hashable { var classification: String; var score: Int?; var reasonCodes: [String] }
struct EffectiveAssessment: Codable, Hashable { var classification: String; var score: Int?; var reasonCodes: [String]; var source: String }
struct HumanClassification: Codable, Hashable { var automatic: HumanAssessment?; var effective: EffectiveAssessment }
struct InboxMessage: Codable, Identifiable, Hashable {
    var id: String; var accountId: String; var provider: String; var providerMessageId: String
    var threadId: String; var from: MailContact; var subject: String; var snippet: String; var receivedAt: String
    var unread: Bool; var labels: [String]; var attentionBehavior: String; var humanSignal: Int? = nil; var humanClassification: HumanClassification? = nil
    var importance: ImportanceResolution? = nil
}
struct Freshness: Codable, Hashable { var revision: String; var lastSyncedAt: String? }
struct InboxCounts: Codable, Hashable { var focus: Int; var normal: Int; var quiet: Int; var hidden: Int; var all: Int }
struct InboxPage: Codable { var accounts: [MailAccount]; var messages: [InboxMessage]; var nextCursor: String?; var freshness: Freshness?; var counts: InboxCounts }
struct MailAttachment: Codable, Identifiable, Hashable { var id: String; var filename: String; var mimeType: String; var size: Int }
struct ThreadMessage: Codable, Identifiable, Hashable {
    var id: String; var accountId: String; var provider: String; var providerMessageId: String; var from: MailContact
    var to: [MailContact]; var cc: [MailContact]; var bcc: [MailContact]; var subject: String; var snippet: String
    var receivedAt: String; var unread: Bool; var labels: [String]; var bodyText: String?; var bodyHtml: String?
    var imageLoadAvailable: Bool?; var imageSourceRevision: String?
    var internetMessageId: String?; var references: [String]; var humanSignal: Int?; var humanClassification: HumanClassification?
    var attachments: [MailAttachment]
}
struct NormalizedThread: Codable, Hashable { var id: String; var provider: String; var providerThreadId: String; var subject: String; var latestReceivedAt: String; var messageCount: Int; var labels: [String]; var participants: [MailContact]; var readState: String; var attention: ThreadAttention; var importance: ImportanceResolution? = nil }
struct ThreadAttention: Codable, Hashable { var attentionBehavior: String?; var hasUnread: Bool; var hasStarred: Bool; var hasDraft: Bool; var humanSignal: Int? }
struct ThreadDetail: Codable { var account: MailAccount; var thread: NormalizedThread; var messages: [ThreadMessage]; var importance: ImportanceResolution? = nil }
struct ThreadReadPage: Decodable {
    struct Entry: Decodable, Identifiable {
        enum Kind: String, Decodable { case message, unavailable }
        var kind: Kind; var id: String; var from: String?; var subject: String?; var receivedAt: String?
        var bodyText: String?; var bodyHtml: String?
    }
    var entries: [Entry]; var earlier: String?; var newer: String?; var importance: ImportanceResolution?
}

struct Recipient: Codable, Hashable {
    var name: String?; var email: String
    enum CodingKeys: String, CodingKey { case name, email }
    func encode(to encoder: Encoder) throws { var values = encoder.container(keyedBy: CodingKeys.self); if let name { try values.encode(name, forKey: .name) } else { try values.encodeNil(forKey: .name) }; try values.encode(email, forKey: .email) }
}
struct DraftBody: Codable, Hashable {
    var text: String; var html: String?
    enum CodingKeys: String, CodingKey { case text, html }
    func encode(to encoder: Encoder) throws { var values = encoder.container(keyedBy: CodingKeys.self); try values.encode(text, forKey: .text); if let html { try values.encode(html, forKey: .html) } else { try values.encodeNil(forKey: .html) } }
}
struct DraftContext: Codable, Hashable {
    var kind: String; var threadId: String; var messageId: String; var providerMessageId: String; var providerThreadId: String; var inReplyTo: String?; var references: [String]
    enum CodingKeys: String, CodingKey { case kind, threadId, messageId, providerMessageId, providerThreadId, inReplyTo, references }
    func encode(to encoder: Encoder) throws { var values = encoder.container(keyedBy: CodingKeys.self); try values.encode(kind, forKey: .kind); try values.encode(threadId, forKey: .threadId); try values.encode(messageId, forKey: .messageId); try values.encode(providerMessageId, forKey: .providerMessageId); try values.encode(providerThreadId, forKey: .providerThreadId); if let inReplyTo { try values.encode(inReplyTo, forKey: .inReplyTo) } else { try values.encodeNil(forKey: .inReplyTo) }; try values.encode(references, forKey: .references) }
}
struct OutboundAttachment: Codable, Identifiable, Hashable { var id: String; var filename: String; var mimeType: String; var size: Int; var contentBase64: String? }
struct MessageDraft: Codable, Identifiable, Hashable {
    var id: String; var accountId: String; var to: [Recipient]; var cc: [Recipient]; var bcc: [Recipient]
    var subject: String; var body: DraftBody; var context: DraftContext?; var attachments: [OutboundAttachment]
    var revision: Int; var deliveryStatus: String; var providerSyncStatus: String; var providerSyncError: String?
    var providerDraftId: String?; var providerMessageId: String?; var providerThreadId: String?; var createdAt: String; var updatedAt: String
}
struct DraftContent: Codable, Hashable { var to = [Recipient](); var cc = [Recipient](); var bcc = [Recipient](); var subject = ""; var body = DraftBody(text: "", html: nil); var context: DraftContext?; var attachments = [OutboundAttachment]() }
struct DeliveryResult: Codable { var draftId: String; var status: String; var providerMessageId: String?; var providerThreadId: String?; var error: APIErrorBody? }
struct APIErrorBody: Codable, Error { var code: String; var message: String; var retryable: Bool?; var currentRevision: Int? = nil }
struct ErrorEnvelope: Codable { var error: APIErrorBody }
struct AuthStart: Codable { var authorizationUrl: URL }
struct AuthExchange: Codable { var accessToken: String; var expiresAt: String }
struct AuthUser: Codable { var id: String; var email: String; var name: String? }
struct AuthSession: Codable { var isAuthenticated: Bool; var user: AuthUser?; var expiresAt: String?; var onboardingCompletedAt: String? }
struct NotificationSelection: Codable, Hashable {
    var inbox: Bool
    var spaceIds: [String]
    static let inboxOnly = NotificationSelection(inbox: true, spaceIds: [])
    static let off = NotificationSelection(inbox: false, spaceIds: [])
    var isEnabled: Bool { inbox || !spaceIds.isEmpty }
    func normalized(allowedSpaceIDs: Set<String>? = nil) -> NotificationSelection {
        var seen = Set<String>()
        let spaces = spaceIds.filter { id in
            guard !id.isEmpty, allowedSpaceIDs?.contains(id) ?? true else { return false }
            return seen.insert(id).inserted
        }.sorted()
        return NotificationSelection(inbox: inbox, spaceIds: spaces)
    }
}
struct NotificationSpace: Codable, Identifiable, Hashable {
    var id: String; var kind: String; var name: String; var color: String
    var kindLabel: String { switch kind { case "collection": "Collection"; case "view": "Saved view"; default: "Space" } }
}
struct NotificationCatalog: Codable { var defaultSelection: NotificationSelection; var spaces: [NotificationSpace] }
struct PushDevice: Codable, Identifiable { var installationId: String; var environment: String; var notificationSelection: NotificationSelection; var generation: Int; var registeredAt: String; var lastSeenAt: String; var updatedAt: String; var disabledAt: String?; var disabledReason: String?; var id: String { installationId } }
struct PushStatus: Codable { var configured: Bool; var deliveryEnabled: Bool; var disabledReason: String?; var devices: [PushDevice] }
struct PushRegistration: Codable { struct Configuration: Codable { var configured: Bool; var disabledReason: String? }; var device: PushDevice; var push: Configuration }


enum MailDate {
    // ISO8601DateFormatter is mutable and not Sendable. Keep both fixed-option
    // instances private and protect every use; no formatter escapes this owner.
    private final class Parser: @unchecked Sendable {
        private let lock = NSLock()
        private let fractional: ISO8601DateFormatter
        private let wholeSeconds: ISO8601DateFormatter

        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            wholeSeconds = ISO8601DateFormatter()
            wholeSeconds.formatOptions = [.withInternetDateTime]
        }

        func parse(_ value: String) -> Date? {
            lock.lock()
            defer { lock.unlock() }
            return fractional.date(from: value) ?? wholeSeconds.date(from: value)
        }
    }

    private static let parser = Parser()

    static func parse(_ value: String) -> Date? {
        parser.parse(value)
    }
    static func compact(_ value: String) -> String {
        guard let date = parse(value) else { return "" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    static func full(_ value: String) -> String {
        parse(value)?.formatted(date: .abbreviated, time: .shortened) ?? value
    }
}

// Feedback contains only deliberately supplied text and explicitly selected media.
struct FeedbackTicketInput: Codable, Equatable {
    var id = UUID().uuidString.lowercased()
    var message: String
    var platform = "ios"
    var attachments: [FeedbackAttachment]? = nil
}
struct FeedbackAttachment: Codable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var name: String
    var mimeType: String
    var dataUrl: String
    var size: Int
}
struct FeedbackTicketAvailability: Codable { var available: Bool }
struct FeedbackTicketReceipt: Codable, Equatable {
    var identifier: String
    var url: String
    var issueURL: URL? {
        guard let parsed = URL(string: url), parsed.scheme == "https",
              parsed.host == "linear.app", parsed.user == nil, parsed.password == nil else { return nil }
        return parsed
    }
}

// Mirrors packages/shared/src/importance.ts. No classifier, placement or sender heuristic.
enum ImportanceChoice: String, Codable, Hashable, CaseIterable {
    case important, notImportant = "not_important"
    var title: String { self == .important ? "Important" : "Not important" }
}
enum ImportanceEffective: String, Codable, Hashable {
    case important, notImportant = "not_important", unreviewed
    var title: String { switch self { case .important: "Important"; case .notImportant: "Not important"; case .unreviewed: "Unreviewed" } }
}
struct ImportanceStoredChoice: Codable, Hashable { var choice: ImportanceChoice?; var revision: Int }
struct ImportanceResolution: Codable, Hashable {
    struct Counts: Codable, Hashable { var important: Int; var notImportant: Int; var unreviewed: Int; var total: Int }
    struct Preference: Codable, Hashable { var address: String; var choice: ImportanceChoice; var revision: Int }
    var effective: ImportanceEffective; var source: String; var conversation: ImportanceStoredChoice
    var inherited: ImportanceEffective; var participantCounts: Counts; var preferences: [Preference]
    var preferencesTruncated: Bool; var accountRevision: Int
}
struct ImportanceTarget: Codable, Hashable {
    var kind: String; var threadId: String?; var address: String?
    static func conversation(_ id: String) -> Self { .init(kind: "conversation", threadId: id) }
    static func sender(_ address: String) -> Self { .init(kind: "sender", address: address) }
}
struct ImportanceCommand: Codable, Hashable {
    var accountId: String; var target: ImportanceTarget; var choice: ImportanceChoice?
    var expectedRevision: Int; var operationId = UUID().uuidString.lowercased(); var confirmation: String?
    enum CodingKeys: String, CodingKey { case accountId, target, choice, expectedRevision, operationId, confirmation }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accountId, forKey: .accountId); try c.encode(target, forKey: .target)
        // Null resets the explicit choice. An omitted key is not the same command.
        try c.encode(choice, forKey: .choice); try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encode(operationId, forKey: .operationId); try c.encodeIfPresent(confirmation, forKey: .confirmation)
    }
}
struct ImportanceReceipt: Codable, Hashable {
    var operationId: String; var accountId: String; var target: ImportanceTarget
    var choice: ImportanceChoice?; var previousChoice: ImportanceChoice?; var revision: Int; var undoUntil: String
}
struct ImportanceOperation: Codable {
    var status: String; var receipt: ImportanceReceipt; var current: ImportanceStoredChoice; var importance: ImportanceResolution?
}
struct ImportancePreview: Decodable {
    struct Distribution: Decodable { var important: Int; var not_important: Int; var unreviewed: Int }
    struct Existing: Decodable {
        var matching: Int; var overridden: Int; var changed: Int; var keptImportantByOtherParticipants: Int
        var before: Distribution; var after: Distribution
    }
    struct Future: Decodable { var accountId: String; var address: String; var preservesConversationOverrides: Bool; var otherImportantParticipantsMayKeepImportant: Bool; var exactAddressOnly: Bool }
    var accountId: String; var address: String; var choice: ImportanceChoice?; var current: ImportanceStoredChoice
    var accountRevision: Int; var confirmation: String; var expiresAt: String; var existing: Existing; var future: Future
}
struct ImportantPage: Codable {
    struct Item: Codable {
        var accountId: String; var threadId: String; var subject: String; var snippet: String; var from: String?
        var receivedAt: String; var unread: Bool; var importance: ImportanceResolution
        func row(provider: String) -> InboxMessage {
            .init(id: threadId, accountId: accountId, provider: provider, providerMessageId: "", threadId: threadId,
                  from: .init(email: from ?? "Unknown sender"), subject: subject, snippet: snippet, receivedAt: receivedAt,
                  unread: unread, labels: [], attentionBehavior: "normal", importance: importance)
        }
    }
    var accountId: String; var revision: Int; var items: [Item]; var nextCursor: String?
}
extension APIClient {
    func important(accountId: String, cursor: String? = nil) async throws -> ImportantPage {
        var query = [URLQueryItem(name: "accountId", value: accountId), .init(name: "limit", value: "30")]
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        return try await request("v1/important", query: query)
    }
    func importance(accountId: String, threadId: String) async throws -> ImportanceResolution {
        struct Envelope: Decodable { var accountId: String; var threadId: String; var importance: ImportanceResolution }
        let result: Envelope = try await request("v1/importance/conversations", pathSuffix: [threadId], query: [.init(name: "accountId", value: accountId)])
        guard result.accountId == accountId, result.threadId == threadId else { throw ClientError.invalidResponse }
        return result.importance
    }
    func chooseImportance(_ command: ImportanceCommand) async throws -> ImportanceOperation {
        try await request("v1/importance/choices", method: "POST", body: command)
    }
    func importanceOperation(accountId: String, operationId: String) async throws -> ImportanceOperation {
        try await request("v1/importance/operations", pathSuffix: [operationId], query: [.init(name: "accountId", value: accountId)])
    }
    func previewImportance(accountId: String, address: String, choice: ImportanceChoice?) async throws -> ImportancePreview {
        // Reuse the command encoder's explicit null semantics, without command-only fields.
        struct Body: Encodable {
            var accountId: String; var address: String; var choice: ImportanceChoice?
            enum CodingKeys: String, CodingKey { case accountId, address, choice }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(accountId, forKey: .accountId); try c.encode(address, forKey: .address); try c.encode(choice, forKey: .choice)
            }
        }
        let body = Body(accountId: accountId, address: address, choice: choice)
        return try await request("v1/importance/preview", method: "POST", body: body)
    }
    func undoImportance(_ receipt: ImportanceReceipt, operationId: String) async throws -> ImportanceOperation {
        struct Body: Encodable { var accountId: String; var operationId: String; var expectedRevision: Int }
        return try await request("v1/importance/operations", pathSuffix: [receipt.operationId, "undo"], method: "POST", body: Body(accountId: receipt.accountId, operationId: operationId, expectedRevision: receipt.revision))
    }
}

// BRE-455 contract source: 29e345e3; transport registration remains separate.
struct ImportantNotificationInstallation: Codable, Equatable {
    struct Policy: Codable, Equatable { var version: Int; var kind: String; var enabled: Bool; var accountIds: [String] }
    struct Delivery: Codable, Equatable { var available: Bool; var scope: String; var reason: String? }
    var installationId: String; var channel: String; var revision: Int; var policy: Policy?
    var permission: String; var previousSelection: NotificationSelection?; var delivery: Delivery; var cooldownSeconds: Int
}
struct ImportantNotificationCommand: Codable, Equatable {
    var channel = "apns"; var policyVersion = 1; var enabled: Bool; var accountIds: [String]
    var permission: String; var expectedRevision: Int; var operationId = UUID().uuidString.lowercased()
}
struct ImportantNotificationOperation: Decodable {
    var operationId: String; var status: String; var appliedRevision: Int; var current: ImportantNotificationInstallation
}
extension APIClient {
    func importantNotificationStatus(installationId: String) async throws -> ImportantNotificationInstallation {
        let value: ImportantNotificationInstallation = try await request("v1/notifications/installations", pathSuffix: [installationId], query: [.init(name: "channel", value: "apns")])
        guard value.installationId == installationId, value.channel == "apns", value.delivery.scope == "apns", value.cooldownSeconds == 900,
              value.policy == nil || (value.policy?.version == 1 && value.policy?.kind == "important_only") else { throw ClientError.invalidResponse }
        return value
    }
    func setImportantNotifications(installationId: String, command: ImportantNotificationCommand) async throws -> ImportantNotificationOperation {
        try await request("v1/notifications/installations", pathSuffix: [installationId], method: "PUT", body: command)
    }
    func importantNotificationOperation(_ id: String) async throws -> ImportantNotificationOperation {
        try await request("v1/notifications/operations", pathSuffix: [id])
    }
}
