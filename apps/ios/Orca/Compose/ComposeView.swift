import SwiftUI

struct ComposeView: View {
    @EnvironmentObject var state: AppState; @Environment(\.dismiss) var dismiss
    var context: ThreadDetail?; var kind = "new"
    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var subject = ""
    @State private var messageBody = ""
    @State private var local: LocalDraft?
    @State private var status = "Saved locally"
    @State private var sending = false
    @State private var saveTask: Task<Void, Never>?
    var body: some View { Form { Section("Recipients") { TextField("To", text: $to).textContentType(.emailAddress).textInputAutocapitalization(.never).keyboardType(.emailAddress); DisclosureGroup("Cc and Bcc") { TextField("Cc", text: $cc); TextField("Bcc", text: $bcc) } }; Section { TextField("Subject", text: $subject); TextEditor(text: $messageBody).frame(minHeight: 240).accessibilityLabel("Message body") }; Section { HStack { Label(status, systemImage: status.contains("failed") ? "exclamationmark.triangle" : "checkmark.circle").font(.caption).foregroundStyle(.secondary); Spacer(); Button("Send") { Task { await send() } }.disabled(sending || recipients(to).isEmpty) } } }
        .navigationTitle(kind == "new" ? "New message" : kind.replacingOccurrences(of: "_", with: " ").capitalized).navigationBarTitleDisplayMode(.inline)
        .task { seed(); _ = await saveLocal() }.onChange(of: snapshot) { saveTask?.cancel(); saveTask = Task { try? await Task.sleep(for: .milliseconds(350)); guard !Task.isCancelled, !sending else { return }; _ = await saveLocal() } }
    }
    var snapshot: String { [to, cc, bcc, subject, messageBody].joined(separator: "\u{1f}") }
    func seed() { guard to.isEmpty, let context, let last = context.messages.last else { return }; subject = kind == "forward" ? "Fwd: \(context.thread.subject)" : (context.thread.subject.lowercased().hasPrefix("re:") ? context.thread.subject : "Re: \(context.thread.subject)"); if kind != "forward" { let mine = context.account.email.lowercased(); let contacts = ([last.from] + (kind == "reply_all" ? last.to + last.cc : [])).filter { $0.email.lowercased() != mine }; to = Array(Set(contacts.map(\.email))).joined(separator: ", ") } }
    func content() -> DraftContent { var result = DraftContent(to: recipients(to), cc: recipients(cc), bcc: recipients(bcc), subject: subject, body: .init(text: messageBody, html: nil)); if let context, let last = context.messages.last { result.context = DraftContext(kind: kind, threadId: context.thread.id, messageId: last.id, providerMessageId: last.providerMessageId, providerThreadId: context.thread.providerThreadId, inReplyTo: last.internetMessageId, references: last.references) }; return result }
    func recipients(_ value: String) -> [Recipient] { value.split(separator: ",").map { Recipient(name: nil, email: $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }.filter { $0.email.contains("@") } }
    func saveLocal() async -> Bool { guard let account = state.selectedAccount else { return false }; var draft = local ?? LocalDraft(ownerScope: state.ownerScope, accountId: account.id); draft.content = content(); do { try await state.draftStore.save(draft); local = draft; status = "Saved locally"; return true } catch { status = "Local save failed — sending is paused"; return false } }
    func send() async {
        guard !sending else { return }; sending = true; saveTask?.cancel(); defer { sending = false }
        guard !state.demoMode, let client = state.client, let account = state.selectedAccount else { status = "Demo mode does not send mail"; return }
        guard await saveLocal(), var current = local else { return }
        do {
            if current.serverID == nil { let server = try await client.createDraft(accountId: account.id, content: current.content); current.serverID = server.id; current.serverRevision = server.revision; try await state.draftStore.save(current) }
            else if let id = current.serverID, let revision = current.serverRevision { let server = try await client.updateDraft(id, accountId: account.id, revision: revision, content: current.content); current.serverRevision = server.revision; try await state.draftStore.save(current) }
        } catch { status = "Could not save to server — local draft is safe"; return }
        do {
            current = try await state.draftStore.prepareSend(current.id); local = current
            guard let id = current.serverID, let revision = current.serverRevision, let key = current.idempotencyKey else { return }
            let result = try await client.sendDraft(id, accountId: account.id, revision: revision, idempotencyKey: key)
            if result.status == "sent" { try await state.draftStore.remove(current.id); status = "Sent"; dismiss() }
            else if result.status == "ambiguous" || result.status == "sending" { try await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — check before retrying" }
            else { status = result.error?.message ?? "Send failed; draft is safe" }
        } catch { try? await state.draftStore.markAmbiguous(current.id); status = "Delivery uncertain — draft and delivery key are safe" }
    }
}
