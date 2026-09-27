import SwiftUI

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

struct MailActionTarget: Identifiable {
    var message: InboxMessage
    var mode: Mode
    var resolveMessage = false
    var id: String { message.id + mode.rawValue }
    enum Mode: String { case move, view }
}

struct MailActionMenu: View {
    var message: InboxMessage
    var resolveMessage = false
    var select: (MailActionTarget) -> Void
    var body: some View {
        Button { select(.init(message: message, mode: .move, resolveMessage: resolveMessage)) } label: { Label("Move mail…", systemImage: "tray.and.arrow.down") }
        Button { select(.init(message: message, mode: .view, resolveMessage: resolveMessage)) } label: { Label("Use sender in View…", systemImage: "rectangle.stack.badge.plus") }
    }
}

struct MailActionsSheet: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var mailboxes: MailboxViews
    @Environment(\.dismiss) private var dismiss
    let target: MailActionTarget
    let onChanged: () async -> Void
    @State private var catalog: MailActionJSON?
    @State private var routing: MailActionJSON?
    @State private var savedViews: [SavedMailboxView] = []
    @State private var destination = ""
    @State private var senderScope = false
    @State private var viewID = ""
    @State private var name = ""
    @State private var preview: MailActionJSON?
    @State private var retryKey = UUID().uuidString
    @State private var busy = true
    @State private var error: String?
    @State private var scope = ""
    @State private var resolvedMessage: InboxMessage?
    private var message: InboxMessage { resolvedMessage ?? target.message }
    private var current: Bool { scope == state.ownerScope && state.phase == .ready && !Task.isCancelled }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(message.subject).font(.headline)
                    Text(target.mode == .move
                         ? "Choose where this mail belongs and whether the choice applies to this conversation or its sender. Mail remains in All Mail."
                         : "Includes existing and future mail from \(message.from.email). This is a sender rule, not a move of just this conversation.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if target.mode == .move {
                    Section("Destination") {
                        Picker("Move to", selection: $destination) {
                            if case .array(let items) = catalog?["destinations"] {
                                ForEach(items.compactMap { item -> MailboxOption? in
                                    guard let id = item["id"].text, let name = item["name"].text, item["retiredAt"].text == nil else { return nil }
                                    return MailboxOption(id: id, name: name)
                                }) { Text($0.name).tag($0.id) }
                            }
                        }.accessibilityIdentifier("mail-action.destination")
                        Picker("Apply to", selection: $senderScope) {
                            Text("Just this conversation").tag(false)
                            Text("Mail from this sender").tag(true)
                        }.accessibilityIdentifier("mail-action.scope")
                        if senderScope {
                            Text("Existing and future mail from \(message.from.email), in this account only. Conversations with an explicit move or safety lock keep their current destination.").font(.caption).foregroundStyle(.secondary)
                        }
                        Text("Choose Inbox to take this conversation out of Focus. All Mail always includes it.").font(.caption).foregroundStyle(.secondary)
                        Button(senderScope ? "Move sender’s mail" : "Move conversation") { Task { await move() } }
                            .disabled(busy || destination.isEmpty || routing == nil)
                            .accessibilityIdentifier("mail-action.move")
                    }
                } else if let preview {
                    Section("Review sender rule") {
                        Text(preview["draft"]["summary"]["text"].text ?? "Sender-based View")
                        Text("\(preview["results"]["count"]["value"].integer ?? 0) matching conversations shown")
                        Text(preview["draft"]["skipInbox"].flag
                             ? "This View skips Inbox. Newly matching mail may leave Inbox, but remains in All Mail. Explicit conversation routing is preserved."
                             : "Your Inbox and Focus routing will not change.").font(.caption).foregroundStyle(.secondary)
                        if case .array(let notices) = preview["draft"]["preparationNotices"] {
                            ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in Text(notice["detail"].text ?? "").font(.caption) }
                        }
                        if !preview["draft"]["saveEligibility"]["allowed"].flag { Text(preview["draft"]["saveEligibility"]["detail"].text ?? "This View cannot be saved.") }
                        Button(preview["results"]["state"].text == "zero" ? "Save empty View" : "Save View") { Task { await saveView() } }
                            .disabled(busy || !preview["draft"]["saveEligibility"]["allowed"].flag)
                            .accessibilityIdentifier("mail-action.save-view")
                        Button("Edit choices") { self.preview = nil }.disabled(busy)
                    }
                } else {
                    Section("View") {
                        Picker("Use sender in", selection: $viewID) {
                            Text("New View").tag("")
                            ForEach(savedViews) { Text($0.name).tag($0.id) }
                        }.accessibilityIdentifier("mail-action.view")
                        if viewID.isEmpty { TextField("View name", text: $name).accessibilityIdentifier("mail-action.name") }
                        Button("Preview View") { Task { await prepareView() } }
                            .disabled(busy || (viewID.isEmpty && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                            .accessibilityIdentifier("mail-action.preview")
                    }
                }
                if busy { ProgressView("Working…") }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                        if catalog == nil && target.mode == .move { Button("Try again") { Task { await load() } } }
                    }
                }
            }
            .disabled(busy)
            .navigationTitle(target.mode == .move ? "Move mail" : "Use sender in View")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task { await load() }
            .onChange(of: state.ownerScope) { dismiss() }
        }
    }

    private func load() async {
        scope = state.ownerScope; busy = true; error = nil
        defer { busy = false }
        guard let client = state.client, !state.demoMode else { error = "Connect an account to organize mail."; return }
        do {
            if target.resolveMessage {
                let detail = try await client.thread(message.threadId, accountId: message.accountId)
                guard current else { return }
                guard let latest = detail.messages.max(by: { $0.receivedAt < $1.receivedAt }) else { throw APIClient.ClientError.invalidResponse }
                resolvedMessage = InboxMessage(id: latest.id, accountId: latest.accountId, provider: latest.provider, providerMessageId: latest.providerMessageId, threadId: detail.thread.id, from: latest.from, subject: latest.subject, snippet: latest.snippet, receivedAt: latest.receivedAt, unread: latest.unread, labels: latest.labels, attentionBehavior: detail.thread.attention.attentionBehavior ?? "normal", humanSignal: latest.humanSignal, humanClassification: latest.humanClassification)
            }
            if target.mode == .move {
                let catalog: MailActionJSON = try await client.request("v1/destinations")
                let routing: MailActionJSON = try await client.request("v1/destinations/routing", query: [.init(name: "accountId", value: message.accountId), .init(name: "threadId", value: message.threadId)])
                guard current else { return }
                self.catalog = catalog; self.routing = routing
                destination = routing["selection"]["effective"]["destinationId"].text ?? catalog["legacyDestinationIds"]["normal"].text ?? ""
            } else {
                let views = try await client.mailboxViews()
                guard current else { return }
                savedViews = views.items; name = String((message.from.name ?? message.from.email).prefix(120))
            }
        } catch { if current { self.error = error.localizedDescription } }
    }

    private func move() async {
        guard current, let client = state.client, let routing else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let _: MailActionJSON = try await client.request("v1/destinations/routing", method: "PUT", query: [.init(name: "accountId", value: message.accountId)], body: MailActionJSON.object([
                "expectedRevision": routing["revision"], "target": senderScope
                    ? .object(["scope": .string("sender"), "address": .string(message.from.email)])
                    : .object(["scope": .string("conversation"), "threadId": .string(message.threadId)]), "destinationId": .string(destination)
            ]))
            guard current else { return }; await onChanged(); dismiss()
        } catch { if current { self.error = error.localizedDescription } }
    }

    private func prepareView() async {
        guard current, let client = state.client else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let existing = savedViews.first { $0.id == viewID }
            var body: [String: MailActionJSON] = [
                "kind": .string("selected_senders"), "skipInbox": .bool(false),
                "source": .object(["kind": .string("sender_selection"), "label": .string("iOS mail long press")]),
                "identity": .object(["name": .string(existing?.name ?? name.trimmingCharacters(in: .whitespacesAndNewlines))]),
                "references": .array([.object(["accountId": .string(message.accountId), "threadId": .string(message.threadId), "messageId": .string(message.id)])])
            ]
            if let existing { body["targetView"] = .object(["id": .string(existing.id), "revision": .number(Double(existing.revision))]) }
            let prepared: MailActionJSON = try await client.request("v1/organization/views/prepare", method: "POST", body: MailActionJSON.object(body))
            guard current else { return }
            let input = prepared["draft"].keeping(["mode", "skipInbox", "viewId", "viewRevision", "source", "identity", "definition", "unsupportedClauses"])
            let result: MailActionJSON = try await client.request("v1/organization/views/preview", method: "POST", body: MailActionJSON.object(["draft": input, "page": .object(["limit": .number(25)])]))
            guard current else { return }; preview = result; retryKey = UUID().uuidString
        } catch { if current { self.error = error.localizedDescription } }
    }

    private func saveView() async {
        guard current, let client = state.client, let preview else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let result: MailActionJSON = try await client.request("v1/organization/views/commit", method: "POST", body: MailActionJSON.object([
                "draft": preview["draft"], "expectedRevisions": .object(["workspace": preview["workspaceRevision"], "view": preview["draft"]["viewRevision"]]),
                "retryKey": .string(retryKey), "confirmedZeroMatchDigest": preview["results"]["state"].text == "zero" ? preview["draft"]["definitionDigest"] : .null
            ]))
            guard current else { return }
            await mailboxes.load(state: state)
            guard current else { return }
            if let id = result["view"]["id"].text { mailboxes.setEnabled("view:" + id, true); mailboxes.selectedID = "view:" + id }
            dismiss()
        } catch { if current { self.error = error.localizedDescription } }
    }
}
