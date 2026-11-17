import SwiftUI

struct ImportanceSelection: Identifiable {
    var accountId: String; var threadId: String; var subject: String
    var id: String { accountId + "|" + threadId }
    init(_ message: InboxMessage) { accountId = message.accountId; threadId = message.threadId; subject = message.subject }
    init(accountId: String, threadId: String, subject: String) { self.accountId = accountId; self.threadId = threadId; self.subject = subject }
}

struct ImportanceView: View {
    @EnvironmentObject private var state: AppState
    @EnvironmentObject private var importance: ImportanceController
    @Environment(\.dismiss) private var dismiss
    let selection: ImportanceSelection
    @State private var senders = [String]()
    @State private var address = ""
    @State private var senderChoice: ImportanceChoice? = .important
    @State private var senderError: String?
    @State private var presented = true
    private var account: MailAccount? { state.accounts.first { $0.id == selection.accountId } }
    var body: some View {
        NavigationStack {
            Form {
                Section("This conversation") {
                    Text(selection.subject.isEmpty ? "(No subject)" : selection.subject).font(.headline).textSelection(.enabled)
                    Text(account?.email ?? "Account unavailable").textSelection(.enabled)
                    Text("Applies to this conversation, including later replies, in this account only. Does not move mail, mark it read or change sender preferences.").font(.subheadline)
                    if let snapshot = importance.snapshot {
                        LabeledContent("Current importance", value: snapshot.effective.title).accessibilityIdentifier("importance.current")
                        Text(snapshot.source == "conversation" ? "Your conversation choice takes precedence." : "Inherited from distinct incoming senders; Human Signal and mail placement are separate.").font(.caption)
                        Button("Important") { Task { await importance.choose(.important, state: state) } }.accessibilityIdentifier("importance.important")
                        Button("Not important") { Task { await importance.choose(.notImportant, state: state) } }.accessibilityIdentifier("importance.not-important")
                        if snapshot.conversation.choice != nil {
                            Button("Use current sender preferences") { Task { await importance.choose(nil, state: state) } }.accessibilityIdentifier("importance.reset")
                            Text("Removing your conversation choice currently inherits \(snapshot.inherited.title). It may remain Important.").font(.caption)
                        }
                        DisclosureGroup("Why this importance?") {
                            Text("\(snapshot.participantCounts.total) distinct incoming addresses: \(snapshot.participantCounts.important) Important, \(snapshot.participantCounts.notImportant) Not important, \(snapshot.participantCounts.unreviewed) Unreviewed.")
                            ForEach(snapshot.preferences, id: \.address) { item in Text(item.address + " · " + item.choice.title).textSelection(.enabled) }
                            if snapshot.preferencesTruncated { Text("Showing up to 20 saved sender preferences. Counts include all participants.") }
                        }.font(.caption)
                    } else if !importance.busy && !importance.uncertain {
                        Text("Importance is unavailable; no choice has been inferred.")
                        Button("Try again") { Task { await importance.refresh(state: state) } }
                    }
                }.disabled(importance.busy || importance.uncertain)
                if importance.busy { Section { ProgressView("Checking current importance…") } }
                if importance.uncertain {
                    Section("Save outcome unknown") {
                        Text(importance.originalTarget ?? "An earlier operation in this account needs reconciliation.").textSelection(.enabled)
                        Text("Check that original operation before making another choice in this account. Offline does not mean saved.")
                        Button("Check save outcome") { Task { await importance.reconcile(state: state) } }.accessibilityIdentifier("importance.reconcile")
                        Button("Retry original choice safely") { Task { await importance.retryOriginal(state: state) } }
                        Button("Review current choice") { Task { await importance.reviewCurrent(state: state) } }
                    }.disabled(importance.busy)
                }
                if let status = importance.status {
                    Section {
                        Text(status).accessibilityIdentifier("importance.status")
                        if let receipt = importance.receipt {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                if let until = MailDate.parse(receipt.undoUntil), until > context.date {
                                    Button("Undo last choice") { Task { await importance.undo(state: state) } }
                                        .disabled(!importance.canUndo).accessibilityIdentifier("importance.undo")
                                    Text("Available until \(until.formatted(date: .omitted, time: .shortened)), only while that exact choice is still current.").font(.caption)
                                } else { Text("Undo expired. You can still change the current choice directly.").font(.caption) }
                            }
                        }
                    }
                }
                if let error = importance.error { Section { Text(error).foregroundStyle(OrcaTheme.danger).accessibilityIdentifier("importance.error") } }
                Section("Sender preference — separate choice") {
                    Text("Review existing and future conversations from one exact address in this account. Conversation choices keep precedence; other Important participants can keep a conversation Important.").font(.subheadline)
                    if let preview = importance.preview {
                        Text(preview.address).font(.headline).textSelection(.enabled)
                        Text("\(preview.existing.matching) existing conversations match; \(preview.existing.changed) change importance; \(preview.existing.overridden) keep their conversation choices; \(preview.existing.keptImportantByOtherParticipants) stay Important through other senders.")
                        Text("After: \(preview.existing.after.important) Important, \(preview.existing.after.not_important) Not important, \(preview.existing.after.unreviewed) Unreviewed. Future mail: this exact address only, in \(account?.email ?? "this account"). No alias or domain expansion.")
                        Button("Confirm sender preference: \(preview.choice?.title ?? "Reset")") { Task { await importance.confirmSender(state: state) } }.accessibilityIdentifier("importance.confirm-sender")
                        Button("Cancel sender preview") { importance.cancelPreview() }
                    } else {
                        Picker("Exact sender", selection: $address) {
                            Text("Choose an address").tag("")
                            ForEach(senders, id: \.self) { Text($0).tag($0) }
                        }
                        Picker("Sender preference", selection: $senderChoice) {
                            Text("Important").tag(Optional(ImportanceChoice.important))
                            Text("Not important").tag(Optional(ImportanceChoice.notImportant))
                            Text("Reset sender preference").tag(ImportanceChoice?.none)
                        }
                        Button("Preview sender effects") { Task { await importance.prepareSender(address, choice: senderChoice, state: state) } }.disabled(address.isEmpty)
                            .accessibilityIdentifier("importance.preview-sender")
                        if let senderError { Text(senderError).font(.caption) }
                    }
                }.disabled(importance.busy || importance.uncertain)
            }
            .navigationTitle("Importance").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(importance.busy) } }
            .interactiveDismissDisabled(importance.busy)
            .task {
                presented = true
                await importance.open(state: state, accountId: selection.accountId, threadId: selection.threadId, subject: selection.subject)
                await loadSenders()
            }
            .onDisappear { presented = false }
            .onChange(of: state.ownerScope) { dismiss() }
            .onChange(of: state.selectedAccountID) { dismiss() }
        }
    }
    private func loadSenders() async {
        guard let client = state.client else { return }
        let scope = state.ownerScope
        do {
            let detail = try await client.thread(selection.threadId, accountId: selection.accountId)
            guard presented, !Task.isCancelled, scope == state.ownerScope, state.selectedAccount?.id == selection.accountId,
                  detail.account.id == selection.accountId, detail.thread.id == selection.threadId else { return }
            // These are selectable observed addresses, not a client-side importance resolver.
            // The fresh server preview decides whether each address is a known inbound participant.
            senders = Array(Set(detail.messages.map { $0.from.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty && $0 != detail.account.email.lowercased() })).sorted()
        } catch { if presented && scope == state.ownerScope { senderError = "Sender choices could not be loaded. Conversation correction remains available." } }
    }
}
