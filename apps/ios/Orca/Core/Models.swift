import Foundation

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
    var unread: Bool; var labels: [String]; var attentionBehavior: String; var humanSignal: Int?; var humanClassification: HumanClassification?
}
struct Freshness: Codable, Hashable { var revision: String; var lastSyncedAt: String? }
struct InboxCounts: Codable, Hashable { var focus: Int; var normal: Int; var quiet: Int; var hidden: Int; var all: Int }
struct InboxPage: Codable { var accounts: [MailAccount]; var messages: [InboxMessage]; var nextCursor: String?; var freshness: Freshness?; var counts: InboxCounts }
struct MailAttachment: Codable, Identifiable, Hashable { var id: String; var filename: String; var mimeType: String; var size: Int }
struct ThreadMessage: Codable, Identifiable, Hashable {
    var id: String; var accountId: String; var provider: String; var providerMessageId: String; var from: MailContact
    var to: [MailContact]; var cc: [MailContact]; var bcc: [MailContact]; var subject: String; var snippet: String
    var receivedAt: String; var unread: Bool; var labels: [String]; var bodyText: String?; var bodyHtml: String?
    var internetMessageId: String?; var references: [String]; var humanSignal: Int?; var humanClassification: HumanClassification?
    var attachments: [MailAttachment]
}
struct NormalizedThread: Codable, Hashable { var id: String; var provider: String; var providerThreadId: String; var subject: String; var latestReceivedAt: String; var messageCount: Int; var labels: [String]; var participants: [MailContact]; var readState: String; var attention: ThreadAttention }
struct ThreadAttention: Codable, Hashable { var attentionBehavior: String?; var hasUnread: Bool; var hasStarred: Bool; var hasDraft: Bool; var humanSignal: Int? }
struct ThreadDetail: Codable { var account: MailAccount; var thread: NormalizedThread; var messages: [ThreadMessage] }

struct Recipient: Codable, Hashable { var name: String?; var email: String }
struct DraftBody: Codable, Hashable { var text: String; var html: String? }
struct DraftContext: Codable, Hashable { var kind: String; var threadId: String; var messageId: String; var providerMessageId: String; var providerThreadId: String; var inReplyTo: String?; var references: [String] }
struct OutboundAttachment: Codable, Identifiable, Hashable { var id: String; var filename: String; var mimeType: String; var size: Int; var contentBase64: String? }
struct MessageDraft: Codable, Identifiable, Hashable {
    var id: String; var accountId: String; var to: [Recipient]; var cc: [Recipient]; var bcc: [Recipient]
    var subject: String; var body: DraftBody; var context: DraftContext?; var attachments: [OutboundAttachment]
    var revision: Int; var deliveryStatus: String; var providerSyncStatus: String; var providerSyncError: String?
    var providerDraftId: String?; var providerMessageId: String?; var providerThreadId: String?; var createdAt: String; var updatedAt: String
}
struct DraftContent: Codable, Hashable { var to = [Recipient](); var cc = [Recipient](); var bcc = [Recipient](); var subject = ""; var body = DraftBody(text: "", html: nil); var context: DraftContext?; var attachments = [OutboundAttachment]() }
struct DeliveryResult: Codable { var draftId: String; var status: String; var providerMessageId: String?; var providerThreadId: String?; var error: APIErrorBody? }
struct APIErrorBody: Codable, Error { var code: String; var message: String; var retryable: Bool? }
struct ErrorEnvelope: Codable { var error: APIErrorBody }
struct AuthStart: Codable { var authorizationUrl: URL }
struct AuthExchange: Codable { var accessToken: String; var expiresAt: String }
struct AuthUser: Codable { var id: String; var email: String; var name: String? }
struct AuthSession: Codable { var isAuthenticated: Bool; var user: AuthUser?; var expiresAt: String?; var onboardingCompletedAt: String? }
struct PushDevice: Codable, Identifiable { var installationId: String; var environment: String; var notificationMode: String; var generation: Int; var registeredAt: String; var lastSeenAt: String; var updatedAt: String; var disabledAt: String?; var disabledReason: String?; var id: String { installationId } }
struct PushStatus: Codable { var configured: Bool; var deliveryEnabled: Bool; var disabledReason: String?; var devices: [PushDevice] }
struct PushRegistration: Codable { struct Configuration: Codable { var configured: Bool; var disabledReason: String? }; var device: PushDevice; var push: Configuration }


enum MailDate {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
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
