import Foundation

/// Validation at the new read-only catalog boundary. Existing Mail decoders
/// retain their contract; API320's strict nested schemas are mirrored here.
enum NativeMailWire {
    static func string(_ value: MailActionJSON) throws { _ = try NativeMailJSON.string(value, trim: false, nonempty: false) }
    static func nullable(_ value: MailActionJSON, _ check: (MailActionJSON) throws -> Void) throws { if case .null = value {} else { try check(value) } }
    static func score(_ value: MailActionJSON) throws { try nullable(value) { guard try NativeMailJSON.integer($0) <= 10 else { throw NativeMailJSON.invalid() } } }
    static func account(_ value: MailActionJSON) throws {
        let fields = try NativeMailJSON.object(value, required: ["id", "provider", "email", "displayName", "capabilities"], optional: ["avatarUrl"])
        for key in ["id", "email", "displayName"] { _ = try NativeMailJSON.string(value[key]) }
        _ = try NativeMailJSON.enumeration(value["provider"], ["gmail", "outlook"])
        if let avatar = fields["avatarUrl"] { try nullable(avatar, string) }
        _ = try NativeMailJSON.object(value["capabilities"], required: ["read", "draft", "send"])
        for key in ["read", "draft", "send"] { _ = try NativeMailJSON.boolean(value["capabilities"][key]) }
    }
    static func contact(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["name", "email"])
        try nullable(value["name"], string); try string(value["email"])
    }
    static func destination(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["destinationId", "source", "locked", "reason"])
        _ = try NativeMailJSON.string(value["destinationId"], max: 256)
        _ = try NativeMailJSON.enumeration(value["source"], ["safety_lock", "conversation", "sender", "advanced", "account", "legacy", "fallback"])
        _ = try NativeMailJSON.boolean(value["locked"]); try string(value["reason"])
    }
    static func choice(_ value: MailActionJSON) throws { try nullable(value) { _ = try NativeMailJSON.enumeration($0, ["important", "not_important"]) } }
    static func importance(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["effective", "source", "conversation", "inherited", "participantCounts", "preferences", "preferencesTruncated", "accountRevision"])
        for key in ["effective", "inherited"] { _ = try NativeMailJSON.enumeration(value[key], ["important", "not_important", "unreviewed"]) }
        _ = try NativeMailJSON.enumeration(value["source"], ["conversation", "participants", "unreviewed"])
        _ = try NativeMailJSON.object(value["conversation"], required: ["choice", "revision"])
        try choice(value["conversation"]["choice"]); _ = try NativeMailJSON.integer(value["conversation"]["revision"])
        _ = try NativeMailJSON.object(value["participantCounts"], required: ["important", "notImportant", "unreviewed", "total"])
        for key in ["important", "notImportant", "unreviewed", "total"] { _ = try NativeMailJSON.integer(value["participantCounts"][key]) }
        let preferences = try NativeMailJSON.array(value["preferences"])
        guard preferences.count <= 20 else { throw NativeMailJSON.invalid() }
        for preference in preferences {
            _ = try NativeMailJSON.object(preference, required: ["address", "choice", "revision"])
            try address(preference["address"])
            _ = try NativeMailJSON.enumeration(preference["choice"], ["important", "not_important"])
            _ = try NativeMailJSON.integer(preference["revision"])
        }
        _ = try NativeMailJSON.boolean(value["preferencesTruncated"]); _ = try NativeMailJSON.integer(value["accountRevision"])
    }
    static func address(_ value: MailActionJSON) throws {
        let text = try NativeMailJSON.string(value, max: 320)
        guard text.range(of: #"^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$"#, options: .regularExpression) != nil else { throw NativeMailJSON.invalid() }
    }
    static let classifications: Set<String> = ["likely_human", "automated_or_bulk", "uncertain", "unclassified"]
    static func assessment(_ value: MailActionJSON, effective: Bool) throws {
        let fields = try NativeMailJSON.object(value, required: Set<String>(["classification", "score", "reasonCodes", "classifierVersion"]).union(effective ? ["source"] : []), optional: effective ? ["userOverride"] : [])
        _ = try NativeMailJSON.enumeration(value["classification"], classifications); try score(value["score"])
        let codes = try NativeMailJSON.array(value["reasonCodes"])
        guard codes.count <= 12 else { throw NativeMailJSON.invalid() }
        for code in codes { _ = try NativeMailJSON.enumeration(code, ["sender_no_reply_pattern", "list_id_header", "list_unsubscribe_header", "bulk_precedence_header", "auto_submitted_header", "provider_bulk_signal", "provider_promotions_signal", "provider_transactional_signal", "reply_context", "direct_recipient", "conflicting_evidence", "insufficient_evidence", "user_message_override", "user_sender_address_override", "user_sender_domain_override"]) }
        try nullable(value["classifierVersion"]) { _ = try NativeMailJSON.string($0, max: 100) }
        if effective {
            _ = try NativeMailJSON.enumeration(value["source"], ["automatic_heuristic", "user_override"])
            if let override = fields["userOverride"] { try nullable(override, humanOverride) }
        }
    }
    static func humanOverride(_ value: MailActionJSON) throws {
        _ = try NativeMailJSON.object(value, required: ["id", "accountId", "target", "classification", "source", "createdAt", "updatedAt"])
        _ = try NativeMailJSON.string(value["id"]); _ = try NativeMailJSON.string(value["accountId"])
        _ = try NativeMailJSON.enumeration(value["classification"], classifications)
        _ = try NativeMailJSON.enumeration(value["source"], ["user_choice"])
        _ = try NativeMailJSON.date(value["createdAt"]); _ = try NativeMailJSON.date(value["updatedAt"])
        switch value["target"]["scope"].text {
        case "message":
            _ = try NativeMailJSON.object(value["target"], required: ["scope", "messageId"])
            _ = try NativeMailJSON.string(value["target"]["messageId"], max: 512)
        case "sender_address":
            _ = try NativeMailJSON.object(value["target"], required: ["scope", "address"]); try address(value["target"]["address"])
        case "sender_domain":
            _ = try NativeMailJSON.object(value["target"], required: ["scope", "domain"])
            let domain = try NativeMailJSON.string(value["target"]["domain"], max: 320)
            guard domain.range(of: #"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"#, options: [.regularExpression, .caseInsensitive]) != nil else { throw NativeMailJSON.invalid() }
        default: throw NativeMailJSON.invalid()
        }
    }
    static func classification(_ value: MailActionJSON) throws {
        let fields = try NativeMailJSON.object(value, required: ["automatic", "effective"], optional: ["userOverride"])
        try nullable(value["automatic"]) { try assessment($0, effective: false) }
        try assessment(value["effective"], effective: true)
        if let override = fields["userOverride"] { try nullable(override, humanOverride) }
    }
    static func message(_ value: MailActionJSON) throws {
        let fields = try NativeMailJSON.object(value, required: ["id", "accountId", "provider", "providerMessageId", "threadId", "from", "subject", "snippet", "receivedAt", "unread", "labels", "attentionBehavior", "humanSignal"], optional: ["destination", "importance", "humanClassification"])
        for key in ["id", "accountId", "providerMessageId", "threadId"] { _ = try NativeMailJSON.string(value[key]) }
        _ = try NativeMailJSON.enumeration(value["provider"], ["gmail", "outlook"])
        try contact(value["from"]); try string(value["subject"]); try string(value["snippet"])
        _ = try NativeMailJSON.date(value["receivedAt"]); _ = try NativeMailJSON.boolean(value["unread"])
        for label in try NativeMailJSON.array(value["labels"]) { _ = try NativeMailJSON.string(label) }
        _ = try NativeMailJSON.enumeration(value["attentionBehavior"], ["notify", "focus", "normal", "quiet", "hidden"])
        try score(value["humanSignal"])
        if let item = fields["destination"] { try destination(item) }
        if let item = fields["importance"] { try importance(item) }
        if let item = fields["humanClassification"] { try nullable(item, classification) }
    }
}
