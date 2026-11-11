import SwiftUI

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
    @State private var destination = ""
    @State private var senderScope = false
    @State private var busy = false
    @State private var loading = true
    @State private var presented = true
    @State private var error: String?
    @State private var scope = ""
    @State private var resolvedMessage: InboxMessage?
    private var message: InboxMessage { resolvedMessage ?? target.message }
    private var current: Bool { presented && scope == state.ownerScope && state.phase == .ready && !Task.isCancelled }

    var body: some View {
        Group {
            if target.mode == .view { NativeSenderViewChooser(target: target) }
            else { moveBody }
        }
    }
    private var moveBody: some View {
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
                }
                if busy || loading { ProgressView("Working…") }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                        if catalog == nil && target.mode == .move { Button("Try again") { Task { await load() } } }
                    }
                }
            }
            .disabled(busy || loading)
            .navigationTitle(target.mode == .move ? "Move mail" : "Use sender in View")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { presented = false; dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .task { presented = true; await load() }
            .onDisappear { presented = false }
            .onChange(of: state.ownerScope) { presented = false; dismiss() }
        }
    }

    private func load() async {
        scope = state.ownerScope; loading = true; error = nil
        defer { loading = false }
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
                guard current else { return }
                let routing: MailActionJSON = try await client.request("v1/destinations/routing", query: [.init(name: "accountId", value: message.accountId), .init(name: "threadId", value: message.threadId)])
                guard current else { return }
                self.catalog = catalog; self.routing = routing
                destination = routing["selection"]["effective"]["destinationId"].text ?? catalog["legacyDestinationIds"]["normal"].text ?? ""
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

}

/// Chooses only the source/target. All preview, refinement, Save and recovery
/// use the same durable editor as search and existing saved Views.
private struct NativeSenderViewChooser: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    let target: MailActionTarget
    @State private var message: InboxMessage?
    @State private var views = [SavedMailboxView]()
    @State private var targetID = ""
    @State private var name = ""
    @State private var selection: NativeViewSelection?
    @State private var loading = false
    @State private var error: String?
    @State private var presented = true
    var body: some View {
        NavigationStack {
            Form {
                if let message {
                    Section("Selected sender") {
                        Text(message.from.name ?? message.from.email).font(.headline)
                        Text(message.from.email).textSelection(.enabled)
                        Text(state.accounts.first(where: { $0.id == message.accountId })?.email ?? "Account unavailable")
                        Text("Preview existing and future mail from this sender in this account. This does not change conversation importance or move this conversation.").font(.subheadline)
                    }
                    Section("View") {
                        Picker("Use sender in", selection: $targetID) {
                            Text("New View").tag("")
                            ForEach(views) { Text($0.name).tag($0.id) }
                        }.accessibilityIdentifier("mail-action.view")
                        if targetID.isEmpty { TextField("View name", text: $name).accessibilityIdentifier("mail-action.name") }
                        Button("Review and refine View") {
                            selection = .init(viewId: targetID.isEmpty ? nil : targetID, accountId: message.accountId,
                                              senderReferences: [.init(accountId: message.accountId, threadId: message.threadId, messageId: message.id)],
                                              suggestedName: name.trimmingCharacters(in: .whitespacesAndNewlines))
                        }.disabled(targetID.isEmpty && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("mail-action.preview")
                    }
                }
                if loading { ProgressView("Loading selected mail…") }
                if let error { Text(error).foregroundStyle(OrcaTheme.danger); Button("Try again") { Task { await load() } } }
            }.disabled(loading)
                .navigationTitle("Use sender in View").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { presented = false; dismiss() } } }
                .sheet(item: $selection) { selection in
                    NativeViewEditor(selection: selection, onSaved: { presented = false; dismiss() })
                }
                .task { presented = true; await load() }
                .onDisappear { presented = false }
                .onChange(of: state.ownerScope) { presented = false; dismiss() }
                .onChange(of: state.selectedAccountID) { presented = false; dismiss() }
        }
    }
    private func load() async {
        guard !loading else { return }
        guard let client = state.client, !state.demoMode else { error = "Connect an account to organize mail."; return }
        let owner = state.ownerScope, account = target.message.accountId
        func current() -> Bool { presented && !Task.isCancelled && state.phase == .ready && state.ownerScope == owner && state.client === client && state.selectedAccount?.id == account }
        guard current() else { return }; loading = true; error = nil
        defer { loading = false }
        do {
            var selected = target.message
            if target.resolveMessage {
                let detail = try await client.thread(selected.threadId, accountId: account)
                guard current() else { return }
                guard detail.account.id == account, detail.thread.id == selected.threadId,
                      let latest = detail.messages.max(by: { $0.receivedAt < $1.receivedAt }), latest.accountId == account else { throw APIClient.ClientError.invalidResponse }
                selected = InboxMessage(id: latest.id, accountId: latest.accountId, provider: latest.provider, providerMessageId: latest.providerMessageId, threadId: detail.thread.id, from: latest.from, subject: latest.subject, snippet: latest.snippet, receivedAt: latest.receivedAt, unread: latest.unread, labels: latest.labels, attentionBehavior: detail.thread.attention.attentionBehavior ?? "normal")
            }
            let catalog = try await client.mailboxViews()
            guard current() else { return }
            message = selected; views = catalog.items; name = String((selected.from.name ?? selected.from.email).prefix(120))
        } catch { if current() { self.error = error.localizedDescription } }
    }
}
